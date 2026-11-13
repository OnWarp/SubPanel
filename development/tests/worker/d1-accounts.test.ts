import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearAccountsStorage } from '../../../worker/accounts/d1-repository'
import { setEmailVerificationDeliverer } from '../../../worker/accounts/email'
import { hashPassword } from '../../../worker/accounts/password'
import { readAccounts, writeAccounts } from '../../../worker/accounts/repository'
import type { User } from '../../../worker/accounts/schema'
import { ACCOUNTS_D1_READY_KEY, markModuleReady } from '../../../worker/db/module-switch'
import { putSetting } from '../../../worker/db/settings-repository'
import { applyMigrations } from './d1'
import { jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)

const loginResponse = (identifier: { username?: string; identifier?: string }, password: string) =>
  fetchApi('/api/login', jsonRequest({ ...identifier, password }))

const cookieOf = (response: Response): string => {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Response did not return a session cookie')
  return cookie
}

let sentCodes: Array<{ to: string; code: string }> = []

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await clearAccountsStorage(env.DB)
  await markModuleReady(env.DB, ACCOUNTS_D1_READY_KEY, '1970-01-01T00:00:00.000Z')
  sentCodes = []
  setEmailVerificationDeliverer(async (message) => {
    sentCodes.push({ to: message.to, code: message.code })
  })
})

afterEach(() => {
  setEmailVerificationDeliverer(null)
})

async function createUser(username: string, password: string): Promise<User> {
  const accounts = await readAccounts(env)
  const now = new Date().toISOString()
  const user: User = {
    id: `usr_${accounts.nextUserId}`,
    username,
    role: 'user',
    enabled: true,
    password: await hashPassword(password),
    sessionVersion: 0,
    createdAt: now,
    updatedAt: now,
  }
  await writeAccounts(env, {
    ...accounts,
    nextUserId: accounts.nextUserId + 1,
    users: [...accounts.users, user],
  }, now)
  return user
}

async function bindEmail(cookie: string, email: string): Promise<Response> {
  return fetchApi('/api/account/email/bind', withCookie(cookie, jsonRequest({ email })))
}

async function confirmBind(cookie: string, code: string): Promise<Response> {
  return fetchApi('/api/account/email/bind/confirm', withCookie(cookie, jsonRequest({ code })))
}

describe('accounts on D1', () => {
  it('logs in by username and by bound email', async () => {
    await setupAdmin()
    await createUser('alice', 'alice-password-1')
    const cookie = await login('alice', 'alice-password-1')

    const bind = await bindEmail(cookie, ' Alice@Example.com ')
    expect(bind.status).toBe(200)
    expect(sentCodes).toHaveLength(1)
    expect(sentCodes[0].to).toBe('alice@example.com')

    const confirm = await confirmBind(cookie, sentCodes[0].code)
    expect(confirm.status).toBe(200)
    const confirmed = (await confirm.json()) as { user: { email: string | null; emailVerifiedAt: string | null } }
    expect(confirmed.user.email).toBe('alice@example.com')
    expect(confirmed.user.emailVerifiedAt).not.toBeNull()

    expect((await loginResponse({ username: 'alice' }, 'alice-password-1')).status).toBe(200)
    expect((await loginResponse({ identifier: ' Alice@Example.COM' }, 'alice-password-1')).status).toBe(200)
    expect((await loginResponse({ username: 'alice@example.com' }, 'alice-password-1')).status).toBe(200)
  })

  it('rejects wrong passwords and rate limits repeated failures', async () => {
    await setupAdmin()
    await createUser('bob', 'bob-password-123')
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await loginResponse({ username: 'bob' }, 'wrong-password')).status).toBe(401)
    }
    expect((await loginResponse({ username: 'bob' }, 'bob-password-123')).status).toBe(429)
  })

  it('invalidates the old session after a password change', async () => {
    await setupAdmin()
    await createUser('carol', 'carol-password-1')
    const cookie = await login('carol', 'carol-password-1')
    expect((await fetchApi('/api/account', withCookie(cookie))).status).toBe(200)

    const change = await fetchApi(
      '/api/account/password',
      withCookie(cookie, jsonRequest({ currentPassword: 'carol-password-1', newPassword: 'carol-password-2' })),
    )
    expect(change.status).toBe(200)
    const newCookie = cookieOf(change)

    expect((await fetchApi('/api/account', withCookie(cookie))).status).toBe(401)
    expect((await fetchApi('/api/account', withCookie(newCookie))).status).toBe(200)
    expect((await fetchApi('/api/account/logout', withCookie(newCookie, jsonRequest({})))).status).toBe(200)
    expect((await loginResponse({ username: 'carol' }, 'carol-password-2')).status).toBe(200)
  })

  it('rejects wrong and expired codes and duplicate bindings', async () => {
    await setupAdmin()
    const dave = await createUser('dave', 'dave-password-12')
    await createUser('erin', 'erin-password-12')
    const daveCookie = await login('dave', 'dave-password-12')

    expect((await bindEmail(daveCookie, 'dave@example.com')).status).toBe(200)
    const code = sentCodes.at(-1)?.code as string
    const wrong = code === '000000' ? '000001' : '000000'
    expect((await confirmBind(daveCookie, wrong)).status).toBe(401)

    await env.DB
      .prepare('UPDATE email_verifications SET expires_at = ? WHERE user_id = ?')
      .bind('2000-01-01T00:00:00.000Z', dave.id)
      .run()
    expect((await confirmBind(daveCookie, code)).status).toBe(410)

    expect((await bindEmail(daveCookie, 'dave@example.com')).status).toBe(200)
    expect((await confirmBind(daveCookie, sentCodes.at(-1)?.code as string)).status).toBe(200)

    expect((await bindEmail(daveCookie, 'other@example.com')).status).toBe(409)
    const erinCookie = await login('erin', 'erin-password-12')
    expect((await bindEmail(erinCookie, 'dave@example.com')).status).toBe(409)
  })

  it('locks a verification code after five wrong attempts', async () => {
    await setupAdmin()
    await createUser('frank', 'frank-password-1')
    const cookie = await login('frank', 'frank-password-1')
    expect((await bindEmail(cookie, 'frank@example.com')).status).toBe(200)
    const code = sentCodes.at(-1)?.code as string
    const wrong = code === '000000' ? '000001' : '000000'
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await confirmBind(cookie, wrong)).status).toBe(401)
    }
    expect((await confirmBind(cookie, code)).status).toBe(429)
  })

  it('verifies passwords against migrated legacy hash rows and binds their email', async () => {
    await setupAdmin()
    const now = new Date().toISOString()
    // A row in the exact shape the batch-1 converter wrote for pre-D1 users:
    // PBKDF2-SHA-256, 100000 iterations, password 'legacy-password-123'.
    await env.DB
      .prepare(
        `INSERT INTO users (
           id, username, role, enabled, password_algorithm, password_iterations,
           password_salt, password_hash, session_version, email, email_normalized,
           email_verified_at, created_at, updated_at
         ) VALUES ('usr_50', 'legacy', 'user', 1, 'PBKDF2-SHA-256', 100000,
           'ASA_Xn2cu9r5GDdWdZSz0g', 'DmiZJ0a5pTjGEPuRCo_6wT6vGZ4-2S1f216SWJoNT60',
           0, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(now, now)
      .run()
    await putSetting(env.DB, 'next_user_id', 51)

    const response = await loginResponse({ username: 'legacy' }, 'legacy-password-123')
    expect(response.status).toBe(200)
    const cookie = cookieOf(response)
    expect((await bindEmail(cookie, 'legacy@example.com')).status).toBe(200)
    expect((await confirmBind(cookie, sentCodes.at(-1)?.code as string)).status).toBe(200)
    expect((await loginResponse({ identifier: 'legacy@example.com' }, 'legacy-password-123')).status).toBe(200)
  })
})
