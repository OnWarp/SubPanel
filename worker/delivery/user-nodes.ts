import { Hono } from 'hono'
import type { AppEnv } from '../app-env.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import { readCatalog } from '../catalog/repository.js'
import type { CatalogSnapshot, Group, Node } from '../catalog/schema.js'
import { ApiError } from '../platform/api-error.js'
import { assertSubscriptionAvailable } from './expiry.js'
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
  userId: string
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

function subscriptionIsActive(subscription: UserNodeSubscription, now: number): boolean {
  try {
    assertSubscriptionAvailable(subscription, now)
    return true
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'SUB_EXPIRED' || error.code === 'SUB_NOT_STARTED')) return false
    throw error
  }
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
    if (subscription.userId !== userId || !subscription.enabled || !subscriptionIsActive(subscription, now)) continue
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

export const userNodeRoutes = new Hono<AppEnv>()

userNodeRoutes.get('/', async (c) => {
  const [delivery, catalog] = await Promise.all([
    readDelivery(c.env.DATA),
    readCatalog(c.env),
  ])
  return c.json({ nodes: collectUserNodes(delivery.subscriptions, catalog, c.get('principal').id) })
})
