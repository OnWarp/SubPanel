import { SUBSCRIPTION_LINK_PLATFORMS } from '../domains/platforms.js'

// Every subscription URL is built here. Pages and share exports must not
// assemble /sub paths, aliases, or tokens on their own.
export function subscriptionPath(token: string, platform: string): string {
  return platform === 'auto' ? `/sub/${token}` : `/sub/${token}/${platform}`
}

export function subscriptionLink(origin: string, token: string, platform: string): string {
  return `${origin}${subscriptionPath(token, platform)}`
}

export function subscriptionLinks(origin: string, token: string): Record<string, string> {
  return Object.fromEntries(
    SUBSCRIPTION_LINK_PLATFORMS.map(({ platform }) => [platform, subscriptionLink(origin, token, platform)]),
  )
}
