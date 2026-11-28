import type { DataEnv } from '../db/module-switch.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { DomainService } from '../domains/domain-service.js'
import { EntitlementNotFound, EntitlementResolver, readPlanUser, type PlanUser } from './entitlements.js'
import { readPlanSummary, type MyPlanStatus, type PlanBucket } from './me.js'
import { listActiveTokens } from './service.js'
import { revealPlanToken } from './tokens.js'

// The plan model owns subscription output once an instance exists. Definition
// rows alone are not enough: an install that backfilled definitions but never
// assigned anything must keep serving the template-derived view.
export async function ownsPlanInstances(db: D1Database, userId: string) {
  try {
    const row = await db.prepare('SELECT 1 AS present FROM user_plans WHERE user_id=? LIMIT 1')
      .bind(userId).first<{ present: number }>()
    return row !== null && row.present !== undefined
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return false
    throw error
  }
}

export type PlanSubscriptionPackage = {
  instanceId: string
  planId: string
  name: string
  status: MyPlanStatus
  bucket: PlanBucket
  startsAt: number
  expiresAt: number | null
  permanent: boolean
  nodeGroupCount: number
  nodeCount: number
}

export type PlanSubscriptionSummary = {
  status: 'active' | 'expired' | 'pending' | 'disabled' | 'none'
  expiresAt: string | null
  lastExpiredAt: string | null
  nextExpiryAt: string | null
  expiringSoonCount: number
  permanent: boolean
  subscriptionUrl: string | null
  nodeCount: number
  hasAvailableNodes: boolean
  packages: PlanSubscriptionPackage[]
}

const iso = (value: number | null) => value === null ? null : new Date(value).toISOString()

async function aggregateNodes(db: D1Database, user: PlanUser) {
  try {
    return await new EntitlementResolver(db).resolve(user, null, Date.now())
  } catch (error) {
    if (error instanceof EntitlementNotFound) throw subscriptionNotFound()
    throw error
  }
}

const packageStatus = `CASE
  WHEN p.id IS NOT NULL AND p.enabled=0 THEN 'plan_disabled'
  WHEN i.expires_at IS NOT NULL AND i.expires_at<=? THEN 'expired'
  WHEN i.status='paused' THEN 'paused'
  WHEN i.starts_at>? THEN 'pending'
  ELSE 'active' END`

const bucketOf = (status: MyPlanStatus): PlanBucket =>
  status === 'paused' || status === 'plan_disabled' ? 'disabled' : status

// Mirrors the template-derived unified summary so the subscription page can
// switch sources without changing its rendering. The aggregate link is created
// on first view exactly like the legacy reader creates its access row; later
// views reuse it, so redeeming never has to reset the link.
export async function readPlanSubscriptionSummary(env: DataEnv, userId: string, now = Date.now()): Promise<PlanSubscriptionSummary> {
  const { DB: db } = env
  const user = await readPlanUser(db, userId)
  if (user === null || user.enabled !== 1 || user.deleted_at !== null) throw subscriptionNotFound()
  const [summary, nodes, rows, origin] = await Promise.all([
    readPlanSummary(db, userId, now),
    aggregateNodes(db, user),
    db.prepare(`SELECT i.id, i.plan_id, i.starts_at, i.expires_at, p.name AS plan_name,
      (SELECT count(*) FROM plan_node_groups pg WHERE pg.plan_id=i.plan_id) AS node_group_count,
      ${packageStatus} AS display_status
      FROM user_plans i JOIN plan_definitions p ON p.id=i.plan_id
      WHERE i.user_id=? AND i.status<>'revoked' AND (p.owner_user_id IS NULL OR p.owner_user_id=i.user_id)
      ORDER BY i.id`).bind(now, now, userId)
      .all<{ id: string; plan_id: string; starts_at: number; expires_at: number | null; plan_name: string;
        node_group_count: number; display_status: MyPlanStatus }>(),
    new DomainService(db).getOrigin('subscription'),
  ])
  let subscriptionUrl: string | null = null
  if (origin !== null) {
    // A page load never mints or rotates a credential. Prefer the plan
    // aggregate token, then the earlier aggregate access token, which the
    // public route still resolves while no plan aggregate token exists.
    const tokens = await listActiveTokens(db, userId)
    const aggregate = tokens.find(token => token.scope === 'aggregate')
    const raw = aggregate ? await revealPlanToken(env, aggregate) : null
    subscriptionUrl = raw !== null ? `${origin}/s/${raw}` : null
  }
  const packages = rows.results.map(row => ({
    instanceId: row.id,
    planId: row.plan_id,
    name: row.plan_name,
    status: row.display_status,
    bucket: bucketOf(row.display_status),
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    permanent: row.expires_at === null,
    nodeGroupCount: row.node_group_count,
    nodeCount: nodes.nodeCounts.get(row.id) ?? 0,
  }))
  return {
    status: summary.accessStatus,
    expiresAt: iso(summary.validUntil),
    lastExpiredAt: iso(summary.lastExpiredAt),
    nextExpiryAt: iso(summary.nextExpiryAt),
    expiringSoonCount: summary.expiringSoonCount,
    permanent: summary.hasPermanentActivePlan,
    subscriptionUrl,
    nodeCount: nodes.nodes.length,
    hasAvailableNodes: nodes.nodes.length > 0,
    packages,
  }
}
