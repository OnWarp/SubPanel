import { resolveAvatar } from '../accounts/avatar.js'
import { findAccountUserById } from '../accounts/repository.js'
import type { DataEnv } from '../db/module-switch.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { apiError } from '../platform/api-error.js'
import { planUserEnabled, readPlanUser, type InstanceStatus } from './entitlements.js'

export const expiringSoonWindowMs = 7 * 86_400_000

// Display status mirrors EntitlementResolver exactly: revocation beats a
// stopped plan, which beats the time window, which beats an explicit pause.
// A missing definition row is only possible outside the foreign keys
// (imported data); it falls back to the time window instead of "stopped".
const statusExpression = `CASE
  WHEN i.status='revoked' THEN 'revoked'
  WHEN p.id IS NOT NULL AND p.enabled=0 THEN 'plan_disabled'
  WHEN i.expires_at IS NOT NULL AND i.expires_at<=? THEN 'expired'
  WHEN i.status='paused' THEN 'paused'
  WHEN i.starts_at>? THEN 'pending'
  ELSE 'active' END`

const classified = `WITH rows AS (
  SELECT i.id, i.plan_id, i.starts_at, i.expires_at, i.status AS stored_status, i.source, i.remark,
    i.created_at, i.updated_at,
    p.id AS definition_id, p.name AS plan_name, p.description AS plan_description, p.enabled AS plan_enabled,
    (SELECT count(*) FROM plan_node_groups pg WHERE pg.plan_id=i.plan_id) AS node_group_count,
    ${statusExpression} AS display_status
  FROM user_plans i LEFT JOIN plan_definitions p ON p.id=i.plan_id
  WHERE i.user_id=? AND i.status<>'revoked'
    AND (p.id IS NULL OR p.owner_user_id IS NULL OR p.owner_user_id=i.user_id)
), classified AS (
  SELECT *, CASE WHEN display_status IN ('paused','plan_disabled') THEN 'disabled'
    ELSE display_status END AS bucket
  FROM rows
)`

export type PlanBucket = 'active' | 'pending' | 'expired' | 'disabled'
export type MyPlanStatus = Exclude<InstanceStatus, 'revoked'>
/** Server-side filters are bucket-level; specific statuses still ride in each item. */
export type PlanFilter = 'all' | PlanBucket
export const planFilters = ['all', 'active', 'pending', 'expired', 'disabled'] as const

type ClassifiedRow = {
  id: string
  plan_id: string
  starts_at: number
  expires_at: number | null
  stored_status: 'active' | 'paused' | 'revoked'
  source: 'admin' | 'redeem' | 'manual' | 'migration' | 'trial'
  remark: string | null
  created_at: string
  updated_at: string
  definition_id: string | null
  plan_name: string | null
  plan_description: string | null
  plan_enabled: number | null
  node_group_count: number
  display_status: MyPlanStatus
  bucket: PlanBucket
}

type AggregateRow = {
  total: number | null
  active: number | null
  expired: number | null
  pending: number | null
  disabled: number | null
  valid_until: number | null
  next_expiry: number | null
  last_expired: number | null
  has_permanent: number | null
  expiring_soon: number | null
}

export type PlanSummary = {
  total: number
  active: number
  expired: number
  pending: number
  disabled: number
  accessStatus: 'active' | 'expired' | 'pending' | 'disabled' | 'none'
  validUntil: number | null
  hasPermanentActivePlan: boolean
  nextExpiryAt: number | null
  expiringSoonCount: number
  lastExpiredAt: number | null
}

export const removedPlanName = '已移除套餐'

export function planName(row: Pick<ClassifiedRow, 'definition_id' | 'plan_name'>) {
  if (row.definition_id === null) return removedPlanName
  return row.plan_name ?? removedPlanName
}

function count(value: number | null | undefined) {
  return Number(value ?? 0)
}

export function accessStatusFor(summary: Pick<PlanSummary, 'active' | 'pending' | 'expired' | 'disabled'>): PlanSummary['accessStatus'] {
  if (summary.active > 0) return 'active'
  // A not-yet-started plan is more actionable than an expired one; the list
  // still shows both, and the overview sentence names the access state.
  if (summary.pending > 0) return 'pending'
  if (summary.expired > 0) return 'expired'
  if (summary.disabled > 0) return 'disabled'
  return 'none'
}

export async function readPlanSummary(db: D1Database, userId: string, now = Date.now()): Promise<PlanSummary> {
  const row = await db.prepare(`${classified}
    SELECT count(*) AS total,
      sum(CASE WHEN bucket='active' THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN bucket='expired' THEN 1 ELSE 0 END) AS expired,
      sum(CASE WHEN bucket='pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN bucket='disabled' THEN 1 ELSE 0 END) AS disabled,
      max(CASE WHEN bucket='active' AND expires_at IS NOT NULL THEN expires_at END) AS valid_until,
      min(CASE WHEN bucket='active' AND expires_at IS NOT NULL THEN expires_at END) AS next_expiry,
      max(CASE WHEN bucket='expired' THEN expires_at END) AS last_expired,
      max(CASE WHEN bucket='active' AND expires_at IS NULL THEN 1 ELSE 0 END) AS has_permanent,
      sum(CASE WHEN bucket='active' AND expires_at IS NOT NULL AND expires_at - ? <= ? THEN 1 ELSE 0 END) AS expiring_soon
    FROM classified`).bind(now, now, userId, now, expiringSoonWindowMs).first<AggregateRow>()
  const total = count(row?.total)
  const counts = {
    total,
    active: count(row?.active),
    expired: count(row?.expired),
    pending: count(row?.pending),
    disabled: count(row?.disabled),
  }
  const hasPermanentActivePlan = count(row?.has_permanent) > 0
  return {
    ...counts,
    accessStatus: total === 0 ? 'none' : accessStatusFor(counts),
    // A permanent grant makes the overall access permanent, so a finite date
    // would read as the end of access. The finite expiries still surface as
    // nextExpiryAt for the expiring-soon hint.
    validUntil: counts.active === 0 || hasPermanentActivePlan ? null : row?.valid_until ?? null,
    hasPermanentActivePlan,
    nextExpiryAt: counts.active === 0 ? null : row?.next_expiry ?? null,
    expiringSoonCount: count(row?.expiring_soon),
    lastExpiredAt: row?.last_expired ?? null,
  }
}

// Cursor and offset are both accepted. A cursor records the offset, page size
// and filter it was issued for, so a cursor replayed against a different list
// is rejected instead of silently skipping rows.
export function encodeCursor(offset: number, limit: number, status: string) {
  return btoa(JSON.stringify({ o: offset, l: limit, s: status })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

type Cursor = { offset: number; limit: number; status: string }

export function decodeCursor(value: string): Cursor | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(padded)) as { o?: unknown; l?: unknown; s?: unknown } | null
    const offset = parsed?.o
    const limit = parsed?.l
    const status = parsed?.s
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return null
    if (typeof status !== 'string') return null
    return { offset, limit, status }
  } catch {
    return null
  }
}

export type PlanListPage = {
  status: PlanFilter
  limit: number
  offset: number
  search?: string
}

export type PlanListItem = {
  instanceId: string
  id: string
  planId: string
  name: string
  status: MyPlanStatus
  bucket: PlanBucket
  startsAt: number
  expiresAt: number | null
  createdAt: string
  nodeGroupCount: number
  source: ClassifiedRow['source']
}

export async function listMyPlans(db: D1Database, userId: string, page: PlanListPage, now = Date.now()) {
  const search = page.search ? page.search : null
  const filterValue = page.status
  const result = await db.prepare(`${classified}
    SELECT * FROM classified
    WHERE (?='all' OR bucket=?)
      AND (? IS NULL OR instr(lower(coalesce(plan_name, '')), lower(?))>0
        OR instr(lower(coalesce(remark, '')), lower(?))>0)
    ORDER BY
      CASE bucket WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'expired' THEN 2 ELSE 3 END,
      CASE WHEN bucket='active' THEN (expires_at IS NULL) END,
      CASE WHEN bucket='active' THEN expires_at END,
      CASE WHEN bucket='pending' THEN starts_at END,
      CASE WHEN bucket='expired' THEN -expires_at END,
      CASE WHEN bucket='disabled' THEN updated_at END DESC,
      id
    LIMIT ? OFFSET ?`)
    .bind(now, now, userId, filterValue, filterValue, search, search, search,
      page.limit + 1, page.offset)
    .all<ClassifiedRow>()
  const rows = result.results.slice(0, page.limit)
  const nextCursor = result.results.length > page.limit
    ? encodeCursor(page.offset + page.limit, page.limit, page.status)
    : null
  return { rows, nextCursor }
}

export function planListItem(row: ClassifiedRow): PlanListItem {
  return {
    instanceId: row.id,
    id: row.id,
    planId: row.plan_id,
    name: planName(row),
    status: row.display_status,
    bucket: row.bucket,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    nodeGroupCount: row.node_group_count,
    source: row.source,
  }
}

// One grouped query for the subscription page, which lists group counts per
// instance rather than resolving each plan's groups separately.
export async function planNodeGroupCounts(db: D1Database, userId: string) {
  const result = await db.prepare(`SELECT i.id, count(pg.group_id) AS count FROM user_plans i
    LEFT JOIN plan_node_groups pg ON pg.plan_id=i.plan_id
    WHERE i.user_id=? AND i.status<>'revoked' GROUP BY i.id`).bind(userId)
    .all<{ id: string; count: number }>()
  return new Map(result.results.map(row => [row.id, Number(row.count)]))
}

type GroupRow = { id: string; name: string | null; enabled: number | null }

export type PlanGroupRef = { id: string; name: string; enabled: boolean }

export async function readMyPlanDetail(db: D1Database, userId: string, instanceId: string, now = Date.now()) {
  const row = await db.prepare(`${classified}
    SELECT * FROM classified WHERE id=?`).bind(now, now, userId, instanceId).first<ClassifiedRow>()
  if (!row) throw subscriptionNotFound()
  const groups = await db.prepare(`SELECT g.id, g.name, g.enabled FROM plan_node_groups pg
    LEFT JOIN groups g ON g.id=pg.group_id WHERE pg.plan_id=? ORDER BY pg.group_id`)
    .bind(row.plan_id).all<GroupRow>()
  const nodeGroups: PlanGroupRef[] = groups.results.map(group => ({
    id: group.id, name: group.name ?? group.id, enabled: group.enabled === 1,
  }))
  return {
    instanceId: row.id,
    planId: row.plan_id,
    name: planName(row),
    description: row.definition_id === null ? '' : row.plan_description ?? '',
    status: row.display_status,
    bucket: row.bucket,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remainingSeconds: row.expires_at === null ? null : Math.max(0, Math.floor((row.expires_at - now) / 1000)),
    source: row.source,
    nodeGroupCount: row.node_group_count,
    nodeGroups,
  }
}

export type PlanOverview = {
  user: { id: string; username: string; email: string | null; avatarUrl: string | null }
  plans: PlanSummary
  serverTime: string
}

export async function readOverview(env: DataEnv, userId: string, now = Date.now()): Promise<PlanOverview> {
  const user = await readPlanUser(env.DB, userId)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  const [account, summary] = await Promise.all([
    findAccountUserById(env, userId),
    readPlanSummary(env.DB, userId, now),
  ])
  return {
    user: {
      id: userId,
      username: account?.username ?? '',
      email: account?.email ?? null,
      avatarUrl: account ? resolveAvatar(account).url : null,
    },
    plans: summary,
    serverTime: new Date(now).toISOString(),
  }
}

// Cursor and offset are both accepted while old callers migrate. A cursor is
// only valid for the page size it was issued for and is rejected when the
// filter changes, so a stale cursor cannot silently skip rows.
export function readPlanPage(query: { status: PlanFilter; limit: number; offset?: number; cursor?: string }) {
  if (query.cursor === undefined) return { offset: query.offset ?? 0 }
  const cursor = decodeCursor(query.cursor)
  if (cursor === null || cursor.limit !== query.limit || cursor.status !== query.status) {
    throw apiError(400, 'INVALID_INPUT', '分页游标无效')
  }
  return { offset: cursor.offset }
}
