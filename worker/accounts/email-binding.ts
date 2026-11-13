import { queryFirst, type AppDatabase } from '../db/db.js'
import { ACCOUNTS_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { findUserByEmailNormalized, findUserById, setUserEmail } from './d1-repository.js'
import { findPendingVerification, issueVerificationCode, verifyVerificationCode } from './email-verification.js'
import { normalizeEmail, type AccountUser } from './schema.js'

// Binding an email to an existing (email-less) account. Since batch 5 the
// codes themselves are issued and verified by the unified verification
// service (worker/accounts/email-verification.ts, purpose 'bind_email');
// this module keeps the binding-specific rules: the D1 gate, the
// already-bound check, and mailbox occupancy (a bound address, or another
// account's pending verification, occupies the address).
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
): Promise<{ email: string; expiresAt: string }> {
  const db = await requireD1(env)
  if (user.emailVerifiedAt) throw apiError(409, 'EMAIL_ALREADY_BOUND', '账户已绑定邮箱')
  const email = normalizeEmail(rawEmail)
  await assertEmailFree(db, email, user.id, new Date().toISOString())

  const { expiresAt } = await issueVerificationCode(db, { email, purpose: 'bind_email', userId: user.id })
  return { email, expiresAt }
}

export async function confirmEmailBind(
  env: DataEnv,
  user: AccountUser,
  code: string,
): Promise<AccountUser> {
  const db = await requireD1(env)
  if (user.emailVerifiedAt) throw apiError(409, 'EMAIL_ALREADY_BOUND', '账户已绑定邮箱')
  const nowIso = new Date().toISOString()

  const pending = await findPendingVerification(db, { purpose: 'bind_email', userId: user.id })
  if (!pending) throw apiError(400, 'NO_PENDING_BIND', '请先获取验证码')
  if (Date.parse(pending.expiresAt) <= Date.now()) throw apiError(410, 'CODE_EXPIRED', '验证码已过期')

  const verified = await verifyVerificationCode(db, {
    email: pending.emailNormalized,
    purpose: 'bind_email',
    code,
  })
  if (!verified) throw apiError(401, 'INVALID_CODE', '验证码错误')

  await assertEmailFree(db, pending.emailNormalized, user.id, nowIso)
  // Drop any other pending verifications of this account; the address is
  // bound now and leftovers must not stay usable.
  await db
    .prepare('DELETE FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL')
    .bind(user.id)
    .run()
  await setUserEmail(db, user.id, {
    email: pending.email,
    emailNormalized: pending.emailNormalized,
    emailVerifiedAt: nowIso,
  }, nowIso)
  const updated = await findUserById(db, user.id)
  if (!updated) throw new Error('Accounts snapshot is corrupt')
  return updated
}
