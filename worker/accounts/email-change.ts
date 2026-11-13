import { findUserById, setUserEmail } from './d1-repository.js'
import { apiError } from '../platform/api-error.js'
import type { DataEnv } from '../db/module-switch.js'
import {
  issueVerificationCode,
  requireVerificationDb,
  verifyVerificationCode,
  type IssuedVerificationCode,
} from './email-verification.js'
import { normalizeEmail, type AccountUser } from './schema.js'

// Changing the bound email of an account that already has one (batch 7). The
// code goes to the NEW address; confirming swaps the three email columns in
// one write, so the old address stops working for login immediately. Users
// without a bound email use the batch-4 binding flow instead.
export async function requestEmailChange(
  env: DataEnv,
  user: AccountUser,
  rawEmail: string,
  now = new Date(),
): Promise<IssuedVerificationCode> {
  if (!user.emailVerifiedAt) throw apiError(409, 'EMAIL_NOT_BOUND', '账户尚未绑定邮箱，请先完成绑定')
  if (normalizeEmail(rawEmail) === user.emailNormalized) {
    throw apiError(409, 'EMAIL_UNCHANGED', '新邮箱与当前邮箱相同')
  }
  return issueVerificationCode(env, { user, email: rawEmail, purpose: 'change_email' }, now)
}

export async function confirmEmailChange(
  env: DataEnv,
  user: AccountUser,
  code: string,
  now = new Date(),
): Promise<AccountUser> {
  if (!user.emailVerifiedAt) throw apiError(409, 'EMAIL_NOT_BOUND', '账户尚未绑定邮箱，请先完成绑定')
  const db = await requireVerificationDb(env)
  const verified = await verifyVerificationCode(env, { user, purpose: 'change_email', code }, now)
  const nowIso = now.toISOString()
  await setUserEmail(
    db,
    user.id,
    { email: verified.email, emailNormalized: verified.emailNormalized, emailVerifiedAt: nowIso },
    nowIso,
  )
  const updated = await findUserById(db, user.id)
  if (!updated) throw new Error('Accounts snapshot is corrupt')
  return updated
}
