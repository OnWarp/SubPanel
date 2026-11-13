import { batch, queryFirst, type AppDatabase } from '../db/db.js'
import { ACCOUNTS_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import { findUserByEmailNormalized } from './d1-repository.js'
import { generateVerificationCode } from './email-binding.js'
import { sendEmailVerificationCode } from './email.js'
import { clearWindowHits, countWindowHits, recordWindowHit } from './rate-limit.js'
import { normalizeEmail, type AccountUser } from './schema.js'

// General email verification-code service. This file is the contract surface
// batch 5 builds on: issueVerificationCode / verifyVerificationCode, with a
// purpose distinguishing the flows. Batch 4's binding flow predates the
// service and keeps its own implementation in email-binding.ts; the storage
// shape is deliberately identical (codes are SHA-256 token hashes in
// email_verifications, ten-minute expiry, five attempts counted through
// rate_limits), so batch 5 can fold both flows onto this service without a
// data migration.
//
// Purposes share one table with no purpose column. A user can only be in one
// flow at a time — binding requires an unbound account, changing requires a
// bound one — and issuing a code replaces the user's previous unconsumed
// codes, so a lookup by user alone is unambiguous.
export type VerificationPurpose = 'bind_email' | 'change_email'

const CODE_TTL_MS = 10 * 60 * 1_000
const MAX_CODE_ATTEMPTS = 5

const ATTEMPT_BUCKETS: Record<VerificationPurpose, string> = {
  bind_email: 'email_bind_attempt',
  change_email: 'email_change_attempt',
}

interface VerificationRow {
  id: number
  user_id: string
  email: string
  email_normalized: string
  token_hash: string
  expires_at: string
  consumed_at: string | null
  created_at: string
}

export async function requireVerificationDb(env: DataEnv): Promise<AppDatabase> {
  if (!(await isModuleReady(env.DB, ACCOUNTS_D1_READY_KEY))) {
    throw apiError(409, 'EMAIL_VERIFICATION_UNAVAILABLE', '邮箱验证暂不可用')
  }
  return env.DB
}

// An address is occupied when another account owns it, or when another
// account holds an unconsumed, unexpired code for it; the second clause
// stops two accounts racing to claim the same mailbox.
export async function assertEmailFree(
  db: AppDatabase,
  emailNormalized: string,
  userId: string,
  nowIso: string,
): Promise<void> {
  const owner = await findUserByEmailNormalized(db, emailNormalized)
  if (owner && owner.id !== userId) throw apiError(409, 'EMAIL_TAKEN', '该邮箱已被使用')
  const pending = await queryFirst<{ id: number }>(
    db
      .prepare(
        `SELECT id FROM email_verifications
         WHERE email_normalized = ? AND user_id != ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .bind(emailNormalized, userId, nowIso),
  )
  if (pending) throw apiError(409, 'EMAIL_TAKEN', '该邮箱已被使用')
}

export interface IssueVerificationCodeInput {
  user: AccountUser
  email: string
  purpose: VerificationPurpose
}

export interface IssuedVerificationCode {
  email: string
  expiresAt: string
}

export async function issueVerificationCode(
  env: DataEnv,
  input: IssueVerificationCodeInput,
  now = new Date(),
): Promise<IssuedVerificationCode> {
  const db = await requireVerificationDb(env)
  const email = normalizeEmail(input.email)
  const nowIso = now.toISOString()
  await assertEmailFree(db, email, input.user.id, nowIso)

  const code = generateVerificationCode()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString()
  await batch(db, [
    db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL').bind(input.user.id),
    db
      .prepare(
        `INSERT INTO email_verifications (user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(input.user.id, email, email, await hashToken(code), expiresAt, nowIso),
  ])
  await sendEmailVerificationCode({ to: email, code, username: input.user.username })
  return { email, expiresAt }
}

export interface VerifyVerificationCodeInput {
  user: AccountUser
  purpose: VerificationPurpose
  code: string
}

export interface VerifiedEmail {
  email: string
  emailNormalized: string
}

export async function verifyVerificationCode(
  env: DataEnv,
  input: VerifyVerificationCodeInput,
  now = new Date(),
): Promise<VerifiedEmail> {
  const db = await requireVerificationDb(env)
  const nowIso = now.toISOString()
  const row = await queryFirst<VerificationRow>(
    db
      .prepare(
        `SELECT id, user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at
         FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL ORDER BY id DESC`,
      )
      .bind(input.user.id),
  )
  if (!row) throw apiError(400, 'NO_PENDING_CODE', '请先获取验证码')
  if (Date.parse(row.expires_at) <= now.getTime()) throw apiError(410, 'CODE_EXPIRED', '验证码已过期')

  const bucket = ATTEMPT_BUCKETS[input.purpose]
  const windowStart = Math.floor(Date.parse(row.created_at) / 1_000)
  const attempts = await countWindowHits(db, bucket, String(row.id), windowStart)
  if (attempts >= MAX_CODE_ATTEMPTS) {
    throw apiError(429, 'TOO_MANY_ATTEMPTS', '验证码尝试次数过多，请重新获取')
  }
  if ((await hashToken(input.code)) !== row.token_hash) {
    await recordWindowHit(db, bucket, String(row.id), windowStart, Math.floor(Date.parse(row.expires_at) / 1_000))
    throw apiError(401, 'INVALID_CODE', '验证码错误')
  }

  await assertEmailFree(db, row.email_normalized, input.user.id, nowIso)
  await batch(db, [
    db.prepare('UPDATE email_verifications SET consumed_at = ? WHERE id = ?').bind(nowIso, row.id),
    db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL').bind(input.user.id),
  ])
  await clearWindowHits(db, bucket, String(row.id))
  return { email: row.email, emailNormalized: row.email_normalized }
}
