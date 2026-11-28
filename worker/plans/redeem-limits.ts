import { windowStartFor } from '../accounts/rate-limit.js'
import { apiError } from '../platform/api-error.js'
import { sha256Base64Url } from '../platform/hash.js'

type Rule = [bucket: string, subject: string, limit: number, seconds: number]

export const planRedeemLimits = {
  user: 30,
  userWindow: 600,
  generation: 30,
  generationWindow: 3600,
  quantity: 100,
} as const

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

const failures: Rule = ['plan_redeem_failure', 'global', 300, 60]

export async function limitPlanRedeem(db: D1Database, user: string, address: string | undefined, sessionVersion: number) {
  const now = Math.floor(Date.now() / 1000)
  const [bucket, subject, limit, seconds] = failures
  const source = await sha256Base64Url(address ? `ip:${address}` : `session:${user}:${sessionVersion}`)
  const [userHit, sourceHit, globalHit, failureCount] = await db.batch<{ count?: number }>([
    consume(db, ['plan_redeem_user', user, planRedeemLimits.user, planRedeemLimits.userWindow], now),
    consume(db, ['plan_redeem_source', source, 80, 600], now),
    consume(db, ['plan_redeem_attempt', 'global', 1200, 60], now),
    db.prepare('SELECT count FROM rate_limits WHERE bucket=? AND subject=? AND window_start=?')
      .bind(bucket, subject, windowStartFor(now, seconds)),
  ])
  if ([userHit, sourceHit, globalHit].some(result => result.meta.changes !== 1)
    || (Number(failureCount.results[0]?.count) >= limit)) throw limited()
  if (crypto.getRandomValues(new Uint8Array(1))[0] === 0) {
    await db.prepare(`DELETE FROM rate_limits WHERE rowid IN (
      SELECT rowid FROM rate_limits WHERE expires_at < ? AND bucket GLOB 'plan_redeem_*' LIMIT 512
    )`).bind(now - 3600).run()
  }
}

export async function recordPlanRedeemFailure(db: D1Database) {
  await consume(db, failures, Math.floor(Date.now() / 1000)).run()
}

export async function limitPlanCodeGeneration(db: D1Database, actor: string) {
  const result = await consume(db, ['plan_redeem_generation', actor, planRedeemLimits.generation, planRedeemLimits.generationWindow],
    Math.floor(Date.now() / 1000)).run()
  if (result.meta.changes !== 1) throw limited()
}
