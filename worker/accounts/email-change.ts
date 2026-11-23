import { type AppDatabase } from '../db/db.js'
import { ACCOUNTS_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { findUserById } from './d1-repository.js'
import { sendMail } from './email.js'
import { assertEmailFree } from './email-binding.js'
import {
  findPendingVerification,
  issueVerificationCode,
  verifyPendingVerification,
} from './email-verification.js'
import { normalizeEmail, type AccountUser } from './schema.js'

// Changing the bound email of an account that already has one (batch 7).
// Since batch 5 the codes themselves are issued and verified by the unified
// verification service (worker/accounts/email-verification.ts, purpose
// 'change_email'); this module keeps the change-specific rules, mirroring
// email-binding.ts: the D1 gate, the already-bound requirement, and mailbox
// occupancy. The code goes to the NEW address; confirming swaps the three
// email columns in one write, so the old address stops working for login
// immediately. Users without a bound email use the batch-4 binding flow
// instead.
async function requireD1(env: DataEnv): Promise<AppDatabase> {
  if (!(await isModuleReady(env.DB, ACCOUNTS_D1_READY_KEY))) {
    throw apiError(409, 'EMAIL_CHANGE_UNAVAILABLE', '邮箱更换暂不可用')
  }
  return env.DB
}

export async function requestEmailChange(
  env: DataEnv,
  user: AccountUser,
  rawEmail: string,
): Promise<{ email: string; expiresAt: string }> {
  const db = await requireD1(env)
  if (!user.emailVerifiedAt) throw apiError(409, 'EMAIL_NOT_BOUND', '账户尚未绑定邮箱，请先完成绑定')
  const email = normalizeEmail(rawEmail)
  if (email === user.emailNormalized) {
    throw apiError(409, 'EMAIL_UNCHANGED', '新邮箱与当前邮箱相同')
  }
  await assertEmailFree(db, email, user.id, new Date().toISOString())

  const { expiresAt } = await issueVerificationCode(db, { email, purpose: 'change_email', userId: user.id })
  return { email, expiresAt }
}

export async function confirmEmailChange(
  env: DataEnv,
  user: AccountUser,
  code: string,
): Promise<AccountUser> {
  const db = await requireD1(env)
  if (!user.emailVerifiedAt) throw apiError(409, 'EMAIL_NOT_BOUND', '账户尚未绑定邮箱，请先完成绑定')
  const nowIso = new Date().toISOString()

  const pending = await findPendingVerification(db, { purpose: 'change_email', userId: user.id })
  if (!pending) throw apiError(400, 'NO_PENDING_CHANGE', '请先获取验证码')
  if (Date.parse(pending.expiresAt) <= Date.now()) throw apiError(410, 'CODE_EXPIRED', '验证码已过期')

  const verified = await verifyPendingVerification(db, {
    email: pending.emailNormalized,
    purpose: 'change_email',
    code,
  })
  if (!verified.ok && verified.reason === 'locked') throw apiError(429, 'TOO_MANY_ATTEMPTS', '验证码尝试次数过多，请重新获取')
  if (!verified.ok || verified.verification.id !== pending.id) throw apiError(401, 'INVALID_CODE', '验证码错误')

  await assertEmailFree(db, pending.emailNormalized, user.id, nowIso)
  const results = await db.batch([
    db.prepare(`UPDATE users SET email=?, email_normalized=?, email_verified_at=?,
      updated_at=?, session_version=session_version+1
      WHERE id=? AND session_version=? AND enabled=1 AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM email_verifications
        WHERE id=? AND user_id=? AND consumed_at IS NULL AND expires_at>?)`)
      .bind(pending.email, pending.emailNormalized, nowIso, nowIso, user.id,
        user.sessionVersion, pending.id, user.id, nowIso),
    db.prepare(`UPDATE email_verifications SET consumed_at=?
      WHERE user_id=? AND consumed_at IS NULL AND changes()=1`).bind(nowIso, user.id),
  ])
  if (!results[0].meta.changes) throw apiError(409, 'EMAIL_CHANGE_CONFLICT', '账户已更新，请重新登录')
  if (user.email) {
    await sendMail({ to: user.email, subject: '账户邮箱已更换', text: '您的 SubPanel 账户邮箱已更换。如非本人操作，请联系管理员', html: '<p>您的 SubPanel 账户邮箱已更换。如非本人操作，请联系管理员</p>' })
      .catch(() => console.warn(JSON.stringify({ event: 'email_change_notice_failed' })))
  }
  const updated = await findUserById(db, user.id)
  if (!updated) throw new Error('Accounts snapshot is corrupt')
  return updated
}
