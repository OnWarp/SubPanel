export const EXPIRY_SOON_DAYS = 7

const DAY_MS = 86_400_000

export type ExpiryKind = 'permanent' | 'pending' | 'active' | 'soon' | 'expired'
export type ExpiryTone = 'success' | 'warning' | 'danger' | 'info' | 'muted'

export type ExpiryInput = {
  createdAt: string
  startsAt?: number | null
  expiresAt?: number | null
  enabled?: boolean
}

export type ExpiryState = {
  kind: ExpiryKind
  startsAt: number
  expiresAt: number | null
  remainingDays: number | null
}

export const EXPIRY_BADGE: Record<ExpiryKind, { tone: ExpiryTone; label: string }> = {
  active: { tone: 'success', label: '正常' },
  soon: { tone: 'warning', label: '即将到期' },
  expired: { tone: 'danger', label: '已过期' },
  pending: { tone: 'muted', label: '未生效' },
  permanent: { tone: 'info', label: '永久有效' },
}

function wholeDays(expiresAt: number, now: number): number {
  const delta = expiresAt - now
  if (delta <= 0) return 0
  return Math.ceil(delta / DAY_MS)
}

export function getExpiryState(sub: ExpiryInput, now = Date.now()): ExpiryState {
  const parsedStart = sub.startsAt ?? Date.parse(sub.createdAt)
  const startsAt = Number.isFinite(parsedStart) ? parsedStart : 0
  const expiresAt = sub.expiresAt ?? null
  if (expiresAt !== null && now > expiresAt) {
    return { kind: 'expired', startsAt, expiresAt, remainingDays: 0 }
  }
  if (now < startsAt) {
    return {
      kind: 'pending',
      startsAt,
      expiresAt,
      remainingDays: expiresAt === null ? null : wholeDays(expiresAt, now),
    }
  }
  if (expiresAt === null) return { kind: 'permanent', startsAt, expiresAt: null, remainingDays: null }
  const remainingDays = wholeDays(expiresAt, now)
  const kind = expiresAt - now <= EXPIRY_SOON_DAYS * DAY_MS ? 'soon' : 'active'
  return { kind, startsAt, expiresAt, remainingDays }
}

export function formatRemaining(days: number): string {
  return `${days} 天`
}

export function formatExpiryTime(epoch: number): string {
  return new Date(epoch).toLocaleString('zh-CN')
}

export function isWithinExpiryDays(sub: ExpiryInput, days: number, now = Date.now()): boolean {
  if (sub.enabled === false) return false
  const state = getExpiryState(sub, now)
  if (state.kind === 'expired' || state.expiresAt === null) return false
  return state.expiresAt - now <= days * DAY_MS
}

export function toDatetimeLocal(epoch: number | null | undefined): string {
  if (epoch === null || epoch === undefined) return ''
  const date = new Date(epoch)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromDatetimeLocal(value: string): number | null {
  if (!value.trim()) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

export function addExpiryDays(current: number | null, days: number, now = Date.now()): number {
  return (current ?? now) + days * DAY_MS
}
