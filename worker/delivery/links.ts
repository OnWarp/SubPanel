// Every subscription URL is built here. Pages and share exports must not
// assemble /sub paths, aliases, or tokens on their own.
export function subscriptionPath(token: string, platform: string): string {
  return platform === 'auto' ? `/sub/${token}` : `/sub/${token}/${platform}`
}

export function subscriptionLink(origin: string, token: string, platform: string): string {
  return `${origin}${subscriptionPath(token, platform)}`
}

// Links come from the platform rows in the database, not the seed list, so
// admin-added platforms get links and admin-deleted platforms lose them.
// Callers pass the rows in; the frontend still filters by the enabled list.
export function subscriptionLinks(
  origin: string,
  token: string,
  platforms: ReadonlyArray<{ platform: string }>,
): Record<string, string> {
  return Object.fromEntries(
    platforms.map(({ platform }) => [platform, subscriptionLink(origin, token, platform)]),
  )
}
