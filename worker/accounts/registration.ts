import { batch, queryFirst, type AppDatabase } from '../db/db.js'
import { ACCOUNTS_SETTING_KEYS, upsertSettingStatement } from '../db/module-switch.js'
import { getRegistrationMode, type RegistrationMode } from '../db/settings-repository.js'
import { apiError } from '../platform/api-error.js'
import { findInviteCodeByCode, type InviteCodeRow } from './invite-codes.js'
import {
  consumeVerificationStatement,
  issueVerificationCode,
  verifyPendingVerification,
} from './email-verification.js'
import { findUserByEmailNormalized, findUserById, findUserByUsername, readAccountsFromD1 } from './d1-repository.js'
import { hashPassword } from './password.js'
import { countWindowHits, recordWindowHit } from './rate-limit.js'
import { accountsUseD1 } from './repository.js'
import { emailInputSchema, normalizeEmail, type AccountUser } from './schema.js'
import type { DataEnv as DbDataEnv } from '../db/module-switch.js'

// Self-service registration (batch 6). Modes live in system_settings
// (`registration_mode`): 'closed' rejects everything, 'invite' requires a
// registration invite code, 'open' needs only an email verification code.
// The global domain whitelist (allowed_email_domains) applies whenever the
// table is non-empty.
const SEND_CODE_LIMIT = 5
const SEND_CODE_WINDOW_SECONDS = 60 * 60
const SEND_CODE_BUCKET = 'register_send'
const INVITE_CODE_FORMAT = /^[A-Za-z0-9_-]{43}$/

async function requireAccountsD1(env: DbDataEnv): Promise<AppDatabase> {
  if (!(await accountsUseD1(env))) {
    throw apiError(409, 'REGISTRATION_UNAVAILABLE', '注册暂不可用')
  }
  return env.DB
}

export async function getPublicRegistrationConfig(env: DbDataEnv): Promise<{ mode: RegistrationMode }> {
  if (!(await accountsUseD1(env))) return { mode: 'closed' }
  return { mode: await getRegistrationMode(env.DB) }
}

export async function listEmailDomains(db: AppDatabase): Promise<string[]> {
  const listed = await db.prepare('SELECT domain FROM allowed_email_domains ORDER BY domain ASC').all<{ domain: string }>()
  return listed.results.map((row) => row.domain)
}

export async function isEmailDomainAllowed(db: AppDatabase, emailNormalized: string): Promise<boolean> {
  const domains = await listEmailDomains(db)
  if (domains.length === 0) return true
  const domain = emailNormalized.slice(emailNormalized.lastIndexOf('@') + 1)
  return domains.includes(domain)
}

const domainSchema = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export async function addEmailDomain(db: AppDatabase, rawDomain: string, now = new Date()): Promise<string> {
  const domain = rawDomain.trim().toLowerCase()
  if (!domainSchema.test(domain)) throw apiError(400, 'INVALID_DOMAIN', '域名格式不正确')
  const existing = await queryFirst<{ domain: string }>(
    db.prepare('SELECT domain FROM allowed_email_domains WHERE domain = ?').bind(domain),
  )
  if (existing) throw apiError(409, 'DOMAIN_EXISTS', '该域名已在白名单中')
  await db.prepare('INSERT INTO allowed_email_domains (domain, created_at) VALUES (?, ?)').bind(domain, now.toISOString()).run()
  return domain
}

export async function removeEmailDomain(db: AppDatabase, rawDomain: string): Promise<void> {
  const domain = rawDomain.trim().toLowerCase()
  const result = await db.prepare('DELETE FROM allowed_email_domains WHERE domain = ?').bind(domain).run()
  if (result.meta.changes === 0) throw apiError(404, 'DOMAIN_NOT_FOUND', '域名不存在')
}

export async function sendRegisterCode(
  env: DbDataEnv,
  rawEmail: string,
  now = new Date(),
): Promise<{ email: string }> {
  const db = await requireAccountsD1(env)
  const mode = await getRegistrationMode(db)
  if (mode === 'closed') throw apiError(403, 'REGISTRATION_CLOSED', '当前未开放注册')
  const parsed = emailInputSchema.safeParse(rawEmail)
  if (!parsed.success) throw apiError(400, 'INVALID_EMAIL', '邮箱格式不正确')
  const email = parsed.data
  if (!(await isEmailDomainAllowed(db, email))) {
    throw apiError(403, 'EMAIL_DOMAIN_NOT_ALLOWED', '该邮箱域名不在允许注册范围内')
  }
  // Anti-enumeration: an already-registered address gets the same response
  // as a fresh one, but no code is issued for it.
  const existing = await findUserByEmailNormalized(db, email)
  if (existing) return { email }

  const windowStart = Math.floor(now.getTime() / 1_000 / SEND_CODE_WINDOW_SECONDS) * SEND_CODE_WINDOW_SECONDS
  const sent = await countWindowHits(db, SEND_CODE_BUCKET, email, windowStart)
  if (sent >= SEND_CODE_LIMIT) throw apiError(429, 'TOO_MANY_ATTEMPTS', '验证码发送过于频繁，请稍后再试')
  await issueVerificationCode(db, { email, purpose: 'register' })
  await recordWindowHit(db, SEND_CODE_BUCKET, email, windowStart, windowStart + SEND_CODE_WINDOW_SECONDS)
  return { email }
}

export interface RegisterInput {
  username: string
  password: string
  email: string
  code: string
  inviteCode?: string
}

function assertInviteUsable(invite: InviteCodeRow, nowIso: string): void {
  if (invite.disabled === 1) throw apiError(409, 'INVITE_CODE_DISABLED', '邀请码已停用')
  if (invite.expires_at !== null && Date.parse(invite.expires_at) <= Date.parse(nowIso)) {
    throw apiError(410, 'INVITE_CODE_EXPIRED', '邀请码已过期')
  }
  if (invite.max_uses !== null && invite.used_count >= invite.max_uses) {
    throw apiError(409, 'INVITE_CODE_EXHAUSTED', '邀请码已用完')
  }
}

export async function registerUser(
  env: DbDataEnv,
  input: RegisterInput,
  now = new Date(),
): Promise<AccountUser> {
  const db = await requireAccountsD1(env)
  const mode = await getRegistrationMode(db)
  if (mode === 'closed') throw apiError(403, 'REGISTRATION_CLOSED', '当前未开放注册')
  const nowIso = now.toISOString()
  const email = normalizeEmail(input.email)

  if (!(await isEmailDomainAllowed(db, email))) {
    throw apiError(403, 'EMAIL_DOMAIN_NOT_ALLOWED', '该邮箱域名不在允许注册范围内')
  }
  // Advisory uniqueness checks for clear messages; the database unique
  // indexes are the actual guard inside the atomic batch below.
  if (await findUserByUsername(db, input.username)) {
    throw apiError(409, 'USERNAME_TAKEN', '用户名已存在')
  }
  if (await findUserByEmailNormalized(db, email)) {
    throw apiError(409, 'EMAIL_TAKEN', '该邮箱已被注册')
  }

  const verification = await verifyPendingVerification(db, { email, purpose: 'register', code: input.code })
  if (!verification.ok) {
    if (verification.reason === 'none') throw apiError(400, 'NO_PENDING_CODE', '请先获取验证码')
    if (verification.reason === 'expired') throw apiError(410, 'CODE_EXPIRED', '验证码已过期')
    if (verification.reason === 'locked') throw apiError(429, 'TOO_MANY_ATTEMPTS', '验证码尝试次数过多，请重新获取')
    throw apiError(401, 'INVALID_CODE', '验证码错误')
  }

  let invite: InviteCodeRow | null = null
  if (mode === 'invite' || (input.inviteCode !== undefined && input.inviteCode !== '')) {
    if (!input.inviteCode) throw apiError(400, 'INVITE_CODE_REQUIRED', '请输入邀请码')
    if (!INVITE_CODE_FORMAT.test(input.inviteCode)) throw apiError(400, 'INVALID_INVITE_CODE', '邀请码无效')
    invite = await findInviteCodeByCode(db, input.inviteCode)
    if (!invite) throw apiError(400, 'INVALID_INVITE_CODE', '邀请码无效')
    assertInviteUsable(invite, nowIso)
  }

  const snapshot = await readAccountsFromD1(db)
  const userId = `usr_${snapshot.nextUserId}`
  const password = await hashPassword(input.password)

  // Atomic registration: one D1 batch, all-or-nothing.
  //  S1 consumes the email verification code (conditional on unconsumed).
  //  S2 consumes one invite use (conditional UPDATE: disabled / expiry /
  //     max-uses are re-checked by the WHERE clause, so concurrent batches
  //     cannot overspend a code).
  //  S3 inserts the user only when the previous statement changed a row
  //     (changes() = the consumption guard) AND the verification row shows
  //     this batch's own consumption timestamp; unique indexes on username
  //     and email_normalized reject duplicates and fail the whole batch.
  //  S4 records the redemption, guarded by changes() of S3 so it is written
  //     only when this batch inserted the user.
  //  S5 advances the accounts metadata (next user id / revision).
  const statements: D1PreparedStatement[] = []
  statements.push(consumeVerificationStatement(db, verification.verification.id, nowIso))
  if (invite) {
    statements.push(
      db
        .prepare(
          `UPDATE invite_codes SET used_count = used_count + 1
           WHERE id = ? AND disabled = 0
             AND (expires_at IS NULL OR expires_at > ?)
             AND (max_uses IS NULL OR used_count < max_uses)`,
        )
        .bind(invite.id, nowIso),
    )
  }
  const userInsertIndex = statements.length
  statements.push(
    db
      .prepare(
        `INSERT INTO users (
           id, username, role, enabled, password_algorithm, password_iterations,
           password_salt, password_hash, session_version, email, email_normalized,
           email_verified_at, created_at, updated_at
         )
         SELECT ?, ?, 'user', 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?
         WHERE (SELECT changes()) = 1
           AND EXISTS (SELECT 1 FROM email_verifications WHERE id = ? AND consumed_at = ?)`,
      )
      .bind(
        userId,
        input.username,
        password.algorithm,
        password.iterations,
        password.salt,
        password.hash,
        email,
        email,
        nowIso,
        nowIso,
        nowIso,
        verification.verification.id,
        nowIso,
      ),
  )
  if (invite) {
    // Guarded by changes() of the user insert above: the redemption is only
    // written when this batch actually created the user. An unconditional
    // insert could attach a redemption to the winning request's user (both
    // racers derive the same next user id) and commit it on the losing side.
    statements.push(
      db
        .prepare(
          `INSERT INTO invite_code_redemptions (code_id, user_id, redeemed_at)
           SELECT ?, ?, ?
           WHERE (SELECT changes()) = 1`,
        )
        .bind(invite.id, userId, nowIso),
    )
  }
  statements.push(
    upsertSettingStatement(db, ACCOUNTS_SETTING_KEYS.nextUserId, snapshot.nextUserId + 1, nowIso),
    upsertSettingStatement(db, ACCOUNTS_SETTING_KEYS.revision, snapshot.revision + 1, nowIso),
    upsertSettingStatement(db, ACCOUNTS_SETTING_KEYS.updatedAt, nowIso, nowIso),
  )

  let results: D1Result[]
  try {
    results = await batch(db, statements)
  } catch (error) {
    // A statement failed and the batch rolled back: report the most specific
    // cause instead of a bare 500.
    if (invite) {
      const fresh = await findInviteCodeByCode(db, input.inviteCode as string)
      if (fresh) assertInviteUsable(fresh, nowIso)
    }
    if (await findUserByUsername(db, input.username)) {
      throw apiError(409, 'USERNAME_TAKEN', '用户名已存在')
    }
    if (await findUserByEmailNormalized(db, email)) {
      throw apiError(409, 'EMAIL_TAKEN', '该邮箱已被注册')
    }
    throw error
  }
  if (results[userInsertIndex].meta.changes !== 1) {
    if (invite) {
      const fresh = await findInviteCodeByCode(db, input.inviteCode as string)
      if (fresh) assertInviteUsable(fresh, nowIso)
    }
    throw apiError(401, 'INVALID_CODE', '验证码无效')
  }

  const created = await findUserById(db, userId)
  if (!created) throw new Error('Registered user could not be read back')
  return created
}
