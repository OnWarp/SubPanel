// The subscription link entries the user subscriptions page renders, in
// page order. The platform display settings (migration 0007) seed from this
// list; the database is authoritative afterwards, so admin-added platforms
// are not in this list and admin-deleted seed platforms stay deleted.
// 'generic' is a renderer client but intentionally has no user-facing link
// entry, matching the existing page.
export const SUBSCRIPTION_LINK_PLATFORMS = [
  { platform: 'auto', displayName: '自动识别' },
  { platform: 'mihomo', displayName: 'Mihomo' },
  { platform: 'clash', displayName: 'Clash' },
  { platform: 'clash-meta', displayName: 'Clash Meta' },
  { platform: 'stash', displayName: 'Stash' },
  { platform: 'singbox', displayName: 'sing-box' },
  { platform: 'karing', displayName: 'Karing' },
  { platform: 'surge', displayName: 'Surge' },
  { platform: 'loon', displayName: 'Loon' },
  { platform: 'quantumultx', displayName: 'Quantumult X' },
  { platform: 'v2rayn', displayName: 'v2rayN' },
  { platform: 'nekobox', displayName: 'NekoBox' },
  { platform: 'shadowrocket', displayName: 'Shadowrocket' },
] as const

export type SubscriptionLinkPlatform = (typeof SUBSCRIPTION_LINK_PLATFORMS)[number]['platform']

export const SUBSCRIPTION_LINK_PLATFORM_KEYS: ReadonlySet<string> = new Set(
  SUBSCRIPTION_LINK_PLATFORMS.map((entry) => entry.platform),
)

// A platform key is a URL-safe slug: it is spliced into /sub/<token>/<key>,
// so renaming a key retires the old URL.
export const PLATFORM_KEY_PATTERN = /^[a-z0-9-]+$/

// Renderers: the client format a platform link returns. 'auto' is not a
// renderer, it is the platform key whose links resolve by User-Agent.
export const PLATFORM_RENDERERS = [
  'mihomo',
  'singbox',
  'surge',
  'loon',
  'quantumultx',
  'v2rayn',
  'nekobox',
  'shadowrocket',
  'generic',
] as const

export type PlatformRenderer = (typeof PLATFORM_RENDERERS)[number]

export type PlatformRendererOrAuto = PlatformRenderer | 'auto'

export const PLATFORM_RENDERER_SET: ReadonlySet<string> = new Set(PLATFORM_RENDERERS)

// Seed mapping, used by migration 0034 to backfill the renderer column.
// Fresh installs seed from this too; the database is authoritative after
// that, so an admin may change any platform's renderer (except auto's).
export const SEED_PLATFORM_RENDERERS: Readonly<Record<string, PlatformRendererOrAuto>> = {
  auto: 'auto',
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
