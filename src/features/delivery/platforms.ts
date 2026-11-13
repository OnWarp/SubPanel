import { useEffect, useState } from 'react'
import { api } from '../../app/api'

export type SubscriptionPlatformEntry = {
  platform: string
  displayName: string
}

export type EnabledPlatformsState = {
  status: 'loading' | 'ready' | 'failed'
  /** Enabled platform keys in display order; only meaningful when ready. */
  order: string[]
  names: Record<string, string>
}

/**
 * Loads the user-visible subscription platform list. The display switch is
 * a presentation preference, not an access control: while loading or when
 * the request fails, callers fall back to rendering every link entry.
 */
export function useEnabledPlatforms(): EnabledPlatformsState {
  const [state, setState] = useState<EnabledPlatformsState>({ status: 'loading', order: [], names: {} })
  useEffect(() => {
    let cancelled = false
    api<{ platforms: SubscriptionPlatformEntry[] }>('/api/account/subscription-platforms')
      .then((result) => {
        if (cancelled) return
        setState({
          status: 'ready',
          order: result.platforms.map((entry) => entry.platform),
          names: Object.fromEntries(result.platforms.map((entry) => [entry.platform, entry.displayName])),
        })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed', order: [], names: {} })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/** Filters and orders link entries by the enabled platform list. */
export function orderLinkEntries(
  entries: Array<[string, string]>,
  platforms: EnabledPlatformsState,
): Array<[string, string]> {
  if (platforms.status !== 'ready') return entries
  const byKey = new Map(entries)
  return platforms.order
    .filter((key) => byKey.has(key))
    .map((key) => [key, byKey.get(key)!] as [string, string])
}

/**
 * Picks the primary subscription link: the automatic entry first, then
 * the subscription's default client, then the first visible entry — each
 * step only among platforms the admin left visible.
 */
export function pickPrimaryLink(
  links: Record<string, string>,
  defaultClient: string,
  platforms: EnabledPlatformsState,
): string {
  if (platforms.status !== 'ready') return links.auto || links[defaultClient] || ''
  if (platforms.order.includes('auto') && links.auto) return links.auto
  if (platforms.order.includes(defaultClient) && links[defaultClient]) return links[defaultClient]
  for (const key of platforms.order) {
    if (links[key]) return links[key]
  }
  return ''
}

/** Fallback display names for subscription clients, used when the platform settings have no name. */
export const CLIENT_LABELS: Record<string, string> = {
  auto: '自动识别',
  mihomo: 'Mihomo',
  clash: 'Clash',
  'clash-meta': 'Clash Meta',
  stash: 'Stash',
  singbox: 'sing-box',
  karing: 'Karing',
  surge: 'Surge',
  loon: 'Loon',
  quantumultx: 'Quantumult X',
  v2rayn: 'v2rayN',
  nekobox: 'NekoBox',
  shadowrocket: 'Shadowrocket',
}
