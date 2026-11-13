import { batch, queryFirst, type AppDatabase } from '../db/db.js'
import { apiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import { generateVerificationCode } from './email-binding.js'
import { sendEmailVerificationCode } from './email.js'
import { clearWindowHits, countWindowHits, recordWindowHit } from './rate-limit.js'
import { emailInputSchema, normalizeEmail } from './schema.js'

// Generic email verification-code service (batch 5 contract). Batch 6 ships
// the minimal implementation: codes are 6 digits, stored as SHA-256 token
// hashes in email_verifications, live 10 minutes, lock after 5 wrong
// attempts, and are consumed exactly once. Attempt counting reuses
// rate_limits with the verification row id as subject and the row's creation
// time as the fixed window start, the same scheme as email binding.
//
// verifyVerificationCode validates WITHOUT consuming; the caller consumes
// the row inside its own atomic batch via consumeVerificationStatement so
// code consumption can commit or roll back together with the caller's other
// writes (registration relies on this). Batch 5's full implementation
// replaces this file without changing these signatures.
export type VerificationPurpose = 'register' | 'bind' | 'reset'

const CODE_TTL_MS = 10 * 60 * 1_000
const MAX_CODE_ATTEMPTS = 5

const attemptBucket = (purpose: VerificationPurpose): string => `email_verify_attempt:${purpose}`

export interface IssueVerificationCodeInput {
  email: string
  purpose: VerificationPurpose
  userId?: string | null
  username?: string
}

export interface IssuedVerificationCode {
  email: string
  expiresAt: string
}

interface VerificationRow {
  id: number
  user_id: string | null
  email: string
  email_normalized: string
  token_hash: string
  purpose: string
  expires_at: string
  consumed_at: string | null
  created_at: string
}

const VERIFICATION_COLUMNS =
  'id, user_id, email, email_normalized, token_hash, purpose, expires_at, consumed_at, created_at'

export async function issueVerificationCode(
  db: AppDatabase,
  input: IssueVerificationCodeInput,
  now = new Date(),
): Promise<IssuedVerificationCode> {
  const parsed = emailInputSchema.safeParse(input.email)
  if (!parsed.success) throw apiError(400, 'INVALID_EMAIL', '邮箱格式不正确')
  const email = parsed.data
  const nowIso = now.toISOString()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString()
  const code = generateVerificationCode()
  await batch(db, [
    db
      .prepare('DELETE FROM email_verifications WHERE email_normalized = ? AND purpose = ? AND consumed_at IS NULL')
      .bind(email, input.purpose),
    db
      .prepare(
        `INSERT INTO email_verifications (user_id, email, email_normalized, token_hash, purpose, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(input.userId ?? null, email, email, await hashToken(code), input.purpose, expiresAt, nowIso),
  ])
  await sendEmailVerificationCode({ to: email, code, username: input.username ?? '' })
  return { email, expiresAt }
}

export type VerifyVerificationCodeResult =
  | { ok: true; verificationId: number; email: string; emailNormalized: string }
  | { ok: false; reason: 'none' | 'expired' | 'locked' | 'mismatch' }

export async function verifyVerificationCode(
  db: AppDatabase,
  input: { email: string; code: string; purpose: VerificationPurpose },
  now = new Date(),
): Promise<VerifyVerificationCodeResult> {
  const emailNormalized = normalizeEmail(input.email)
  const row = await queryFirst<VerificationRow>(
    db
      .prepare(
        `SELECT ${VERIFICATION_COLUMNS} FROM email_verifications
         WHERE email_normalized = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC`,
      )
      .bind(emailNormalized, input.purpose),
  )
  if (!row) return { ok: false, reason: 'none' }
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired' }

  const bucket = attemptBucket(input.purpose)
  const windowStart = Math.floor(Date.parse(row.created_at) / 1_000)
  const attempts = await countWindowHits(db, bucket, String(row.id), windowStart)
  if (attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'locked' }
  if ((await hashToken(input.code)) !== row.token_hash) {
    await recordWindowHit(db, bucket, String(row.id), windowStart, Math.floor(Date.parse(row.expires_at) / 1_000))
    return { ok: false, reason: 'mismatch' }
  }
  return { ok: true, verificationId: row.id, email: row.email, emailNormalized: row.email_normalized }
}

// Statement that consumes a verified row; include it in the caller's batch
// so consumption shares the caller's transaction.
export function consumeVerificationStatement(
  db: AppDatabase,
  verificationId: number,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare('UPDATE email_verifications SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .bind(nowIso, verificationId)
}

export async function clearVerificationAttempts(
  db: AppDatabase,
  purpose: VerificationPurpose,
  verificationId: number,
): Promise<void> {
  await clearWindowHits(db, attemptBucket(purpose), String(verificationId))
}
