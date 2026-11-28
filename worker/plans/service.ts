import { auditStatement } from '../admin/audit.js'
import { readCatalogFromD1 } from '../catalog/d1-repository.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import type { DataEnv } from '../db/module-switch.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { apiError } from '../platform/api-error.js'
import { planUserEnabled, readPlanUser } from './entitlements.js'
import { planDefinitions, subscriptionTokens, userPlans, type PlanDefinitionRow, type SubscriptionTokenRow, type UserPlanRow } from './repository.js'
import { hasPlanAggregate, preparePlanToken, revealPlanToken, revokeTargetCredentials } from './tokens.js'

export const conflict = () => apiError(409, 'CONFLICT', '资源已更新，请刷新后重试')
export const invalidDuration = () => apiError(400, 'INVALID_DURATION', '有效期无效')
export const notAssignable = () => apiError(409, 'PLAN_NOT_ASSIGNABLE', '套餐不可分配')
const usableUser = 'EXISTS (SELECT 1 FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL)'
const ownedPlan = 'EXISTS (SELECT 1 FROM plan_definitions p WHERE p.id=user_plans.plan_id AND (p.owner_user_id IS NULL OR p.owner_user_id=user_plans.user_id))'

// D1 batches have no interactive transaction. Abort the whole batch on a
// failed precondition through the settings table's NOT NULL constraint.
export function requireInBatch(db: D1Database, condition: string, ...parameters: (string | number | null)[]) {
  return db.prepare(`INSERT INTO system_settings(key, value, updated_at)
    SELECT 'plan_write_conflict', NULL, '' WHERE NOT (${condition})`).bind(...parameters)
}

export function planBatchAborted(error: unknown) {
  return error instanceof Error && error.message.includes('NOT NULL constraint failed: system_settings.value')
}

export async function commit(db: D1Database, statements: D1PreparedStatement[], onConflict = conflict) {
  try {
    await db.batch(statements)
  } catch (error) {
    if (planBatchAborted(error)) throw onConflict()
    throw error
  }
}

function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw invalidDuration()
  return value
}

export function durationEnd(start: number, seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw invalidDuration()
  return timestamp(start + seconds * 1000)
}

export function checkWindow(start: number, end: number | null) {
  timestamp(start)
  if (end !== null && timestamp(end) <= start) throw invalidDuration()
}

// Admin assignment and redemption share this insert. A redeem never renews an existing instance.
export async function prepareInstanceGrant(env: DataEnv, input: {
  userId: string
  planId: string
  startsAt: number
  expiresAt: number | null
  source: UserPlanRow['source']
  sourceId: string | null
  remark: string | null
  actor: string
  action: string
  detail: Record<string, unknown>
  stamp: string
}) {
  checkWindow(input.startsAt, input.expiresAt)
  const row: UserPlanRow = {
    id: crypto.randomUUID(), user_id: input.userId, plan_id: input.planId, starts_at: input.startsAt,
    expires_at: input.expiresAt, status: 'active', source: input.source, source_id: input.sourceId,
    remark: input.remark, created_at: input.stamp, updated_at: input.stamp, version: 1,
  }
  const token = await preparePlanToken(env, { userId: input.userId, instanceId: row.id }, input.stamp)
  return {
    row, raw: token.raw, tokenId: token.row.id,
    statements: [
      userPlans.prepareCreate(env.DB, row),
      subscriptionTokens.prepareCreate(env.DB, token.row),
      auditStatement(env.DB, input.actor, input.action, 'user_plan', row.id, input.detail, input.stamp),
    ],
  }
}

type DefinitionInput = {
  name: string
  description: string
  durationSeconds: number | null
  enabled: boolean
  remark: string | null
  nodeGroupIds: string[]
}

function encodeRemark(input: string | null, previous?: string | null) {
  let metadata: Record<string, unknown> = {}
  if (previous) {
    try {
      const parsed: unknown = JSON.parse(previous)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>
    } catch { /* Earlier notes may be plain text. */ }
  }
  return JSON.stringify({ ...metadata, note: input })
}

export function planNote(remark: string | null) {
  if (!remark) return ''
  try {
    const parsed: unknown = JSON.parse(remark)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { note?: unknown }).note === 'string') {
      return (parsed as { note: string }).note
    }
  } catch { /* Plain-text notes stay as written. */ }
  return remark
}

export function definitionStatus(row: { enabled: number; archived_at: string | null }) {
  if (row.archived_at !== null) return 'archived' as const
  return row.enabled ? 'enabled' as const : 'disabled' as const
}

export type PlanGroupView = { id: string; name: string; enabled: boolean; nodeCount: number; empty: boolean }
export type PlanUsage = { userCount: number; instanceCount: number }
export type PlanStats = PlanUsage & { total: number; active: number; paused: number; revoked: number; expired: number; pending: number }

type GroupLink = { plan_id: string; group_id: string; name: string | null; enabled: number | null }

async function readGroupLinks(db: D1Database, planIds: string[]) {
  if (!planIds.length) return [] as GroupLink[]
  const rows = await db.prepare(`SELECT g.plan_id, g.group_id, groups.name, groups.enabled
    FROM plan_node_groups g LEFT JOIN groups ON groups.id=g.group_id
    WHERE g.plan_id IN (SELECT value FROM json_each(?))
    ORDER BY g.plan_id, g.group_id`).bind(JSON.stringify(planIds)).all<GroupLink>()
  return rows.results
}

function nodesForGroups(snapshot: Awaited<ReturnType<typeof readCatalogFromD1>> | null, groupIds: string[]) {
  const counts = new Map<string, number>()
  const union = new Set<string>()
  if (!snapshot) {
    for (const id of groupIds) counts.set(id, 0)
    return { counts, nodeCount: 0 }
  }
  for (const id of groupIds) {
    if (counts.has(id) || !snapshot.groups.some(group => group.id === id)) {
      if (!counts.has(id)) counts.set(id, 0)
      continue
    }
    const nodes = resolveGroupNodes(snapshot, id)
    counts.set(id, nodes.length)
    for (const node of nodes) union.add(node.id)
  }
  return { counts, nodeCount: union.size }
}

async function usageByPlan(db: D1Database, planIds: string[], now = Date.now()) {
  const usage = new Map<string, PlanStats>()
  if (!planIds.length) return usage
  const rows = await db.prepare(`SELECT plan_id,
    count(*) AS total,
    count(DISTINCT CASE WHEN status<>'revoked' THEN user_id END) AS users,
    sum(CASE WHEN status<>'revoked' THEN 1 ELSE 0 END) AS instances,
    sum(CASE WHEN status='revoked' THEN 1 ELSE 0 END) AS revoked,
    sum(CASE WHEN status<>'revoked' AND expires_at IS NOT NULL AND expires_at<=? THEN 1 ELSE 0 END) AS expired,
    sum(CASE WHEN status='paused' AND (expires_at IS NULL OR expires_at>?) THEN 1 ELSE 0 END) AS paused,
    sum(CASE WHEN status='active' AND starts_at>? AND (expires_at IS NULL OR expires_at>?) THEN 1 ELSE 0 END) AS pending,
    sum(CASE WHEN status='active' AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) THEN 1 ELSE 0 END) AS active
    FROM user_plans WHERE plan_id IN (SELECT value FROM json_each(?)) GROUP BY plan_id`)
    .bind(now, now, now, now, now, now, JSON.stringify(planIds))
    .all<{ plan_id: string; total: number; users: number; instances: number; revoked: number; expired: number; paused: number; pending: number; active: number }>()
  for (const row of rows.results) {
    const count = (value: number | null) => Number(value ?? 0)
    usage.set(row.plan_id, {
      userCount: count(row.users), instanceCount: count(row.instances), total: count(row.total),
      active: count(row.active), paused: count(row.paused), revoked: count(row.revoked),
      expired: count(row.expired), pending: count(row.pending),
    })
  }
  return usage
}

const emptyStats = (): PlanStats => ({ userCount: 0, instanceCount: 0, total: 0, active: 0, paused: 0, revoked: 0, expired: 0, pending: 0 })

export async function describeDefinitions(db: D1Database, rows: PlanDefinitionRow[], now = Date.now()) {
  const links = await readGroupLinks(db, rows.map(row => row.id))
  let snapshot: Awaited<ReturnType<typeof readCatalogFromD1>> | null = null
  if (links.length) {
    try { snapshot = await readCatalogFromD1(db) } catch { snapshot = null }
  }
  const usage = await usageByPlan(db, rows.map(row => row.id), now)
  return rows.map(row => {
    const groups = links.filter(link => link.plan_id === row.id)
    const resolved = nodesForGroups(snapshot, groups.map(group => group.group_id))
    const nodeGroups: PlanGroupView[] = groups.map(group => ({
      id: group.group_id,
      name: group.name ?? group.group_id,
      enabled: group.enabled === null ? false : group.enabled === 1,
      nodeCount: resolved.counts.get(group.group_id) ?? 0,
      empty: (resolved.counts.get(group.group_id) ?? 0) === 0,
    }))
    const stats = usage.get(row.id) ?? emptyStats()
    return {
      ...row,
      note: planNote(row.remark),
      status: definitionStatus(row),
      nodeGroupIds: nodeGroups.map(group => group.id),
      nodeGroups,
      nodeCount: resolved.nodeCount,
      userCount: stats.userCount,
      instanceCount: stats.instanceCount,
      stats,
    }
  })
}

export async function definitionDetail(db: D1Database, id: string) {
  const row = await planDefinitions.get(db, id)
  if (!row) throw subscriptionNotFound()
  const [plan] = await describeDefinitions(db, [row])
  return plan
}

export async function previewDefinitionGroups(db: D1Database, nodeGroupIds: string[]) {
  await validateGroups(db, nodeGroupIds)
  const ids = [...new Set(nodeGroupIds)]
  let snapshot: Awaited<ReturnType<typeof readCatalogFromD1>> | null = null
  try { snapshot = await readCatalogFromD1(db) } catch { snapshot = null }
  const names = ids.length
    ? await db.prepare(`SELECT id, name, enabled FROM groups WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids)).all<{ id: string; name: string; enabled: number }>()
    : { results: [] as { id: string; name: string; enabled: number }[] }
  const named = new Map(names.results.map(group => [group.id, group]))
  const resolved = nodesForGroups(snapshot, ids)
  const nodeGroups = ids.map(id => {
    const group = named.get(id)
    const nodeCount = resolved.counts.get(id) ?? 0
    return { id, name: group?.name ?? id, enabled: group ? group.enabled === 1 : false, nodeCount, empty: nodeCount === 0 }
  })
  return { nodeCount: resolved.nodeCount, nodeGroups, emptyGroupIds: nodeGroups.filter(group => group.empty).map(group => group.id) }
}

export async function nodeCountsForPlans(db: D1Database, planIds: string[]) {
  const distinct = [...new Set(planIds)]
  if (!distinct.length) return new Map<string, number>()
  const rows = await db.prepare('SELECT * FROM plan_definitions WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(distinct)).all<PlanDefinitionRow>()
  const described = await describeDefinitions(db, rows.results)
  return new Map(described.map(plan => [plan.id, plan.nodeCount]))
}

export async function plansUsingGroup(db: D1Database, groupId: string) {
  try {
    const rows = await db.prepare(`SELECT p.id, p.name, p.enabled, p.archived_at
      FROM plan_definitions p JOIN plan_node_groups g ON g.plan_id=p.id
      WHERE g.group_id=? ORDER BY p.name, p.id`).bind(groupId)
      .all<{ id: string; name: string; enabled: number; archived_at: string | null }>()
    return rows.results.map(row => ({ id: row.id, name: row.name, status: definitionStatus(row) }))
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return []
    throw error
  }
}

function insertGroups(db: D1Database, id: string, groupIds: string[]) {
  return db.prepare('INSERT INTO plan_node_groups(plan_id, group_id) SELECT ?, value FROM json_each(?)')
    .bind(id, JSON.stringify([...new Set(groupIds)]))
}

export async function listDefinitions(db: D1Database, page: { limit: number; offset: number; search?: string;
  status?: 'enabled' | 'disabled' | 'archived' }) {
  const search = page.search ? page.search : null
  const status = page.status ?? null
  const rows = await db.prepare(`SELECT * FROM plan_definitions
    WHERE (? IS NULL OR instr(lower(name), lower(?))>0 OR instr(lower(description), lower(?))>0
      OR instr(lower(coalesce(remark, '')), lower(?))>0)
    AND (? IS NULL OR ?=CASE WHEN archived_at IS NOT NULL THEN 'archived'
      WHEN enabled=1 THEN 'enabled' ELSE 'disabled' END)
    ORDER BY id LIMIT ? OFFSET ?`).bind(search, search, search, search, status, status, page.limit, page.offset).all<PlanDefinitionRow>()
  return describeDefinitions(db, rows.results)
}

async function validateGroups(db: D1Database, ids: string[]) {
  const distinct = [...new Set(ids)]
  const count = await db.prepare('SELECT count(*) AS count FROM groups WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(distinct)).first<number>('count')
  if (count !== distinct.length) throw apiError(400, 'GROUP_NOT_FOUND', '节点组不存在')
}

export async function createDefinition(db: D1Database, input: DefinitionInput, actor: string) {
  await validateGroups(db, input.nodeGroupIds)
  const now = new Date().toISOString()
  const row: PlanDefinitionRow = {
    id: crypto.randomUUID(), name: input.name, description: input.description, remark: encodeRemark(input.remark),
    duration_seconds: input.durationSeconds, enabled: input.enabled ? 1 : 0, archived_at: null,
    owner_user_id: null, source_type: null, source_id: null, version: 1, created_at: now, updated_at: now,
  }
  await commit(db, [planDefinitions.prepareCreate(db, row), insertGroups(db, row.id, input.nodeGroupIds),
    auditStatement(db, actor, 'plan.definition.create', 'plan_definition', row.id)])
  return definitionDetail(db, row.id)
}

export async function updateDefinition(db: D1Database, id: string, version: number, input: Partial<DefinitionInput>,
  actor: string, archive = false) {
  const row = await planDefinitions.get(db, id)
  if (!row) throw subscriptionNotFound()
  if (row.version !== version) throw conflict()
  const groups = input.nodeGroupIds
  if (groups) await validateGroups(db, groups)
  const now = new Date().toISOString()
  await commit(db, [
    requireInBatch(db, 'EXISTS (SELECT 1 FROM plan_definitions WHERE id=? AND version=?)', id, version),
    db.prepare(`UPDATE plan_definitions SET name=?, description=?, remark=?, duration_seconds=?, enabled=?,
      archived_at=?, version=version+1, updated_at=? WHERE id=?`).bind(
      input.name ?? row.name, input.description ?? row.description,
      input.remark === undefined ? row.remark : encodeRemark(input.remark, row.remark),
      input.durationSeconds === undefined ? row.duration_seconds : input.durationSeconds,
      input.enabled === undefined ? row.enabled : Number(input.enabled), row.archived_at ?? (archive ? now : null), now, id,
    ),
    ...(groups ? [db.prepare('DELETE FROM plan_node_groups WHERE plan_id=?').bind(id), insertGroups(db, id, groups)] : []),
    auditStatement(db, actor, archive ? 'plan.definition.archive' : 'plan.definition.update', 'plan_definition', id),
  ])
  return definitionDetail(db, id)
}

export async function duplicateDefinition(db: D1Database, id: string, actor: string) {
  const source = await planDefinitions.get(db, id)
  if (!source) throw subscriptionNotFound()
  const now = new Date().toISOString()
  const row = { ...source, id: crypto.randomUUID(), archived_at: null, source_type: null, source_id: null,
    version: 1, created_at: now, updated_at: now }
  await commit(db, [
    requireInBatch(db, 'EXISTS (SELECT 1 FROM plan_definitions WHERE id=? AND version=?)', id, source.version),
    planDefinitions.prepareCreate(db, row),
    db.prepare('INSERT INTO plan_node_groups SELECT ?, group_id FROM plan_node_groups WHERE plan_id=?').bind(row.id, id),
    auditStatement(db, actor, 'plan.definition.duplicate', 'plan_definition', row.id, { sourceId: id }),
  ])
  return definitionDetail(db, row.id)
}

export function readOwnedInstance(db: D1Database, id: string, userId?: string) {
  return db.prepare(`SELECT user_plans.* FROM user_plans WHERE id=? AND (? IS NULL OR user_id=?)
    AND ${ownedPlan}`).bind(id, userId ?? null, userId ?? null).first<UserPlanRow>()
}

type AssignmentExpiry = { durationMode: 'inherit' | 'permanent' } |
  { durationMode: 'custom'; durationSeconds: number } | { durationMode: 'custom'; expiresAt: number }

export async function assignPlan(env: DataEnv, userId: string, planId: string,
  input: AssignmentExpiry & { startsAt?: number; remark?: string | null; idempotencyKey?: string }, actor: string, now = Date.now()) {
  const { DB: db } = env
  if (!planUserEnabled(await readPlanUser(db, userId))) throw subscriptionNotFound()
  if (input.idempotencyKey) {
    const existing = await db.prepare(`SELECT * FROM user_plans WHERE user_id=? AND source='admin' AND source_id=?`)
      .bind(userId, input.idempotencyKey).first<UserPlanRow>()
    if (existing) return { instance: existing, token: null, replayed: true as const }
  }
  const plan = await planDefinitions.get(db, planId)
  if (!plan || (plan.owner_user_id !== null && plan.owner_user_id !== userId)) throw subscriptionNotFound()
  if (!plan.enabled || plan.archived_at !== null) throw notAssignable()
  const start = input.startsAt ?? now
  const expires = input.durationMode === 'custom' && 'expiresAt' in input ? input.expiresAt
    : input.durationMode === 'permanent' ? null
      : input.durationMode === 'custom' ? durationEnd(start, input.durationSeconds)
        : plan.duration_seconds === null ? null : durationEnd(start, plan.duration_seconds)
  const stamp = new Date(now).toISOString()
  const grant = await prepareInstanceGrant(env, {
    userId, planId, startsAt: start, expiresAt: expires, source: 'admin', sourceId: input.idempotencyKey ?? null,
    remark: input.remark ?? null, actor, action: 'plan.instance.assign', detail: { userId, planId }, stamp,
  })
  await commit(db, [
    requireInBatch(db, `${usableUser} AND EXISTS (SELECT 1 FROM plan_definitions WHERE id=? AND version=?
      AND enabled=1 AND archived_at IS NULL AND (owner_user_id IS NULL OR owner_user_id=?))`, userId, planId, plan.version, userId),
    ...grant.statements,
  ], notAssignable)
  return { instance: grant.row, token: grant.raw, replayed: false as const }
}

type Mutation = { action: 'patch'; startsAt?: number; expiresAt?: number | null; remark?: string | null } |
  { action: 'pause' | 'resume' | 'revoke' } | { action: 'renew'; durationSeconds: number }

export async function mutateInstance(db: D1Database, id: string, mutation: Mutation, actor: string,
  version?: number, now = Date.now()) {
  const row = await readOwnedInstance(db, id)
  if (!row) throw subscriptionNotFound()
  if (version !== undefined && row.version !== version) throw conflict()
  if (row.status === 'revoked') {
    if (mutation.action === 'revoke') return row
    throw apiError(409, 'PLAN_INSTANCE_REVOKED', '套餐实例已撤销')
  }
  const changed = { ...row, updated_at: new Date(now).toISOString(), version: row.version + 1 }
  switch (mutation.action) {
    case 'patch':
      changed.starts_at = mutation.startsAt ?? row.starts_at
      if (mutation.expiresAt !== undefined) changed.expires_at = mutation.expiresAt
      if (mutation.remark !== undefined) changed.remark = mutation.remark
      break
    case 'renew':
      if (row.expires_at === null) throw invalidDuration()
      changed.expires_at = durationEnd(Math.max(now, row.expires_at), mutation.durationSeconds)
      break
    case 'pause': changed.status = 'paused'; break
    case 'resume': changed.status = 'active'; break
    case 'revoke': changed.status = 'revoked'; break
  }
  checkWindow(changed.starts_at, changed.expires_at)
  await commit(db, [
    requireInBatch(db, `EXISTS (SELECT 1 FROM user_plans WHERE id=? AND version=? AND ${ownedPlan})`, id, row.version),
    db.prepare(`UPDATE user_plans SET starts_at=?,expires_at=?,status=?,remark=?,version=?,updated_at=? WHERE id=?`)
      .bind(changed.starts_at, changed.expires_at, changed.status, changed.remark, changed.version, changed.updated_at, id),
    ...(mutation.action === 'revoke' ? revokeTargetCredentials(db, 'package', id, changed.updated_at) : []),
    auditStatement(db, actor, `plan.instance.${mutation.action}`, 'user_plan', id),
  ])
  return changed
}

export async function listActiveTokens(db: D1Database, userId: string) {
  const result = await db.prepare(`SELECT t.* FROM subscription_tokens t WHERE t.user_id=? AND t.revoked_at IS NULL
    AND (t.scope='aggregate' OR EXISTS (
      SELECT 1 FROM user_plans i JOIN plan_definitions p ON p.id=i.plan_id
      WHERE i.id=t.user_plan_id AND i.user_id=t.user_id AND i.status<>'revoked'
      AND (p.owner_user_id IS NULL OR p.owner_user_id=i.user_id)
    )) ORDER BY t.scope, t.user_plan_id`).bind(userId).all<SubscriptionTokenRow>()
  return result.results
}

export async function changeToken(env: DataEnv, userId: string, instanceId: string | null, actor: string,
  mode: 'copy' | 'reset', legacyRevision?: number) {
  const { DB: db } = env
  if (!planUserEnabled(await readPlanUser(db, userId))) throw subscriptionNotFound()
  const scope = instanceId === null ? 'aggregate' : 'package'
  const target = instanceId ?? userId
  const column = instanceId === null ? 'user_id' : 'user_plan_id'
  if (instanceId !== null) {
    const row = await readOwnedInstance(db, instanceId, userId)
    if (!row || row.status === 'revoked') throw subscriptionNotFound()
  }
  const active = `FROM subscription_tokens WHERE scope=? AND ${column}=? AND revoked_at IS NULL`
  const previous = await db.prepare(`SELECT * ${active}`).bind(scope, target).first<SubscriptionTokenRow>()
  if (mode === 'copy') {
    if (previous) {
      const raw = await revealPlanToken(env, previous)
      if (raw) return { raw }
    }
    if (previous || (scope === 'aggregate' && await hasPlanAggregate(db, userId))) {
      throw apiError(409, 'TOKEN_RESET_REQUIRED', '请重置订阅链接')
    }
  }
  const stamp = new Date().toISOString()
  const { raw, row } = await preparePlanToken(env, { userId, instanceId }, stamp)
  await commit(db, [
    requireInBatch(db, `${usableUser} AND (SELECT id ${active}) IS ?`, userId, scope, target, previous?.id ?? null),
    ...(instanceId === null ? [] : [requireInBatch(db,
      `EXISTS (SELECT 1 FROM user_plans WHERE id=? AND user_id=? AND status<>'revoked' AND ${ownedPlan})`, instanceId, userId)]),
    ...(legacyRevision === undefined ? [] : [requireInBatch(db,
      'EXISTS (SELECT 1 FROM user_subscription_access WHERE user_id=? AND revision=? AND enabled=1)', userId, legacyRevision)]),
    ...(mode === 'reset' ? revokeTargetCredentials(db, scope, target, stamp) : []),
    subscriptionTokens.prepareCreate(db, row),
    ...(scope === 'aggregate' ? [db.prepare(`INSERT INTO user_subscription_access
      (user_id,token_hash,token_prefix,encrypted_token,enabled,created_at,updated_at)
      VALUES (?,?,'',?,1,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,token_prefix='',
        encrypted_token=excluded.encrypted_token,enabled=1,revision=revision+1,updated_at=excluded.updated_at`)
      .bind(userId, row.token_digest, row.token_ciphertext, stamp, stamp)] : []),
    auditStatement(db, actor, `plan.token.${mode === 'copy' ? 'create' : 'reset'}`,
      scope === 'aggregate' ? 'user' : 'user_plan', target),
  ])
  return { raw }
}
