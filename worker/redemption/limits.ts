import { windowStartFor } from '../accounts/rate-limit.js'
import { apiError } from '../platform/api-error.js'
import { sha256Base64Url } from '../platform/hash.js'

type Rule = [bucket: string, subject: string, limit: number, seconds: number]

function limited() {
  return apiError(429, 'REDEMPTION_RATE_LIMITED', '操作过于频繁，请稍后重试')
}

function consume(db: D1Database, [bucket, subject, limit, seconds]: Rule, now: number) {
  const start = windowStartFor(now, seconds)
  return db.prepare(`INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count = count + 1 WHERE count < ?`)
    .bind(bucket, subject, start, start + seconds, limit)
}

const failures: Rule = ['redemption_failure', 'global', 300, 60]

export async function limitAttempts(db: D1Database, user: string, address: string | undefined, sessionVersion: number) {
  const now = Math.floor(Date.now() / 1000)
  const [bucket, subject, limit, seconds] = failures
  const source = await sha256Base64Url(address ? `ip:${address}` : `session:${user}:${sessionVersion}`)
  const [userHit, sourceHit, globalHit, failureCount] = await db.batch<{ count?: number }>([
    consume(db, ['redemption_user', user, 20, 600], now),
    consume(db, ['redemption_source', source, 80, 600], now),
    consume(db, ['redemption_attempt', 'global', 1200, 60], now),
    db.prepare('SELECT count FROM rate_limits WHERE bucket=? AND subject=? AND window_start=?')
      .bind(bucket, subject, windowStartFor(now, seconds)),
  ])
  if ([userHit, sourceHit, globalHit].some(result => result.meta.changes !== 1)
    || (Number(failureCount.results[0]?.count) >= limit)) throw limited()

  if (crypto.getRandomValues(new Uint8Array(1))[0] === 0) {
    await db.prepare(`DELETE FROM rate_limits WHERE rowid IN (
      SELECT rowid FROM rate_limits WHERE expires_at < ? AND bucket GLOB 'redemption_*' LIMIT 512
    )`).bind(now - 3600).run()
  }
}

export async function recordFailure(db: D1Database) {
  await consume(db, failures, Math.floor(Date.now() / 1000)).run()
}

export async function limitGeneration(db: D1Database, actor: string) {
  const result = await consume(db, ['redemption_generation', actor, 5, 3600], Math.floor(Date.now() / 1000)).run()
  if (result.meta.changes !== 1) throw limited()
}
