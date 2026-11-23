import { windowStartFor } from '../accounts/rate-limit.js'
import { hashToken } from '../platform/crypto.js'

export async function allowSubscriptionFetch(db: D1Database, scope: 'address' | 'subscription', subject: string) {
  const limit = scope === 'address' ? 240 : 120
  const bucket = `subscription_${scope}`
  const window = windowStartFor(Math.floor(Date.now() / 1000), 60)
  const key = await hashToken(`${bucket}:${subject}`)
  const row = await db.prepare(`INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count = count + 1
      WHERE count < ?
    RETURNING count`).bind(bucket, key, window, window + 60, limit + 1).first<{ count: number }>()
  if (!row || row.count > limit) {
    if (row) console.warn(JSON.stringify({ event: 'subscription_fetch_rate_limited', scope, limit }))
    return false
  }
  return true
}
