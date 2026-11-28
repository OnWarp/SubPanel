import { emptyCatalogSnapshot } from '../catalog/schema.js'
import { readCatalogFromD1 } from '../catalog/d1-repository.js'
import { selectedNodes } from '../delivery/compiler.js'
import { subscriptionWindowStatus } from '../delivery/expiry.js'
import type { UserPlanRow } from './repository.js'

export type PlanUser = { id: string; enabled: number; deleted_at: string | null }
export type PlanInstance = UserPlanRow & { name: string; plan_enabled: number }

export function readPlanUser(db: D1Database, id: string) {
  return db.prepare('SELECT id, enabled, deleted_at FROM users WHERE id=?').bind(id).first<PlanUser>()
}

export function planUserEnabled(user: PlanUser | null): user is PlanUser {
  return user !== null && user.enabled === 1 && user.deleted_at === null
}

export function instanceDisplayStatus(instance: PlanInstance, now: number) {
  if (instance.status === 'revoked') return 'revoked'
  if (!instance.plan_enabled) return 'plan_disabled'
  const window = subscriptionWindowStatus({ startsAt: instance.starts_at, expiresAt: instance.expires_at,
    createdAt: instance.created_at }, now)
  if (window === 'expired') return window
  if (instance.status === 'paused') return 'paused'
  return window ?? 'active'
}

export function instanceEffective(user: PlanUser, instance: PlanInstance, now: number) {
  return planUserEnabled(user) && instanceDisplayStatus(instance, now) === 'active'
}

export const instanceStatuses = ['pending', 'active', 'paused', 'expired', 'revoked', 'plan_disabled'] as const
export type InstanceStatus = typeof instanceStatuses[number]
type InstancePage = { limit: number; offset: number; search?: string; status?: InstanceStatus }

const instanceJoin = `FROM user_plans i JOIN plan_definitions p ON p.id=i.plan_id
  WHERE (p.owner_user_id IS NULL OR p.owner_user_id=i.user_id)`
const ownedInstances = `${instanceJoin} AND i.user_id=?`

export async function listInstances(db: D1Database, by: { userId: string } | { planId: string },
  page: InstancePage, now = Date.now()) {
  const search = page.search ?? null
  const rows = await db.prepare(`SELECT i.*, p.name, p.enabled AS plan_enabled ${instanceJoin}
    AND ${'userId' in by ? 'i.user_id' : 'i.plan_id'}=?
    AND (? IS NULL OR instr(lower(p.name), lower(?))>0 OR instr(lower(i.user_id), lower(?))>0
      OR instr(lower(coalesce(i.remark, '')), lower(?))>0)
    AND (? IS NULL OR ?=CASE
      WHEN i.status='revoked' THEN 'revoked' WHEN p.enabled=0 THEN 'plan_disabled'
      WHEN i.expires_at<=? THEN 'expired' WHEN i.status='paused' THEN 'paused'
      WHEN i.starts_at>? THEN 'pending' ELSE 'active' END)
    ORDER BY i.id LIMIT ? OFFSET ?`).bind('userId' in by ? by.userId : by.planId,
      search, search, search, search, page.status ?? null, page.status ?? null, now, now, page.limit, page.offset)
    .all<PlanInstance>()
  return rows.results
}

type Path = { instance_id: string; kind: 'group' | 'node'; id: string }
const effectivePaths = `
  WITH effective AS (
    SELECT i.id, i.plan_id, p.remark ${ownedInstances}
    AND EXISTS (SELECT 1 FROM users u WHERE u.id=i.user_id AND u.enabled=1 AND u.deleted_at IS NULL)
    AND (? IS NULL OR i.id=?) AND p.enabled=1 AND i.status='active'
    AND i.starts_at<=? AND (i.expires_at IS NULL OR i.expires_at>?)
  )
  SELECT e.id AS instance_id, 'group' AS kind, g.id
  FROM effective e JOIN plan_node_groups pg ON pg.plan_id=e.plan_id
  JOIN groups g ON g.id=pg.group_id AND g.enabled=1
  UNION
  SELECT e.id, 'node', n.id FROM effective e
  JOIN json_each(CASE WHEN json_valid(e.remark) THEN e.remark ELSE '{}' END, '$.direct_node_ids') j
  JOIN nodes n ON n.id=j.value AND n.enabled=1 WHERE j.type='text'
`

export class EntitlementNotFound extends Error {}

export class EntitlementResolver {
  private readonly db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  async resolve(user: PlanUser, instanceId: string | null, now: number) {
    if (!planUserEnabled(user)) throw new EntitlementNotFound()
    if (instanceId !== null) {
      const instance = await this.db.prepare(`SELECT i.status ${ownedInstances} AND i.id=?`)
        .bind(user.id, instanceId).first<{ status: UserPlanRow['status'] }>()
      if (!instance) throw new EntitlementNotFound()
    }
    // Group rules include JS regular expressions and source eligibility. Resolve
    // each distinct referenced group once using the canonical catalog matcher.
    const paths = await this.db.prepare(effectivePaths).bind(user.id, instanceId, instanceId, now, now).all<Path>()
    const catalog = paths.results.length ? await readCatalogFromD1(this.db) : emptyCatalogSnapshot()
    const enabled = new Map(catalog.nodes.filter(node => node.enabled).map(node => [node.id, node]))
    const groupIds = new Map<string, string[]>()
    const byInstance = new Map<string, Set<string>>()
    const ids = new Set<string>()
    for (const path of paths.results) {
      let pathIds = groupIds.get(path.id)
      if (path.kind === 'node') pathIds = enabled.has(path.id) ? [path.id] : []
      else if (!pathIds) {
        pathIds = selectedNodes(catalog, { groupIds: [path.id] }).map(node => node.id)
        groupIds.set(path.id, pathIds)
      }
      const instanceIds = byInstance.get(path.instance_id) ?? new Set<string>()
      byInstance.set(path.instance_id, instanceIds)
      for (const id of pathIds) {
        instanceIds.add(id)
        ids.add(id)
      }
    }
    return {
      catalog, nodes: [...ids].sort().map(id => enabled.get(id)!),
      nodeCounts: new Map([...byInstance].map(([id, nodes]) => [id, nodes.size])),
    }
  }
}
