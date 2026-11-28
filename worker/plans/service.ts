import { auditStatement } from '../admin/audit.js'
import type { DataEnv } from '../db/module-switch.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { apiError } from '../platform/api-error.js'
import { planUserEnabled, readPlanUser } from './entitlements.js'
import { planDefinitions, subscriptionTokens, userPlans, type PlanDefinitionRow, type SubscriptionTokenRow, type UserPlanRow } from './repository.js'
import { hasPlanAggregate, preparePlanToken, revealPlanToken, revokeTargetCredentials } from './tokens.js'

const conflict = () => apiError(409, 'CONFLICT', '资源已更新，请刷新后重试')
const invalidDuration = () => apiError(400, 'INVALID_DURATION', '有效期无效')
const notAssignable = () => apiError(409, 'PLAN_NOT_ASSIGNABLE', '套餐不可分配')
const usableUser = 'EXISTS (SELECT 1 FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL)'
const ownedPlan = 'EXISTS (SELECT 1 FROM plan_definitions p WHERE p.id=user_plans.plan_id AND (p.owner_user_id IS NULL OR p.owner_user_id=user_plans.user_id))'

// D1 batches have no interactive transaction. Abort the whole batch on a
// failed precondition through the settings table's NOT NULL constraint.
function requireInBatch(db: D1Database, condition: string, ...parameters: (string | number | null)[]) {
  return db.prepare(`INSERT INTO system_settings(key, value, updated_at)
    SELECT 'plan_write_conflict', NULL, '' WHERE NOT (${condition})`).bind(...parameters)
}

async function commit(db: D1Database, statements: D1PreparedStatement[], onConflict = conflict) {
  try {
    await db.batch(statements)
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOT NULL constraint failed: system_settings.value')) throw onConflict()
    throw error
  }
}

function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw invalidDuration()
  return value
}

function durationEnd(start: number, seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw invalidDuration()
  return timestamp(start + seconds * 1000)
}

function checkWindow(start: number, end: number | null) {
  timestamp(start)
  if (end !== null && timestamp(end) <= start) throw invalidDuration()
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

export async function definitionDetail(db: D1Database, id: string) {
  const row = await planDefinitions.get(db, id)
  if (!row) throw subscriptionNotFound()
  const groups = await db.prepare('SELECT group_id FROM plan_node_groups WHERE plan_id=? ORDER BY group_id')
    .bind(id).all<{ group_id: string }>()
  return { ...row, nodeGroupIds: groups.results.map(group => group.group_id) }
}

function insertGroups(db: D1Database, id: string, groupIds: string[]) {
  return db.prepare('INSERT INTO plan_node_groups(plan_id, group_id) SELECT ?, value FROM json_each(?)')
    .bind(id, JSON.stringify([...new Set(groupIds)]))
}

export async function listDefinitions(db: D1Database, page: { limit: number; offset: number; search?: string;
  status?: 'enabled' | 'disabled' | 'archived' }) {
  if (!page.search && !page.status) return planDefinitions.list(db, page)
  const search = page.search ?? null
  const status = page.status ?? null
  const rows = await db.prepare(`SELECT * FROM plan_definitions
    WHERE (? IS NULL OR instr(lower(name), lower(?))>0 OR instr(lower(description), lower(?))>0)
    AND (? IS NULL OR ?=CASE WHEN archived_at IS NOT NULL THEN 'archived'
      WHEN enabled=1 THEN 'enabled' ELSE 'disabled' END)
    ORDER BY id LIMIT ? OFFSET ?`).bind(search, search, search, status, status, page.limit, page.offset).all<PlanDefinitionRow>()
  return rows.results
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
  return { ...row, nodeGroupIds: [...new Set(input.nodeGroupIds)].sort() }
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
  input: AssignmentExpiry & { startsAt?: number; remark?: string | null }, actor: string, now = Date.now()) {
  const { DB: db } = env
  if (!planUserEnabled(await readPlanUser(db, userId))) throw subscriptionNotFound()
  const plan = await planDefinitions.get(db, planId)
  if (!plan || (plan.owner_user_id !== null && plan.owner_user_id !== userId)) throw subscriptionNotFound()
  if (!plan.enabled || plan.archived_at !== null) throw notAssignable()
  const start = input.startsAt ?? now
  const expires = input.durationMode === 'custom' && 'expiresAt' in input ? input.expiresAt
    : input.durationMode === 'permanent' ? null
      : input.durationMode === 'custom' ? durationEnd(start, input.durationSeconds)
        : plan.duration_seconds === null ? null : durationEnd(start, plan.duration_seconds)
  checkWindow(start, expires)
  const stamp = new Date(now).toISOString()
  const row: UserPlanRow = { id: crypto.randomUUID(), user_id: userId, plan_id: planId, starts_at: start, expires_at: expires,
    status: 'active', source: 'admin', source_id: null, remark: input.remark ?? null,
    created_at: stamp, updated_at: stamp, version: 1 }
  const token = await preparePlanToken(env, { userId, instanceId: row.id }, stamp)
  await commit(db, [
    requireInBatch(db, `${usableUser} AND EXISTS (SELECT 1 FROM plan_definitions WHERE id=? AND version=?
      AND enabled=1 AND archived_at IS NULL AND (owner_user_id IS NULL OR owner_user_id=?))`, userId, planId, plan.version, userId),
    userPlans.prepareCreate(db, row), subscriptionTokens.prepareCreate(db, token.row),
    auditStatement(db, actor, 'plan.instance.assign', 'user_plan', row.id, { userId, planId }, stamp),
  ], notAssignable)
  return { instance: row, token: token.raw }
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
