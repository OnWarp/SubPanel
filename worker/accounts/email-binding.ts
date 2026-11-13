import { batch, queryFirst, type AppDatabase } from '../db/db.js'
import { ACCOUNTS_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import { findUserByEmailNormalized, findUserById, setUserEmail } from './d1-repository.js'
import { sendEmailVerificationCode } from './email.js'
import { clearWindowHits, countWindowHits, recordWindowHit } from './rate-limit.js'
import { normalizeEmail, type AccountUser } from './schema.js'

// Binding an email to an existing (email-less) account. Codes live in
// email_verifications as SHA-256 token hashes (the same treatment invite
// tokens get); attempt counting reuses rate_limits with the verification
// row id as subject and the row's creation time as the fixed window start.
const CODE_TTL_MS = 10 * 60 * 1_000
const MAX_CODE_ATTEMPTS = 5
const ATTEMPT_BUCKET = 'email_bind_attempt'

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

export function generateVerificationCode(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return String(value).padStart(6, '0')
}

async function requireD1(env: DataEnv): Promise<AppDatabase> {
  if (!(await isModuleReady(env.DB, ACCOUNTS_D1_READY_KEY))) {
    throw apiError(409, 'EMAIL_BIND_UNAVAILABLE', '邮箱绑定暂不可用')
  }
  return env.DB
}

async function assertEmailFree(db: AppDatabase, emailNormalized: string, userId: string, nowIso: string): Promise<void> {
  const owner = await findUserByEmailNormalized(db, emailNormalized)
  if (owner && owner.id !== userId) throw apiError(409, 'EMAIL_TAKEN', '该邮箱已被使用')
  // An unconsumed, unexpired verification by another account also occupies
  // the address, so two accounts cannot race to bind the same mailbox.
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

export async function requestEmailBind(
  env: DataEnv,
  user: AccountUser,
  rawEmail: string,
  now = new Date(),
): Promise<{ email: string; expiresAt: string }> {
  const db = await requireD1(env)
  if (user.emailVerifiedAt) throw apiError(409, 'EMAIL_ALREADY_BOUND', '账户已绑定邮箱')
  const email = normalizeEmail(rawEmail)
  const nowIso = now.toISOString()
  await assertEmailFree(db, email, user.id, nowIso)

  const code = generateVerificationCode()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString()
  await batch(db, [
    db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL').bind(user.id),
    db
      .prepare(
        `INSERT INTO email_verifications (user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(user.id, email, email, await hashToken(code), expiresAt, nowIso),
  ])
  await sendEmailVerificationCode({ to: email, code, username: user.username })
  return { email, expiresAt }
}

export async function confirmEmailBind(
  env: DataEnv,
  user: AccountUser,
  code: string,
  now = new Date(),
): Promise<AccountUser> {
  const db = await requireD1(env)
  if (user.emailVerifiedAt) throw apiError(409, 'EMAIL_ALREADY_BOUND', '账户已绑定邮箱')
  const nowIso = now.toISOString()
  const row = await queryFirst<VerificationRow>(
    db
      .prepare(
        `SELECT id, user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at
         FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL ORDER BY id DESC`,
      )
      .bind(user.id),
  )
  if (!row) throw apiError(400, 'NO_PENDING_BIND', '请先获取验证码')
  if (Date.parse(row.expires_at) <= now.getTime()) throw apiError(410, 'CODE_EXPIRED', '验证码已过期')

  const windowStart = Math.floor(Date.parse(row.created_at) / 1_000)
  const attempts = await countWindowHits(db, ATTEMPT_BUCKET, String(row.id), windowStart)
  if (attempts >= MAX_CODE_ATTEMPTS) {
    throw apiError(429, 'TOO_MANY_ATTEMPTS', '验证码尝试次数过多，请重新获取')
  }
  if ((await hashToken(code)) !== row.token_hash) {
    await recordWindowHit(db, ATTEMPT_BUCKET, String(row.id), windowStart, Math.floor(Date.parse(row.expires_at) / 1_000))
    throw apiError(401, 'INVALID_CODE', '验证码错误')
  }

  await assertEmailFree(db, row.email_normalized, user.id, nowIso)
  await batch(db, [
    db.prepare('UPDATE email_verifications SET consumed_at = ? WHERE id = ?').bind(nowIso, row.id),
    db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL').bind(user.id),
  ])
  await setUserEmail(db, user.id, {
    email: row.email,
    emailNormalized: row.email_normalized,
    emailVerifiedAt: nowIso,
  }, nowIso)
  await clearWindowHits(db, ATTEMPT_BUCKET, String(row.id))
  const updated = await findUserById(db, user.id)
  if (!updated) throw new Error('Accounts snapshot is corrupt')
  return updated
}
