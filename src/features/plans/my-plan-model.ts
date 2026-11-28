import { ApiClientError } from '../../app/api'

export const PLAN_PAGE_SIZE = 20
export const EXPIRING_SOON_DAYS = 7
const DAY_MS = 86_400_000

export type PlanBucket = 'active' | 'pending' | 'expired' | 'disabled'
export type MyPlanStatus = 'active' | 'pending' | 'expired' | 'paused' | 'plan_disabled'
export type PlanFilter = 'all' | PlanBucket

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

export type PlanOverview = {
  user: { id: string; username: string; email: string | null; avatarUrl: string | null }
  plans: PlanSummary
  serverTime: string
}

export type PlanListItem = {
  instanceId: string
  planId: string
  name: string
  status: MyPlanStatus
  bucket: PlanBucket
  startsAt: number
  expiresAt: number | null
  createdAt: string
  nodeGroupCount: number
}

export type PlanListResponse = {
  items: PlanListItem[]
  nextCursor: string | null
  summary: PlanSummary
  serverTime: string
}

export type PlanGroupRef = { id: string; name: string; enabled: boolean }

export type PlanDetail = {
  instanceId: string
  planId: string
  name: string
  description: string
  status: MyPlanStatus
  bucket: PlanBucket
  startsAt: number
  expiresAt: number | null
  createdAt: string
  updatedAt: string
  remainingSeconds: number | null
  source: string
  nodeGroupCount: number
  nodeGroups: PlanGroupRef[]
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
  copyable: boolean
}

const statusLabels: Record<MyPlanStatus, string> = {
  active: '有效',
  pending: '待生效',
  expired: '已过期',
  paused: '已暂停',
  plan_disabled: '套餐停用',
}

const sourceLabels: Record<string, string> = {
  admin: '管理员分配',
  redeem: '兑换码',
  manual: '手动',
  migration: '迁移',
  trial: '试用',
}

export const accessStatusLabels = {
  active: '有效',
  expired: '已过期',
  pending: '待生效',
  disabled: '暂无有效套餐',
  none: '暂无套餐',
} as const

export function planStatusLabel(status: MyPlanStatus) {
  return statusLabels[status]
}

export function planStatusTone(status: MyPlanStatus): 'success' | 'warning' | 'danger' | 'muted' | 'info' {
  if (status === 'active') return 'success'
  if (status === 'pending') return 'info'
  if (status === 'expired') return 'muted'
  return 'warning'
}

export function planSourceLabel(source: string) {
  return sourceLabels[source] ?? source
}

export function isPlanActive(status: MyPlanStatus) {
  return status === 'active'
}

export function errorText(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

/** `YYYY.MM.DD` in the user's display timezone. */
export function formatPlanDate(epoch: number | null) {
  if (epoch === null) return ''
  const date = new Date(epoch)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

export function formatPlanTime(epoch: number | null) {
  if (epoch === null) return '长期有效'
  return new Date(epoch).toLocaleString('zh-CN')
}

/**
 * Days left, rounded up; under one day reads "不足 1 天". Returns null for a
 * permanent grant so callers render "长期有效" instead of a number.
 */
export function remainingDaysText(expiresAt: number | null, now = Date.now()): string | null {
  if (expiresAt === null) return null
  const remaining = expiresAt - now
  if (remaining <= 0) return '已过期'
  if (remaining < DAY_MS) return '不足 1 天'
  return `${Math.ceil(remaining / DAY_MS)} 天`
}

export function remainingSecondsText(seconds: number | null): string | null {
  if (seconds === null) return '长期有效'
  if (seconds <= 0) return '已过期'
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `${days} 天`
  if (seconds < 3600) return '不足 1 小时'
  return `${Math.ceil(seconds / 3600)} 小时`
}

/** One overview line for the personal-center card. */
export function planStatusLine(summary: PlanSummary): string {
  switch (summary.accessStatus) {
    case 'active':
      if (summary.hasPermanentActivePlan) return '长期有效'
      return summary.validUntil === null ? '有效' : `有效期至 ${formatPlanDate(summary.validUntil)}`
    case 'expired':
      return summary.lastExpiredAt === null ? '已过期' : `已过期 · ${formatPlanDate(summary.lastExpiredAt)}`
    case 'pending':
      return '待生效'
    case 'disabled':
      return '暂无有效套餐'
    default:
      return '暂无套餐'
  }
}

export function expiringSoonText(summary: PlanSummary, now = Date.now()): string | null {
  const soon = expiringSoonLabel(summary, now)
  if (soon !== null) return soon
  if (summary.active === 0 || summary.hasPermanentActivePlan || summary.validUntil === null) return null
  const days = remainingDaysText(summary.validUntil, now)
  if (days === null) return null
  return days === '不足 1 天' ? '距到期不足 1 天' : `距全部有效套餐到期还有 ${days}`
}

export function expiringSoonLabel(summary: PlanSummary, now = Date.now()): string | null {
  if (summary.active === 0 || summary.expiringSoonCount === 0 || summary.nextExpiryAt === null) return null
  const days = remainingDaysText(summary.nextExpiryAt, now)
  if (days === null || days === '已过期') return null
  return `${summary.expiringSoonCount} 个套餐将在 ${days}内到期`
}

export function isExpiringSoon(expiresAt: number | null, now = Date.now()) {
  if (expiresAt === null) return false
  return expiresAt - now <= EXPIRING_SOON_DAYS * DAY_MS && expiresAt > now
}

/** Human date range for a plan detail header. */
export function planRangeText(startsAt: number, expiresAt: number | null) {
  if (expiresAt === null) return `${formatPlanDate(startsAt)} 起 · 长期有效`
  return `${formatPlanDate(startsAt)} — ${formatPlanDate(expiresAt)}`
}
