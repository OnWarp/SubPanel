const DAY_MS = 86_400_000

export type SubscriptionDuration = { value: number; unit: 'day' | 'week' | 'month' | 'year' }

export function expiryFromDuration(start: number, { value, unit }: SubscriptionDuration): number {
  if (unit === 'day' || unit === 'week') return start + value * DAY_MS * (unit === 'week' ? 7 : 1)
  const date = new Date(start)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + value * (unit === 'year' ? 12 : 1))
  const lastDay = new Date(date.getTime())
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0)
  date.setUTCDate(Math.min(day, lastDay.getUTCDate()))
  return date.getTime()
}
