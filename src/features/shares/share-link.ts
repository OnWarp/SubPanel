const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/u
const SHARE_RETURN_KEY = 'subpanel.shareReturn'
const SHARE_RETURN_PATH = /^\/s\/[A-Za-z0-9_-]{43}$/u

export function isShareToken(value: string): boolean {
  return SHARE_TOKEN.test(value)
}

function configuredOrigin(value?: string | null): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username || url.password || url.search || url.hash) return ''
    if (url.pathname !== '/' && url.pathname !== '') return ''
    return url.origin
  } catch {
    return ''
  }
}

function currentOrigin(origin?: string): string {
  if (origin) return origin
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  return ''
}

/**
 * Share links prefer a policy publicBaseUrl when the API actually sends one.
 * There is no user-readable settings endpoint, so callers pass it only if a response includes it.
 */
export function readPublicBaseUrl(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  // linkBaseUrl (the primary subscription domain origin) wins over the
  // legacy share-settings publicBaseUrl when the API provides it.
  if (typeof record.linkBaseUrl === 'string') return record.linkBaseUrl
  if (typeof record.publicBaseUrl === 'string') return record.publicBaseUrl
  const share = record.share
  if (share && typeof share === 'object') {
    const nestedRecord = share as Record<string, unknown>
    if (typeof nestedRecord.linkBaseUrl === 'string') return nestedRecord.linkBaseUrl
    const nested = nestedRecord.publicBaseUrl
    if (typeof nested === 'string') return nested
  }
  return undefined
}

export function buildShareUrl(token: string, publicBaseUrl?: string | null, origin?: string): string {
  const base = configuredOrigin(publicBaseUrl) || currentOrigin(origin)
  return `${base}/s/${token}`
}

export function buildShareExportUrl(token: string, client: string, baseUrl?: string | null, origin?: string): string {
  const base = configuredOrigin(baseUrl) || currentOrigin(origin)
  return `${base}/api/shares/${encodeURIComponent(token)}/export?client=${encodeURIComponent(client)}`
}

export function rememberShareReturn(token: string): void {
  if (!isShareToken(token)) return
  try {
    sessionStorage.setItem(SHARE_RETURN_KEY, `/s/${token}`)
  } catch {
    // Storage can be blocked. Login still works; the visitor returns by the address bar.
  }
}

export function readShareReturn(): string | null {
  try {
    const value = sessionStorage.getItem(SHARE_RETURN_KEY)
    if (!value || !SHARE_RETURN_PATH.test(value)) return null
    return value
  } catch {
    return null
  }
}

export function clearShareReturn(): void {
  try {
    sessionStorage.removeItem(SHARE_RETURN_KEY)
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

export function formatShareTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatRemaining(value: string): string {
  const remaining = Date.parse(value) - Date.now()
  if (!Number.isFinite(remaining)) return ''
  const days = Math.ceil(remaining / 86_400_000)
  if (days <= 1) return '今日到期'
  return `剩余 ${days} 天`
}
