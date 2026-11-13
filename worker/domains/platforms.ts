// The subscription link entries the user subscriptions page renders, in
// page order. The platform display settings (migration 0007) seed from this
// list; the delivery link builder iterates the same keys so the two never
// drift apart. 'generic' is a renderer client but intentionally has no
// user-facing link entry, matching the existing page.
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
