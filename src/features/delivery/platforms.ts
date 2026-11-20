import { useEffect, useState } from 'react'
import { peekApi, watchApi } from '../../app/api'

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

type PlatformsResponse = { platforms: SubscriptionPlatformEntry[] }

function platformState(result: PlatformsResponse): EnabledPlatformsState {
  return {
    status: 'ready',
    order: result.platforms.map((entry) => entry.platform),
    names: Object.fromEntries(result.platforms.map((entry) => [entry.platform, entry.displayName])),
  }
}

/**
 * Loads the user-visible subscription platform list. The display switch is
 * a presentation preference, not an access control: while loading or when
 * the request fails, callers fall back to rendering every link entry.
 */
export function useEnabledPlatforms(): EnabledPlatformsState {
  const path = '/api/account/subscription-platforms'
  const [state, setState] = useState<EnabledPlatformsState>(() => {
    const initial = peekApi<PlatformsResponse>(path)
    return initial ? platformState(initial) : { status: 'loading', order: [], names: {} }
  })

  useEffect(() => {
    const controller = new AbortController()
    void watchApi<PlatformsResponse>(path, (result) => setState(platformState(result)), { signal: controller.signal })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'failed', order: [], names: {} })
      })
    return () => controller.abort()
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
