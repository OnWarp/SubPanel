export type PlatformSetting = {
  platform: string
  displayName: string
  enabled: boolean
  sortOrder: number
  renderer: string
}

export type PlatformDraft = {
  platform: string
  displayName: string
  enabled: boolean
  renderer: string
}

export type PlatformDraftErrors = {
  platform?: string
  displayName?: string
  renderer?: string
}

export const AUTO_PLATFORM = 'auto'
export const PLATFORM_KEY_PATTERN = /^[a-z0-9-]+$/
export const PLATFORM_KEY_MAX = 64
export const PLATFORM_NAME_MAX = 64

// The client formats a link can be rendered as. 'generic' has no seed link
// entry, but an admin-added platform may use it like any other renderer.
export const PLATFORM_RENDERER_OPTIONS = [
  { value: 'mihomo', label: 'Mihomo' },
  { value: 'singbox', label: 'sing-box' },
  { value: 'surge', label: 'Surge' },
  { value: 'loon', label: 'Loon' },
  { value: 'quantumultx', label: 'Quantumult X' },
  { value: 'v2rayn', label: 'v2rayN' },
  { value: 'nekobox', label: 'NekoBox' },
  { value: 'shadowrocket', label: 'Shadowrocket' },
  { value: 'generic', label: '通用' },
] as const

const RENDERER_VALUES: ReadonlySet<string> = new Set(PLATFORM_RENDERER_OPTIONS.map((option) => option.value))

export function isAutoPlatform(key: string): boolean {
  return key === AUTO_PLATFORM
}

export function rendererLabel(renderer: string): string {
  if (renderer === AUTO_PLATFORM) return '自动识别'
  return PLATFORM_RENDERER_OPTIONS.find((option) => option.value === renderer)?.label ?? renderer
}

/**
 * Client-side validation mirrors the worker's rules: a URL-safe slug, a
 * non-empty display name, and a known renderer (auto stays auto). The
 * platform key may stay unchanged while editing; any other duplicate is
 * rejected here so the operator sees it inline instead of after a round trip.
 */
export function validatePlatformDraft(
  draft: PlatformDraft,
  platforms: readonly PlatformSetting[],
  originalKey?: string,
): PlatformDraftErrors {
  const errors: PlatformDraftErrors = {}
  const key = draft.platform.trim()
  if (key === '') errors.platform = '请输入平台键'
  else if (key.length > PLATFORM_KEY_MAX) errors.platform = `平台键最多 ${PLATFORM_KEY_MAX} 个字符`
  else if (!PLATFORM_KEY_PATTERN.test(key)) errors.platform = '只能使用小写字母、数字与连字符'
  else if (platforms.some((entry) => entry.platform === key && entry.platform !== originalKey)) {
    errors.platform = '平台键已存在'
  }

  const name = draft.displayName.trim()
  if (name === '') errors.displayName = '请输入显示名'
  else if (name.length > PLATFORM_NAME_MAX) errors.displayName = `显示名最多 ${PLATFORM_NAME_MAX} 个字符`

  if (key === AUTO_PLATFORM) {
    if (draft.renderer !== AUTO_PLATFORM) errors.renderer = '自动识别的渲染器固定为自动识别'
  } else if (draft.renderer === AUTO_PLATFORM || !RENDERER_VALUES.has(draft.renderer)) {
    errors.renderer = '请选择渲染器'
  }
  return errors
}

export function hasPlatformErrors(errors: PlatformDraftErrors): boolean {
  return Object.values(errors).some(Boolean)
}

export function normalizePlatformDraft(draft: PlatformDraft): PlatformDraft {
  const platform = draft.platform.trim()
  return {
    platform,
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    renderer: platform === AUTO_PLATFORM ? AUTO_PLATFORM : draft.renderer,
  }
}

/**
 * The full-replace payload. sortOrder is authoritative on the worker and the
 * submitted list is the final display order, so it is renumbered 0, 10, 20 …
 */
export function buildPlatformPayload(platforms: readonly PlatformSetting[]): {
  platforms: Array<{ platform: string; displayName: string; enabled: boolean; sortOrder: number; renderer: string }>
} {
  return {
    platforms: platforms.map((entry, index) => ({
      platform: entry.platform,
      displayName: entry.displayName,
      enabled: entry.enabled,
      sortOrder: index * 10,
      renderer: entry.platform === AUTO_PLATFORM ? AUTO_PLATFORM : entry.renderer,
    })),
  }
}

export function movePlatform(
  platforms: readonly PlatformSetting[],
  index: number,
  direction: -1 | 1,
): PlatformSetting[] {
  const target = index + direction
  if (target < 0 || target >= platforms.length) return [...platforms]
  const next = [...platforms]
  const [entry] = next.splice(index, 1)
  next.splice(target, 0, entry)
  return next
}

export function addPlatform(platforms: readonly PlatformSetting[], draft: PlatformDraft): PlatformSetting[] {
  const highest = platforms.reduce((max, entry) => Math.max(max, entry.sortOrder), -10)
  return [...platforms, { ...normalizePlatformDraft(draft), sortOrder: highest + 10 }]
}

export function updatePlatform(
  platforms: readonly PlatformSetting[],
  originalKey: string,
  draft: PlatformDraft,
): PlatformSetting[] {
  return platforms.map((entry) =>
    entry.platform === originalKey ? { ...entry, ...normalizePlatformDraft(draft) } : entry,
  )
}

export function removePlatform(platforms: readonly PlatformSetting[], key: string): PlatformSetting[] {
  return platforms.filter((entry) => entry.platform !== key)
}
