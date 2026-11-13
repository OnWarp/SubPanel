import { queryFirst, type AppDatabase } from '../db/db.js'

// Fixed-window counters on the shared rate_limits table (docs/d1/SCHEMA.md:
// bucket is reusable across features). A missing table is treated as "no
// limit recorded", mirroring isModuleReady's tolerance for unprepared D1.

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message)
}

export const windowStartFor = (nowSeconds: number, windowSeconds: number): number =>
  Math.floor(nowSeconds / windowSeconds) * windowSeconds

export async function countWindowHits(
  db: AppDatabase,
  bucket: string,
  subject: string,
  windowStart: number,
): Promise<number> {
  try {
    const row = await queryFirst<{ count: number }>(
      db
        .prepare('SELECT count FROM rate_limits WHERE bucket = ? AND subject = ? AND window_start = ?')
        .bind(bucket, subject, windowStart),
    )
    return row?.count ?? 0
  } catch (error) {
    if (missingTable(error)) return 0
    throw error
  }
}

export async function recordWindowHit(
  db: AppDatabase,
  bucket: string,
  subject: string,
  windowStart: number,
  expiresAt: number,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count = count + 1`,
      )
      .bind(bucket, subject, windowStart, expiresAt)
      .run()
  } catch (error) {
    if (missingTable(error)) return
    throw error
  }
}

export async function clearWindowHits(db: AppDatabase, bucket: string, subject: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM rate_limits WHERE bucket = ? AND subject = ?').bind(bucket, subject).run()
  } catch (error) {
    if (missingTable(error)) return
    throw error
  }
}

// Login throttling (D1 mode only; KV mode keeps the previous behaviour of
// no login limiter). Failed attempts count against both the account
// (identifier) and the source address; a successful login clears the
// account counter.
export const LOGIN_ACCOUNT_LIMIT = { bucket: 'login_account', limit: 10, windowSeconds: 15 * 60 } as const
export const LOGIN_SOURCE_LIMIT = { bucket: 'login_source', limit: 30, windowSeconds: 15 * 60 } as const

export async function loginRateLimited(
  db: AppDatabase,
  identifierKey: string,
  sourceKey: string,
  nowSeconds: number,
): Promise<boolean> {
  const accountHits = await countWindowHits(
    db,
    LOGIN_ACCOUNT_LIMIT.bucket,
    identifierKey,
    windowStartFor(nowSeconds, LOGIN_ACCOUNT_LIMIT.windowSeconds),
  )
  if (accountHits >= LOGIN_ACCOUNT_LIMIT.limit) return true
  const sourceHits = await countWindowHits(
    db,
    LOGIN_SOURCE_LIMIT.bucket,
    sourceKey,
    windowStartFor(nowSeconds, LOGIN_SOURCE_LIMIT.windowSeconds),
  )
  return sourceHits >= LOGIN_SOURCE_LIMIT.limit
}

export async function recordLoginFailure(
  db: AppDatabase,
  identifierKey: string,
  sourceKey: string,
  nowSeconds: number,
): Promise<void> {
  for (const rule of [LOGIN_ACCOUNT_LIMIT, LOGIN_SOURCE_LIMIT]) {
    const windowStart = windowStartFor(nowSeconds, rule.windowSeconds)
    const subject = rule === LOGIN_ACCOUNT_LIMIT ? identifierKey : sourceKey
    await recordWindowHit(db, rule.bucket, subject, windowStart, windowStart + rule.windowSeconds)
  }
}

export async function clearLoginFailures(db: AppDatabase, identifierKey: string): Promise<void> {
  await clearWindowHits(db, LOGIN_ACCOUNT_LIMIT.bucket, identifierKey)
}
