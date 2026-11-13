import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveMailConfig,
  sendEmailVerificationCode,
  sendMail,
  setEmailVerificationDeliverer,
  type EmailVerificationMessage,
} from '../../../worker/accounts/email'
import {
  findPendingVerification,
  issueVerificationCode,
  setVerificationCodeSecret,
  verifyVerificationCode,
} from '../../../worker/accounts/email-verification'
import { hashPassword } from '../../../worker/accounts/password'
import { readAccounts, writeAccounts } from '../../../worker/accounts/repository'
import type { AccountUser } from '../../../worker/accounts/schema'
import { setUserEmail } from '../../../worker/accounts/d1-repository'
import { ACCOUNTS_D1_READY_KEY, markModuleReady } from '../../../worker/db/module-switch'
import { putSetting } from '../../../worker/db/settings-repository'
import { hashToken } from '../../../worker/platform/crypto'
import { applyMigrations, baseInitMigration, emailVerificationPurposeMigration, emptyDatabase } from './d1'
import { jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const NOW = '2026-01-01T00:00:00.000Z'
const captured: EmailVerificationMessage[] = []

beforeEach(async () => {
  captured.length = 0
  setEmailVerificationDeliverer(async (message) => {
    captured.push(message)
  })
  setVerificationCodeSecret(null)
  await resetData()
  await emptyDatabase(env.DB)
  await applyMigrations(env.DB)
  await markModuleReady(env.DB, ACCOUNTS_D1_READY_KEY)
})

afterEach(() => {
  vi.unstubAllGlobals()
  const mutable = env as unknown as Record<string, unknown>
  delete mutable.RESEND_API_KEY
  delete mutable.SMTP_URL
  delete mutable.MAIL_FROM
})

async function createAccountUser(
  username: string,
  password: string,
  email?: { address: string; verified: boolean },
): Promise<AccountUser> {
  const accounts = await readAccounts(env)
  const user: AccountUser = {
    id: `usr_${accounts.nextUserId}`,
    username,
    password: await hashPassword(password),
    role: 'user',
    enabled: true,
    sessionVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
  await writeAccounts(
    env,
    { ...accounts, users: [...accounts.users, user], nextUserId: accounts.nextUserId + 1 },
    NOW,
  )
  if (!email) return user
  // The accounts snapshot upsert deliberately never writes the email
  // columns; binding goes through setUserEmail like the production flow.
  const bound = {
    email: email.address,
    emailNormalized: email.address,
    emailVerifiedAt: email.verified ? NOW : null,
  }
  await setUserEmail(env.DB, user.id, bound, NOW)
  return { ...user, ...bound }
}

const otherCode = (code: string): string => (code === '000000' ? '111111' : '000000')

describe('verification code service', () => {
  beforeEach(async () => {
    await setupAdmin()
  })

  it('issues a code and verifies it exactly once', async () => {
    const user = await createAccountUser('binder', 'binder-password-1')
    const { expiresAt } = await issueVerificationCode(env.DB, {
      email: 'Binder@Example.com',
      purpose: 'bind_email',
      userId: user.id,
    })
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ to: 'binder@example.com', purpose: 'bind_email', username: 'binder' })
    const code = captured[0].code
    expect(code).toMatch(/^\d{6}$/)

    await expect(
      verifyVerificationCode(env.DB, { email: 'binder@example.com', purpose: 'bind_email', code }),
    ).resolves.toBe(true)
    await expect(
      verifyVerificationCode(env.DB, { email: 'binder@example.com', purpose: 'bind_email', code }),
    ).resolves.toBe(false)
    const row = await env.DB.prepare('SELECT consumed_at FROM email_verifications').first<{ consumed_at: string }>()
    expect(row?.consumed_at).not.toBeNull()
  })

  it('rejects a wrong code but keeps the right one usable', async () => {
    await issueVerificationCode(env.DB, { email: 'a@example.com', purpose: 'register' })
    const code = captured[0].code
    await expect(
      verifyVerificationCode(env.DB, { email: 'a@example.com', purpose: 'register', code: otherCode(code) }),
    ).resolves.toBe(false)
    await expect(
      verifyVerificationCode(env.DB, { email: 'a@example.com', purpose: 'register', code }),
    ).resolves.toBe(true)
  })

  it('locks the code after five wrong attempts, even for the right code', async () => {
    await issueVerificationCode(env.DB, { email: 'b@example.com', purpose: 'reset_password' })
    const code = captured[0].code
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        verifyVerificationCode(env.DB, { email: 'b@example.com', purpose: 'reset_password', code: otherCode(code) }),
      ).resolves.toBe(false)
    }
    await expect(
      verifyVerificationCode(env.DB, { email: 'b@example.com', purpose: 'reset_password', code }),
    ).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_ATTEMPTS' })
  })

  it('stops verifying once the code expires', async () => {
    await issueVerificationCode(env.DB, { email: 'c@example.com', purpose: 'register' })
    const code = captured[0].code
    await env.DB.prepare("UPDATE email_verifications SET expires_at = '2000-01-01T00:00:00.000Z'").run()
    await expect(
      verifyVerificationCode(env.DB, { email: 'c@example.com', purpose: 'register', code }),
    ).resolves.toBe(false)
    const pending = await findPendingVerification(env.DB, { email: 'c@example.com', purpose: 'register' })
    expect(pending?.expiresAt).toBe('2000-01-01T00:00:00.000Z')
  })

  it('enforces the resend cooldown while a code is live', async () => {
    await issueVerificationCode(env.DB, { email: 'd@example.com', purpose: 'register' })
    await expect(issueVerificationCode(env.DB, { email: 'd@example.com', purpose: 'register' })).rejects.toMatchObject(
      { status: 429, code: 'CODE_TOO_SOON' },
    )
    expect(captured).toHaveLength(1)
  })

  it('replaces the previous code when a new one is issued', async () => {
    await issueVerificationCode(env.DB, { email: 'e@example.com', purpose: 'change_email' })
    await env.DB.prepare("UPDATE email_verifications SET created_at = '2000-01-01T00:00:00.000Z'").run()
    await issueVerificationCode(env.DB, { email: 'e@example.com', purpose: 'change_email' })
    expect(captured).toHaveLength(2)
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM email_verifications WHERE consumed_at IS NULL',
    ).first<{ count: number }>()
    expect(rows?.count).toBe(1)
    await expect(
      verifyVerificationCode(env.DB, { email: 'e@example.com', purpose: 'change_email', code: captured[1].code }),
    ).resolves.toBe(true)
  })

  it('scopes codes by purpose', async () => {
    await issueVerificationCode(env.DB, { email: 'f@example.com', purpose: 'register' })
    const code = captured[0].code
    await expect(
      verifyVerificationCode(env.DB, { email: 'f@example.com', purpose: 'reset_password', code }),
    ).resolves.toBe(false)
    await expect(
      verifyVerificationCode(env.DB, { email: 'f@example.com', purpose: 'register', code }),
    ).resolves.toBe(true)
  })

  it('stores HMAC hashes and allows register codes without a user', async () => {
    await issueVerificationCode(env.DB, { email: 'g@example.com', purpose: 'register' })
    const code = captured[0].code
    const row = await env.DB.prepare('SELECT user_id, token_hash FROM email_verifications').first<{
      user_id: string | null
      token_hash: string
    }>()
    expect(row?.user_id).toBeNull()
    expect(row?.token_hash).not.toBe(code)
    // The batch-4 plain SHA-256 storage must be gone.
    expect(row?.token_hash).not.toBe(await hashToken(code))
  })

  it('upgrades batch-4 rows through 0002, defaulting purpose to bind_email', async () => {
    await emptyDatabase(env.DB)
    await applyD1Migrations(env.DB, [baseInitMigration])
    await env.DB.prepare(
      `INSERT INTO users (
        id, username, role, enabled,
        password_algorithm, password_iterations, password_salt, password_hash,
        session_version, created_at, updated_at
      ) VALUES ('usr_1', 'legacy', 'user', 1, 'PBKDF2-SHA-256', 1000, 'salt-value-0123456789ab', 'hash-value', 0, ?, ?)`,
    ).bind(NOW, NOW).run()
    await env.DB.prepare(
      `INSERT INTO email_verifications (user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at)
       VALUES ('usr_1', 'legacy@example.com', 'legacy@example.com', 'legacy-hash', '2027-01-01T00:00:00.000Z', NULL, ?)`,
    ).bind(NOW).run()

    await applyD1Migrations(env.DB, [emailVerificationPurposeMigration])
    const row = await env.DB.prepare('SELECT purpose, token_hash FROM email_verifications').first<{
      purpose: string
      token_hash: string
    }>()
    expect(row).toEqual({ purpose: 'bind_email', token_hash: 'legacy-hash' })
  })
})

describe('mail configuration', () => {
  const message = { to: 'someone@example.com', subject: 'Hi', text: 'text', html: '<p>text</p>' }

  it('treats a missing configuration as a no-op instead of throwing', async () => {
    setEmailVerificationDeliverer(null)
    await expect(sendMail(message)).resolves.toEqual({ ok: false, provider: null, error: '邮件服务未配置' })
    await expect(
      sendEmailVerificationCode({ to: 'someone@example.com', code: '123456' }),
    ).resolves.toBeUndefined()
    await expect(resolveMailConfig()).resolves.toBeNull()
  })

  it('prefers the SMTP_URL secret over settings', async () => {
    const mutable = env as unknown as Record<string, unknown>
    mutable.SMTP_URL = 'smtps://user:pass@smtp.example.com'
    mutable.MAIL_FROM = 'noreply@example.com'
    await putSetting(env.DB, 'mail_provider', 'resend', NOW)
    await expect(resolveMailConfig()).resolves.toEqual({
      provider: 'smtp',
      from: 'noreply@example.com',
      smtp: { host: 'smtp.example.com', port: 465, user: 'user', pass: 'pass', secure: true },
    })
  })

  it('falls back to system_settings for SMTP', async () => {
    await putSetting(env.DB, 'mail_provider', 'smtp', NOW)
    await putSetting(env.DB, 'mail_from', 'noreply@example.com', NOW)
    await putSetting(env.DB, 'mail_smtp_host', 'mail.example.com', NOW)
    await putSetting(env.DB, 'mail_smtp_port', '2525', NOW)
    await expect(resolveMailConfig()).resolves.toEqual({
      provider: 'smtp',
      from: 'noreply@example.com',
      smtp: { host: 'mail.example.com', port: 2525, user: undefined, pass: undefined, secure: false },
    })
  })

  it('resolves Resend from system_settings', async () => {
    await putSetting(env.DB, 'mail_provider', 'resend', NOW)
    await putSetting(env.DB, 'mail_from', 'noreply@example.com', NOW)
    await putSetting(env.DB, 'mail_resend_api_key', 're_test_key', NOW)
    await expect(resolveMailConfig()).resolves.toEqual({
      provider: 'resend',
      apiKey: 're_test_key',
      from: 'noreply@example.com',
    })
  })

  it('rejects an out-of-range SMTP port in settings', async () => {
    await putSetting(env.DB, 'mail_provider', 'smtp', NOW)
    await putSetting(env.DB, 'mail_from', 'noreply@example.com', NOW)
    await putSetting(env.DB, 'mail_smtp_host', 'mail.example.com', NOW)
    await putSetting(env.DB, 'mail_smtp_port', '70000', NOW)
    await expect(resolveMailConfig()).resolves.toBeNull()
  })

  it('sends through Resend when the secret is configured', async () => {
    const mutable = env as unknown as Record<string, unknown>
    mutable.RESEND_API_KEY = 're_secret'
    mutable.MAIL_FROM = 'noreply@example.com'
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response('{}', { status: 200 })
      }),
    )
    await expect(sendMail(message)).resolves.toEqual({ ok: true, provider: 'resend' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer re_secret')
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      from: 'noreply@example.com',
      to: 'someone@example.com',
      subject: 'Hi',
    })
  })
})

describe('password recovery endpoints', () => {
  beforeEach(async () => {
    await setupAdmin()
    await createAccountUser('member', 'old-password-1', { address: 'member@example.com', verified: true })
  })

  it('answers forgot identically for unknown mailboxes and sends nothing', async () => {
    const response = await SELF.fetch(
      `${TEST_ORIGIN}/api/password/forgot`,
      jsonRequest({ email: 'ghost@example.com' }),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(captured).toHaveLength(0)
  })

  it('resets the password with a code and invalidates the old session', async () => {
    const oldCookie = await login('member', 'old-password-1')

    const forgot = await SELF.fetch(
      `${TEST_ORIGIN}/api/password/forgot`,
      jsonRequest({ email: 'member@example.com' }),
    )
    expect(forgot.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ to: 'member@example.com', purpose: 'reset_password' })
    const code = captured[0].code

    const wrong = await SELF.fetch(
      `${TEST_ORIGIN}/api/password/reset`,
      jsonRequest({ email: 'member@example.com', code: otherCode(code), newPassword: 'new-password-2' }),
    )
    expect(wrong.status).toBe(401)

    const reset = await SELF.fetch(
      `${TEST_ORIGIN}/api/password/reset`,
      jsonRequest({ email: 'member@example.com', code, newPassword: 'new-password-2' }),
    )
    expect(reset.status).toBe(200)

    const stale = await SELF.fetch(`${TEST_ORIGIN}/api/account/me`, withCookie(oldCookie))
    expect(stale.status).toBe(401)

    const oldLogin = await SELF.fetch(
      `${TEST_ORIGIN}/api/login`,
      jsonRequest({ username: 'member', password: 'old-password-1' }),
    )
    expect(oldLogin.status).toBe(401)
    const newLogin = await SELF.fetch(
      `${TEST_ORIGIN}/api/login`,
      jsonRequest({ username: 'member', password: 'new-password-2' }),
    )
    expect(newLogin.status).toBe(200)
  })

  it('reports an expired reset code', async () => {
    await SELF.fetch(`${TEST_ORIGIN}/api/password/forgot`, jsonRequest({ email: 'member@example.com' }))
    const code = captured[0].code
    await env.DB.prepare("UPDATE email_verifications SET expires_at = '2000-01-01T00:00:00.000Z'").run()
    const reset = await SELF.fetch(
      `${TEST_ORIGIN}/api/password/reset`,
      jsonRequest({ email: 'member@example.com', code, newPassword: 'new-password-2' }),
    )
    expect(reset.status).toBe(410)
  })

  it('stays inert before the accounts D1 switch', async () => {
    await env.DB.prepare('DELETE FROM system_settings WHERE key = ?').bind(ACCOUNTS_D1_READY_KEY).run()
    const forgot = await SELF.fetch(
      `${TEST_ORIGIN}/api/password/forgot`,
      jsonRequest({ email: 'member@example.com' }),
    )
    expect(forgot.status).toBe(200)
    expect(captured).toHaveLength(0)
    const reset = await SELF.fetch(
      `${TEST_ORIGIN}/api/password/reset`,
      jsonRequest({ email: 'member@example.com', code: '123456', newPassword: 'new-password-2' }),
    )
    expect(reset.status).toBe(409)
  })
})

describe('admin mail test endpoint', () => {
  beforeEach(async () => {
    await setupAdmin()
  })

  it('requires an authenticated admin', async () => {
    const anonymous = await SELF.fetch(
      `${TEST_ORIGIN}/api/admin/mail/test`,
      jsonRequest({ email: 'someone@example.com' }),
    )
    expect(anonymous.status).toBe(401)

    await createAccountUser('plain', 'plain-password-1')
    const userCookie = await login('plain', 'plain-password-1')
    const forbidden = await SELF.fetch(
      `${TEST_ORIGIN}/api/admin/mail/test`,
      jsonRequest({ email: 'someone@example.com' }, withCookie(userCookie)),
    )
    expect(forbidden.status).toBe(403)
  })

  it('reports the unconfigured state as data', async () => {
    const adminCookie = await login()
    const response = await SELF.fetch(
      `${TEST_ORIGIN}/api/admin/mail/test`,
      jsonRequest({ email: 'someone@example.com' }, withCookie(adminCookie)),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: false, provider: null, error: '邮件服务未配置' })
  })
})
