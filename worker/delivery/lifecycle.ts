import { readAccounts } from '../accounts/repository.js'
import { readCatalog } from '../catalog/repository.js'
import type { DataEnv } from '../db/module-switch.js'
import { SUBSCRIPTION_LINK_PLATFORMS } from '../domains/platforms.js'
import type { RenderClient } from '../renderers/index.js'
import type { Template } from '../templates/validation.js'
import { entitledNodes, prepareSubscriptionRender, type AccessSnapshot, type ZeroNodeReason } from './compiler.js'
import { effectiveStartsAt } from './expiry.js'
import { listPlans } from './plans.js'
import type { Subscription } from './schema.js'

export const SUBSCRIPTION_STATUSES = [
  'pending',
  'active',
  'disabled',
  'expired',
  'revoked',
  'owner_unavailable',
  'no_plan',
  'no_groups',
  'no_nodes',
  'incompatible',
] as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export type StatusFix = { label: string; href?: string }

export type SubscriptionFormatReport = {
  platform: string
  displayName: string
  capability: 'full' | 'nodes'
  capabilityLabel: string
  compatible: boolean
  outputNodes: number
  note: string | null
}

const ADMIN_LABEL: Record<SubscriptionStatus, string> = {
  pending: '未生效',
  active: '正常',
  disabled: '已停用',
  expired: '已过期',
  revoked: '已撤销',
  owner_unavailable: '用户不可用',
  no_plan: '无计划',
  no_groups: '无分组',
  no_nodes: '无节点',
  incompatible: '不兼容',
}

const ADMIN_REASON: Record<SubscriptionStatus, string> = {
  pending: '订阅尚未到生效时间',
  active: '订阅有效',
  disabled: '管理员已停用',
  expired: '订阅已过期',
  revoked: '计划已撤销',
  owner_unavailable: '所属用户已停用或删除',
  no_plan: '未绑定有效计划',
  no_groups: '计划允许的组与所选组没有交集',
  no_nodes: '授权范围内没有启用节点',
  incompatible: '默认客户端没有兼容节点',
}

const ADMIN_FIX: Record<SubscriptionStatus, StatusFix | null> = {
  pending: { label: '调整生效时间' },
  active: null,
  disabled: { label: '启用订阅' },
  expired: { label: '延长到期时间' },
  revoked: { label: '重新分配计划' },
  owner_unavailable: { label: '前往用户', href: '/users' },
  no_plan: { label: '选择计划' },
  no_groups: { label: '调整分组' },
  no_nodes: { label: '前往节点', href: '/catalog/nodes' },
  incompatible: { label: '更换默认客户端' },
}

const USER_LABEL: Record<SubscriptionStatus, string> = {
  pending: '尚未生效',
  active: '有效',
  disabled: '已停用',
  expired: '已过期',
  revoked: '已停用',
  owner_unavailable: '暂不可用',
  no_plan: '未开通',
  no_groups: '暂无可用节点',
  no_nodes: '暂无可用节点',
  incompatible: '当前客户端没有兼容节点',
}

// Clash-family aliases render through Mihomo, which is the only client that
// expands proxy groups and rules. Every other displayed platform is a node list.
const FULL_RULE_PLATFORMS = new Set(['mihomo', 'clash', 'clash-meta', 'stash'])

const PLATFORM_RENDER: Record<string, RenderClient> = {
  auto: 'generic',
  mihomo: 'mihomo',
  clash: 'mihomo',
  'clash-meta': 'mihomo',
  stash: 'mihomo',
  singbox: 'singbox',
  karing: 'singbox',
  surge: 'surge',
  loon: 'loon',
  quantumultx: 'quantumultx',
  v2rayn: 'v2rayn',
  nekobox: 'nekobox',
  shadowrocket: 'shadowrocket',
}

const AUTO_NOTE = '识别到 Mihomo 时输出完整规则配置，识别失败回退为通用节点列表'

export function lifecycleStatus(
  subscription: Subscription,
  reason: ZeroNodeReason | null,
  now: number,
  clientOutput: number,
): SubscriptionStatus {
  const rowStatus = subscriptionRowStatus(subscription, now)
  if (rowStatus) return rowStatus
  if (reason === 'unassigned' || reason === 'ownerUnavailable') return 'owner_unavailable'
  if (reason === 'pending') return 'pending'
  if (reason === 'noPlan') return 'no_plan'
  if (reason === 'noGroupIntersection') return 'no_groups'
  if (reason === 'noEnabledNodes') return 'no_nodes'
  if (reason === 'expired') return 'expired'
  if (reason === 'disabled') return 'disabled'
  if (clientOutput <= 0) return 'incompatible'
  return 'active'
}

export function subscriptionRowStatus(subscription: Subscription, now: number): SubscriptionStatus | null {
  if (subscription.expiresAt !== null && subscription.expiresAt <= now) return 'expired'
  if (subscription.planRevoked) return 'revoked'
  if (!subscription.enabled) return 'disabled'
  if (!subscription.userId) return 'owner_unavailable'
  if (now < effectiveStartsAt(subscription)) return 'pending'
  return null
}

export function presentSubscriptionStatus(status: SubscriptionStatus, audience: 'admin' | 'user') {
  if (audience === 'user') return { status, statusLabel: USER_LABEL[status] }
  return {
    status,
    statusLabel: ADMIN_LABEL[status],
    statusReason: ADMIN_REASON[status],
    statusFix: ADMIN_FIX[status],
  }
}

export async function loadAccessSnapshot(env: DataEnv): Promise<AccessSnapshot> {
  const [catalog, accounts, plans] = await Promise.all([
    readCatalog(env),
    readAccounts(env),
    listPlans(env.DB),
  ])
  return { catalog, users: accounts.users, plans }
}

export async function classifySubscription(
  env: DataEnv,
  subscription: Subscription,
  now: string,
  snapshot?: AccessSnapshot,
  template?: Template,
  templateInvalid = false,
) {
  const access = await entitledNodes(env, subscription, now, snapshot)
  const results = new Map<RenderClient, Promise<number>>()
  const outputFor = (client: RenderClient) => {
    const existing = results.get(client)
    if (existing) return existing
    const result = prepareSubscriptionRender(client, access.nodes, access.speed)
      .then((prepared) => client === 'mihomo' && templateInvalid ? 0 : prepared.render(template).outputNodes)
      .catch(() => 0)
    results.set(client, result)
    return result
  }
  const [outputNodes, formats] = await Promise.all([
    outputFor(subscription.defaultClient),
    Promise.all(SUBSCRIPTION_LINK_PLATFORMS.map(async ({ platform, displayName }): Promise<SubscriptionFormatReport> => {
      const client = PLATFORM_RENDER[platform] ?? 'generic'
      const outputNodes = await outputFor(client)
      const capability = FULL_RULE_PLATFORMS.has(platform) ? 'full' : 'nodes'
      const compatible = outputNodes > 0
      const note = !compatible
        ? client === 'mihomo' && templateInvalid ? '已发布配置校验失败' : '当前格式没有可用节点'
        : platform === 'auto' ? AUTO_NOTE : null
      return {
        platform, displayName, capability, compatible, outputNodes, note,
        capabilityLabel: capability === 'full' ? '完整规则配置' : '仅节点订阅',
      }
    })),
  ])
  return {
    status: lifecycleStatus(subscription, access.zeroNodeReason, Date.parse(now), outputNodes),
    authorizedGroupIds: access.authorizedGroupIds,
    authorizedNodeCount: access.nodes.filter((node) => node.enabled).length,
    formats,
  }
}
