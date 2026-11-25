export const entitlementTemplatesPath = '/api/admin/subscription-templates'
export const BYTES_PER_GIB = 1024 ** 3
export const MAX_QUOTA_GIB = Number.MAX_SAFE_INTEGER / BYTES_PER_GIB
export const TERM_UNITS = { day: '天', week: '周', month: '自然月', year: '自然年' } as const

export type EntitlementConfig = {
  duration: { value: number; unit: keyof typeof TERM_UNITS }
  quotaBytes: number | null
  resetPolicy: 'none'
  groupIds: string[]
  nodeIds: string[]
  limits: { speedLimitMbps: number }
}

export type EntitlementVersion = {
  id: string
  number: number
  config: EntitlementConfig
  createdAt: string
  createdBy: string
  subscriptionCount: number
}

export type EntitlementTemplate = {
  id: string
  name: string
  description: string
  status: 'enabled' | 'disabled' | 'archived'
  allowRedemption: boolean
  revision: number
  updatedAt: string
  subscriptionCount: number
  boundUserCount: number
  ownerUserId: string | null
  currentVersion: Omit<EntitlementVersion, 'subscriptionCount'>
}

export const ENTITLEMENT_STATUS = { enabled: '已启用', disabled: '已停用', archived: '已归档' } as const

export function termLabel(config: EntitlementConfig) {
  return durationLabel(config.duration)
}

export function durationLabel({ value, unit }: EntitlementConfig['duration']) {
  return `${value} ${TERM_UNITS[unit]}`
}

export function distinguishTemplateName(template: EntitlementTemplate, templates: readonly EntitlementTemplate[]) {
  const sameName = templates.filter((other) => other.name === template.name)
  if (sameName.length < 2) return template.name

  const isPrivate = Boolean(template.ownerUserId)
  const sameScope = sameName.filter((other) => Boolean(other.ownerUserId) === isPrivate)
  const scope = isPrivate ? '专属' : '共享'
  if (sameScope.length < 2) return `${template.name}（${scope}）`

  const prefix = template.id.slice(0, 8)
  const id = sameScope.some((other) => other.id !== template.id && other.id.startsWith(prefix)) ? template.id : prefix
  return `${template.name}（${scope} · ${id}）`
}

export function quotaLabel(config: EntitlementConfig) {
  return config.quotaBytes === null ? '不限' : `${config.quotaBytes / BYTES_PER_GIB} GiB`
}

export function nodePolicyLabel(config: EntitlementConfig) {
  return [
    config.groupIds.length ? `${config.groupIds.length} 个动态组` : '',
    config.nodeIds.length ? `${config.nodeIds.length} 个直选节点` : '',
  ].filter(Boolean).join(' · ') || '无'
}
