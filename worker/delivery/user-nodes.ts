import { Hono } from 'hono'
import type { AppEnv } from '../app-env.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import type { CatalogSnapshot, Group, Node } from '../catalog/schema.js'
import { subscriptionRowStatus } from './expiry.js'
import { resolveEntitlement } from './compiler.js'
import { loadAccessSnapshot } from './lifecycle.js'
import { readDelivery } from './repository.js'

export type UserNodeRef = {
  id: string
  name: string
}

export type UserNodeDto = {
  id: string
  name: string
  protocol: string | null
  groups: UserNodeRef[]
  subscriptions: UserNodeRef[]
}

export type UserNodeSubscription = {
  id: string
  userId: string | null
  name: string
  groupIds: readonly string[]
  enabled: boolean
  startsAt: number | null
  expiresAt: number | null
  createdAt: string
}

// Groups have no enabled field in the catalog schema. A missing group is
// skipped. enabled === false is honored only if a payload carries it.
// Membership matches subscription compilation via resolveGroupNodes.
function groupIsActive(group: Group): boolean {
  const enabled = (group as { enabled?: unknown }).enabled
  return enabled !== false
}

function protocolOf(node: Node): string | null {
  return node.protocol ? node.protocol : null
}

function pushRef(list: UserNodeRef[], ref: UserNodeRef): void {
  if (!list.some((item) => item.id === ref.id)) list.push(ref)
}

export function collectUserNodes(
  subscriptions: readonly UserNodeSubscription[],
  catalog: CatalogSnapshot,
  userId: string,
  now = Date.now(),
): UserNodeDto[] {
  const groupsById = new Map(catalog.groups.map((group) => [group.id, group]))
  const merged = new Map<string, UserNodeDto>()

  for (const subscription of subscriptions) {
    if (subscription.userId !== userId || subscriptionRowStatus(subscription, now)) continue
    for (const groupId of subscription.groupIds) {
      const group = groupsById.get(groupId)
      if (!group || !groupIsActive(group)) continue
      for (const node of resolveGroupNodes(catalog, group.id)) {
        const current = merged.get(node.id) ?? {
          id: node.id,
          name: node.displayName,
          protocol: protocolOf(node),
          groups: [],
          subscriptions: [],
        }
        pushRef(current.groups, { id: group.id, name: group.name })
        pushRef(current.subscriptions, { id: subscription.id, name: subscription.name })
        merged.set(node.id, current)
      }
    }
  }

  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans') || left.id.localeCompare(right.id))
}

// Copied from the admin users list (worker/accounts/admin-routes.ts) so every
// paginated list shares one parameter contract: page defaults to 1 and
// pageSize defaults to 20, clamped to 100.
const parsePagination = (query: Record<string, string | undefined>): { page: number, pageSize: number } => {
  const page = Number.parseInt(query.page ?? '', 10)
  const pageSize = Number.parseInt(query.pageSize ?? '', 10)
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
  }
}

export type UserNodeFilters = {
  query: string | null
  subscriptionId: string | null
  groupId: string | null
}

const parseUserNodeFilters = (query: Record<string, string | undefined>): UserNodeFilters => {
  const needle = query.q?.trim().toLowerCase()
  return {
    query: needle ? needle : null,
    subscriptionId: query.subscriptionId && query.subscriptionId !== 'all' ? query.subscriptionId : null,
    groupId: query.groupId && query.groupId !== 'all' ? query.groupId : null,
  }
}

// Same matching the "我的节点" page applied client-side before pagination:
// a case-insensitive name substring plus exact subscription/group membership.
export function filterUserNodes(nodes: readonly UserNodeDto[], filters: UserNodeFilters): UserNodeDto[] {
  return nodes.filter((node) => {
    if (filters.query !== null && !node.name.toLowerCase().includes(filters.query)) return false
    if (filters.subscriptionId !== null && !node.subscriptions.some((item) => item.id === filters.subscriptionId)) return false
    if (filters.groupId !== null && !node.groups.some((item) => item.id === filters.groupId)) return false
    return true
  })
}

function uniqueNodeRefs(nodes: readonly UserNodeDto[], key: 'groups' | 'subscriptions'): UserNodeRef[] {
  const refs = new Map<string, string>()
  for (const node of nodes) {
    for (const item of node[key]) {
      if (!refs.has(item.id)) refs.set(item.id, item.name)
    }
  }
  return [...refs].map(([id, name]) => ({ id, name }))
}

const hasUserNodeParams = (query: Record<string, string | undefined>): boolean =>
  ['page', 'pageSize', 'q', 'subscriptionId', 'groupId'].some((key) => query[key] !== undefined)

export const userNodeRoutes = new Hono<AppEnv>()

userNodeRoutes.get('/', async (c) => {
  const [delivery, snapshot] = await Promise.all([readDelivery(c.env), loadAccessSnapshot(c.env)])
  const userId = c.get('principal').id
  const now = new Date()
  const assigned = delivery.subscriptions.filter(subscription => subscription.userId === userId)
  const eligible = (await Promise.all(assigned.map(async (subscription) => {
    const access = await resolveEntitlement(c.env, subscription, now.toISOString(), snapshot)
    return access.zeroNodeReason && !['noGroupIntersection', 'noEnabledNodes'].includes(access.zeroNodeReason)
      ? [] : [{ ...subscription, groupIds: access.authorizedGroupIds }]
  }))).flat()
  const nodes = collectUserNodes(eligible, snapshot.catalog, userId, now.getTime())
  const query = c.req.query()
  if (!hasUserNodeParams(query)) return c.json({ nodes })
  const { page, pageSize } = parsePagination(query)
  const filtered = filterUserNodes(nodes, parseUserNodeFilters(query))
  return c.json({
    nodes: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize,
    subscriptionOptions: uniqueNodeRefs(nodes, 'subscriptions'),
    groupOptions: uniqueNodeRefs(nodes, 'groups'),
    hasActiveSubscription: eligible.length > 0,
  })
})
