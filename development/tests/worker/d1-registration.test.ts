import { applyD1Migrations } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import registrationSql from '../../../migrations/0005_registration.sql?raw'
import { clearAccountsStorage } from '../../../worker/accounts/d1-repository'
import { setEmailVerificationDeliverer } from '../../../worker/accounts/email'
import { ACCOUNTS_D1_READY_KEY, deleteSettings, markModuleReady } from '../../../worker/db/module-switch'
import { putRegistrationMode, REGISTRATION_MODE_KEY } from '../../../worker/db/settings-repository'
import { emailVerificationPurposeMigration, initMigration, splitSqlStatements } from './d1'
import { jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)

const registrationMigration = {
  name: '0005_registration.sql',
  queries: splitSqlStatements(registrationSql),
}

let sentCodes: Array<{ to: string; code: string }> = []

beforeEach(async () => {
  await resetData()
  await applyD1Migrations(env.DB, [initMigration, emailVerificationPurposeMigration, registrationMigration])
  // Redemptions reference users and invite codes, so they go first.
  await env.DB.prepare('DELETE FROM invite_code_redemptions').run()
  await clearAccountsStorage(env.DB)
  await env.DB.prepare('DELETE FROM invite_codes').run()
  await env.DB.prepare('DELETE FROM allowed_email_domains').run()
  await deleteSettings(env.DB, [REGISTRATION_MODE_KEY])
  await markModuleReady(env.DB, ACCOUNTS_D1_READY_KEY, '1970-01-01T00:00:00.000Z')
  sentCodes = []
  setEmailVerificationDeliverer(async (message) => {
    sentCodes.push({ to: message.to, code: message.code })
  })
})

afterEach(() => {
  setEmailVerificationDeliverer(null)
})

const codeFor = (email: string): string => {
  const sent = sentCodes.filter((entry) => entry.to === email)
  if (sent.length === 0) throw new Error(`No code was sent to ${email}`)
  return sent[sent.length - 1].code
}

const sendCode = (email: string) => fetchApi('/api/register/send-code', jsonRequest({ email }))

const register = (body: Record<string, unknown>) => fetchApi('/api/register', jsonRequest(body))

const adminInvitations = (cookie: string, body: Record<string, unknown>) =>
  fetchApi('/api/admin/invitations', withCookie(cookie, jsonRequest(body)))

const countRows = async (table: string): Promise<number> => {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

const PASSWORD = 'register-pass-123'

describe('registration modes', () => {
  it('defaults to closed and rejects send-code and register', async () => {
    const config = await fetchApi('/api/register/config')
    expect(config.status).toBe(200)
    expect(await config.json()).toEqual({ mode: 'closed' })

    const sent = await sendCode('new@example.com')
    expect(sent.status).toBe(403)
    expect((await sent.json() as { error: { code: string } }).error.code).toBe('REGISTRATION_CLOSED')

    const attempted = await register({
      username: 'newuser',
      password: PASSWORD,
      email: 'new@example.com',
      code: '123456',
    })
    expect(attempted.status).toBe(403)
  })

  it('registers in open mode and the new account can log in by username and by email', async () => {
    await setupAdmin()
    await putRegistrationMode(env.DB, 'open')
    expect((await sendCode('person@example.com')).status).toBe(200)

    const wrong = await register({
      username: 'person',
      password: PASSWORD,
      email: 'person@example.com',
      code: '000000',
    })
    expect(wrong.status).toBe(401)

    const created = await register({
      username: 'person',
      password: PASSWORD,
      email: 'person@example.com',
      code: codeFor('person@example.com'),
    })
    expect(created.status).toBe(201)
    const body = await created.json() as { user: { username: string; role: string; email: string } }
    expect(body.user.username).toBe('person')
    expect(body.user.role).toBe('user')
    expect(body.user.email).toBe('person@example.com')
    expect(created.headers.get('set-cookie')).toContain('subpanel_session=')

    const byUsername = await fetchApi('/api/login', jsonRequest({ username: 'person', password: PASSWORD }))
    expect(byUsername.status).toBe(200)
    const byEmail = await fetchApi('/api/login', jsonRequest({ identifier: 'Person@Example.com', password: PASSWORD }))
    expect(byEmail.status).toBe(200)
  })

  it('rejects duplicate username and duplicate email with clear errors', async () => {
    await setupAdmin()
    await putRegistrationMode(env.DB, 'open')
    await sendCode('first@example.com')
    const first = await register({
      username: 'taken',
      password: PASSWORD,
      email: 'first@example.com',
      code: codeFor('first@example.com'),
    })
    expect(first.status).toBe(201)

    await sendCode('second@example.com')
    const dupeUsername = await register({
      username: 'taken',
      password: PASSWORD,
      email: 'second@example.com',
      code: codeFor('second@example.com'),
    })
    expect(dupeUsername.status).toBe(409)
    expect((await dupeUsername.json() as { error: { code: string } }).error.code).toBe('USERNAME_TAKEN')

    const dupeEmail = await register({
      username: 'another',
      password: PASSWORD,
      email: 'first@example.com',
      code: codeFor('second@example.com'),
    })
    expect(dupeEmail.status).toBe(409)
    expect((await dupeEmail.json() as { error: { code: string } }).error.code).toBe('EMAIL_TAKEN')
  })

  it('does not reveal that an email is already registered when sending a code', async () => {
    await setupAdmin()
    await putRegistrationMode(env.DB, 'open')
    await sendCode('member@example.com')
    await register({
      username: 'member',
      password: PASSWORD,
      email: 'member@example.com',
      code: codeFor('member@example.com'),
    })
    const before = sentCodes.length
    const response = await sendCode('member@example.com')
    expect(response.status).toBe(200)
    expect(sentCodes.length).toBe(before)
  })

  it('rejects an expired verification code', async () => {
    await setupAdmin()
    await putRegistrationMode(env.DB, 'open')
    await sendCode('late@example.com')
    await env.DB
      .prepare("UPDATE email_verifications SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email_normalized = 'late@example.com'")
      .run()
    const attempted = await register({
      username: 'late',
      password: PASSWORD,
      email: 'late@example.com',
      code: codeFor('late@example.com'),
    })
    expect(attempted.status).toBe(410)
  })

  it('locks the code after five wrong attempts', async () => {
    await setupAdmin()
    await putRegistrationMode(env.DB, 'open')
    await sendCode('locked@example.com')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await register({
        username: 'locked',
        password: PASSWORD,
        email: 'locked@example.com',
        code: '000000',
      })
      expect(wrong.status).toBe(401)
    }
    const correct = await register({
      username: 'locked',
      password: PASSWORD,
      email: 'locked@example.com',
      code: codeFor('locked@example.com'),
    })
    expect(correct.status).toBe(429)
  })
})

describe('email domain whitelist', () => {
  it('blocks non-whitelisted domains and is maintained through the admin API', async () => {
    await setupAdmin()
    const adminCookie = await login()
    await putRegistrationMode(env.DB, 'open')

    const added = await fetchApi('/api/admin/email-domains', withCookie(adminCookie, jsonRequest({ domain: 'Example.com' })))
    expect(added.status).toBe(201)
    const duplicate = await fetchApi('/api/admin/email-domains', withCookie(adminCookie, jsonRequest({ domain: 'example.com' })))
    expect(duplicate.status).toBe(409)
    const listed = await fetchApi('/api/admin/email-domains', withCookie(adminCookie))
    expect(await listed.json()).toEqual({ domains: ['example.com'] })

    expect((await sendCode('a@other.org')).status).toBe(403)
    expect((await sendCode('a@example.com')).status).toBe(200)

    const removed = await fetchApi(
      '/api/admin/email-domains/example.com',
      withCookie(adminCookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }),
    )
    expect(removed.status).toBe(204)
    expect((await sendCode('a@other.org')).status).toBe(200)
    const missing = await fetchApi(
      '/api/admin/email-domains/example.com',
      withCookie(adminCookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }),
    )
    expect(missing.status).toBe(404)
  })

  it('rejects whitelist changes from non-admins', async () => {
    await setupAdmin()
    await putRegistrationMode(env.DB, 'open')
    await sendCode('plain@example.com')
    const created = await register({
      username: 'plain',
      password: PASSWORD,
      email: 'plain@example.com',
      code: codeFor('plain@example.com'),
    })
    expect(created.status).toBe(201)
    const userCookie = await login('plain', PASSWORD)
    const attempted = await fetchApi('/api/admin/email-domains', withCookie(userCookie, jsonRequest({ domain: 'x.com' })))
    expect(attempted.status).toBe(403)
    const attemptedCodes = await adminInvitations(userCookie, { type: 'multi' })
    expect(attemptedCodes.status).toBe(403)
  })
})

describe('invitation codes', () => {
  it('requires a code in invite mode and enforces a multi code use limit', async () => {
    await setupAdmin()
    const adminCookie = await login()
    await putRegistrationMode(env.DB, 'invite')

    await sendCode('one@example.com')
    const missing = await register({
      username: 'one',
      password: PASSWORD,
      email: 'one@example.com',
      code: codeFor('one@example.com'),
    })
    expect(missing.status).toBe(400)
    const garbage = await register({
      username: 'one',
      password: PASSWORD,
      email: 'one@example.com',
      code: codeFor('one@example.com'),
      inviteCode: 'not-a-real-code',
    })
    expect(garbage.status).toBe(400)

    const createdResponse = await adminInvitations(adminCookie, { type: 'multi', maxUses: 2 })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { invitations: Array<{ code: string; prefix: string }> }
    const code = created.invitations[0].code
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const listedResponse = await fetchApi('/api/admin/invitations', withCookie(adminCookie))
    const listed = await listedResponse.json() as { invitations: Array<Record<string, unknown>> }
    expect(listed.invitations).toHaveLength(1)
    expect(listed.invitations[0].prefix).toBe(code.slice(0, 8))
    expect(listed.invitations[0].usedCount).toBe(0)
    expect(JSON.stringify(listed)).not.toContain(code)

    for (const [username, email] of [['one', 'one@example.com'], ['two', 'two@example.com']] as const) {
      if (email !== 'one@example.com') await sendCode(email)
      const response = await register({
        username,
        password: PASSWORD,
        email,
        code: codeFor(email),
        inviteCode: code,
      })
      expect(response.status).toBe(201)
    }

    await sendCode('three@example.com')
    const exhausted = await register({
      username: 'three',
      password: PASSWORD,
      email: 'three@example.com',
      code: codeFor('three@example.com'),
      inviteCode: code,
    })
    expect(exhausted.status).toBe(409)
    expect((await exhausted.json() as { error: { code: string } }).error.code).toBe('INVITE_CODE_EXHAUSTED')

    const after = await (await fetchApi('/api/admin/invitations', withCookie(adminCookie))).json() as {
      invitations: Array<{ usedCount: number; remaining: number }>
    }
    expect(after.invitations[0].usedCount).toBe(2)
    expect(after.invitations[0].remaining).toBe(0)
  })

  it('issues batch codes that each work exactly once', async () => {
    await setupAdmin()
    const adminCookie = await login()
    await putRegistrationMode(env.DB, 'invite')

    const createdResponse = await adminInvitations(adminCookie, { type: 'batch', count: 3 })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { invitations: Array<{ code: string; type: string }> }
    expect(created.invitations).toHaveLength(3)
    expect(created.invitations.every((entry) => entry.type === 'single')).toBe(true)

    const code = created.invitations[0].code
    await sendCode('batch1@example.com')
    const first = await register({
      username: 'batch1',
      password: PASSWORD,
      email: 'batch1@example.com',
      code: codeFor('batch1@example.com'),
      inviteCode: code,
    })
    expect(first.status).toBe(201)

    await sendCode('batch2@example.com')
    const reuse = await register({
      username: 'batch2',
      password: PASSWORD,
      email: 'batch2@example.com',
      code: codeFor('batch2@example.com'),
      inviteCode: code,
    })
    expect(reuse.status).toBe(409)
    expect(await countRows('invite_code_redemptions')).toBe(1)
  })

  it('disables a code through DELETE and rejects an expired code', async () => {
    await setupAdmin()
    const adminCookie = await login()
    await putRegistrationMode(env.DB, 'invite')

    const createdResponse = await adminInvitations(adminCookie, { type: 'multi' })
    const created = await createdResponse.json() as { invitations: Array<{ id: string; code: string }> }
    const disabled = await fetchApi(
      `/api/admin/invitations/${created.invitations[0].id}`,
      withCookie(adminCookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }),
    )
    expect(disabled.status).toBe(204)

    await sendCode('late@example.com')
    const blocked = await register({
      username: 'late',
      password: PASSWORD,
      email: 'late@example.com',
      code: codeFor('late@example.com'),
      inviteCode: created.invitations[0].code,
    })
    expect(blocked.status).toBe(409)
    expect((await blocked.json() as { error: { code: string } }).error.code).toBe('INVITE_CODE_DISABLED')

    const expiredResponse = await adminInvitations(adminCookie, {
      type: 'multi',
      expiresAt: '2000-01-01T00:00:00.000Z',
    })
    const expired = await expiredResponse.json() as { invitations: Array<{ code: string }> }
    await sendCode('gone@example.com')
    const expiredAttempt = await register({
      username: 'gone',
      password: PASSWORD,
      email: 'gone@example.com',
      code: codeFor('gone@example.com'),
      inviteCode: expired.invitations[0].code,
    })
    expect(expiredAttempt.status).toBe(410)
  })

  it('creates exactly one account when the same single-use code is submitted concurrently', async () => {
    await setupAdmin()
    const adminCookie = await login()
    await putRegistrationMode(env.DB, 'invite')

    const createdResponse = await adminInvitations(adminCookie, { type: 'batch', count: 1 })
    const created = await createdResponse.json() as { invitations: Array<{ code: string }> }
    const code = created.invitations[0].code

    await sendCode('racer1@example.com')
    await sendCode('racer2@example.com')
    const attempt = (username: string, email: string) => register({
      username,
      password: PASSWORD,
      email,
      code: codeFor(email),
      inviteCode: code,
    })
    const [first, second] = await Promise.all([
      attempt('racer1', 'racer1@example.com'),
      attempt('racer2', 'racer2@example.com'),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses[0]).toBe(201)
    expect(statuses[1]).toBeGreaterThanOrEqual(400)
    expect(await countRows('users')).toBe(2) // admin + exactly one racer
    expect(await countRows('invite_code_redemptions')).toBe(1)
    const inviteRow = await env.DB.prepare('SELECT used_count FROM invite_codes').first<{ used_count: number }>()
    expect(inviteRow?.used_count).toBe(1)
  })

  it('creates exactly one account when the same registration is submitted twice concurrently', async () => {
    await setupAdmin()
    await putRegistrationMode(env.DB, 'invite')
    const adminCookie = await login()
    const createdResponse = await adminInvitations(adminCookie, { type: 'multi', maxUses: 5 })
    const created = await createdResponse.json() as { invitations: Array<{ code: string }> }

    await sendCode('dupe@example.com')
    const payload = {
      username: 'dupe',
      password: PASSWORD,
      email: 'dupe@example.com',
      code: codeFor('dupe@example.com'),
      inviteCode: created.invitations[0].code,
    }
    const [first, second] = await Promise.all([register(payload), register(payload)])
    const statuses = [first.status, second.status].sort()
    expect(statuses[0]).toBe(201)
    expect(statuses[1]).toBeGreaterThanOrEqual(400)
    const userCount = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'dupe'")
      .first<{ count: number }>()
    expect(userCount?.count).toBe(1)
  })
})
