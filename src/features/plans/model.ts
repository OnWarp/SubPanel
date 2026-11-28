import { ApiClientError } from '../../app/api'

export const DAY_SECONDS = 86400
export const DURATION_PRESETS = [7, 30, 90, 365] as const

export type PlanStatus = 'enabled' | 'disabled' | 'archived'
export type InstanceStatus = 'pending' | 'active' | 'paused' | 'expired' | 'revoked' | 'plan_disabled'
export type PlanSource = 'admin' | 'redeem' | 'manual' | 'migration' | 'trial'
export type RedeemStatus = 'active' | 'disabled' | 'expired' | 'exhausted'

export type PlanGroup = {
  id: string
  name: string
  enabled: boolean
  nodeCount: number
  empty: boolean
}

export type PlanStats = {
  userCount: number
  instanceCount: number
  total: number
  active: number
  paused: number
  revoked: number
  expired: number
  pending: number
}

export type PlanDefinition = {
  id: string
  name: string
  description: string
  remark: string | null
  note: string
  duration_seconds: number | null
  enabled: 0 | 1
  archived_at: string | null
  version: number
  status: PlanStatus
  nodeGroupIds: string[]
  nodeGroups: PlanGroup[]
  nodeCount: number
  userCount: number
  instanceCount: number
  stats: PlanStats
  created_at: string
  updated_at: string
}

export type PlanInstance = {
  id: string
  user_id: string
  plan_id: string
  name: string
  starts_at: number
  expires_at: number | null
  status: 'active' | 'paused' | 'revoked'
  source: PlanSource
  source_id: string | null
  remark: string | null
  version: number
  plan_enabled: number
  nodeCount: number
  copyable: boolean
  username?: string
}

export type AggregateSubscription = {
  subscriptionUrl: string | null
  issued: boolean
  copyable: boolean
  nodeCount: number
}

export type RedeemCode = {
  id: string
  masked: string
  tail: string
  planId: string
  planName: string | null
  durationMode: 'plan_default' | 'fixed' | 'permanent'
  durationSeconds: number | null
  validFrom: number | null
  validUntil: number | null
  maxUses: number
  usedCount: number
  perUserLimit: number
  enabled: boolean
  remark: string | null
}

export type CodeRedemption = {
  id: string
  codeId: string
  userId: string
  userPlanId: string | null
  redeemedAt: string
  requestId: string
  username: string | null
  instanceStatus: string | null
  expiresAt: number | null
  planName: string | null
}

const planStatusLabels: Record<PlanStatus, string> = { enabled: '启用', disabled: '停用', archived: '已归档' }
const instanceStatusLabels: Record<InstanceStatus, string> = {
  pending: '未生效', active: '有效', paused: '已暂停', expired: '已过期', revoked: '已撤销', plan_disabled: '套餐停用',
}
const sourceLabels: Record<PlanSource, string> = {
  admin: '管理员', redeem: '兑换', manual: '手动', migration: '迁移', trial: '试用',
}
const redeemStatusLabels: Record<RedeemStatus, string> = {
  active: '有效', disabled: '停用', expired: '已过期', exhausted: '已用完',
}

export function errorText(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function formatDuration(seconds: number | null) {
  if (seconds === null) return '永久'
  if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS} 天`
  return `${seconds} 秒`
}

export function formatInstant(value: number | null) {
  if (value === null) return '永久'
  return new Date(value).toLocaleString('zh-CN')
}

export function formatStamp(value: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN')
}

export function planStatusLabel(status: PlanStatus) {
  return planStatusLabels[status]
}

export function instanceStatus(row: Pick<PlanInstance, 'status' | 'plan_enabled' | 'starts_at' | 'expires_at'>, now = Date.now()): InstanceStatus {
  if (row.status === 'revoked') return 'revoked'
  if (!row.plan_enabled) return 'plan_disabled'
  if (row.expires_at !== null && row.expires_at <= now) return 'expired'
  if (row.status === 'paused') return 'paused'
  if (row.starts_at > now) return 'pending'
  return 'active'
}

export function instanceStatusLabel(status: InstanceStatus) {
  return instanceStatusLabels[status]
}

export function sourceLabel(source: string) {
  return sourceLabels[source as PlanSource] ?? source
}

export function redeemStatus(code: Pick<RedeemCode, 'enabled' | 'validUntil' | 'usedCount' | 'maxUses'>, now = Date.now()): RedeemStatus {
  if (!code.enabled) return 'disabled'
  if (code.validUntil !== null && code.validUntil <= now) return 'expired'
  if (code.usedCount >= code.maxUses) return 'exhausted'
  return 'active'
}

export function redeemStatusLabel(status: RedeemStatus) {
  return redeemStatusLabels[status]
}

export function redeemDuration(code: Pick<RedeemCode, 'durationMode' | 'durationSeconds'>) {
  if (code.durationMode === 'permanent') return '永久'
  if (code.durationMode === 'plan_default') return '跟随套餐'
  return formatDuration(code.durationSeconds)
}

export function groupSummary(plan: Pick<PlanDefinition, 'nodeGroups'>) {
  const names = plan.nodeGroups.map((group) => group.name)
  if (!names.length) return '—'
  if (names.length <= 2) return names.join('、')
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 个`
}

export function pageCountFor(page: number, rows: number, limit: number) {
  return rows === limit ? page + 1 : page
}
