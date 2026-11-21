type HomeTraffic = {
  usedGb?: number
  remainingGb?: number | null
}

function finiteGb(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/** Display cleanup under 0.000001 GB. The API value itself is not rounded. */
export function formatTrafficGb(value: number): string {
  const scaled = Math.round(value * 1_000_000) / 1_000_000
  return Object.is(scaled, -0) ? '0' : String(scaled)
}

export function homeTrafficLine(subscription: HomeTraffic | null | undefined): string | null {
  if (!subscription || !finiteGb(subscription.usedGb ?? Number.NaN)) return null
  const used = formatTrafficGb(subscription.usedGb ?? 0)
  if (subscription.remainingGb === null) return `已用 ${used} GB · 剩余不限`
  if (!finiteGb(subscription.remainingGb ?? Number.NaN)) return null
  return `已用 ${used} GB · 剩余 ${formatTrafficGb(subscription.remainingGb ?? 0)} GB`
}
