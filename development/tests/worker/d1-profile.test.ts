import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAvatar } from '../../../worker/accounts/avatar'
import { clearAccountsStorage } from '../../../worker/accounts/d1-repository'
import { setEmailVerificationDeliverer } from '../../../worker/accounts/email'
import { md5Hex } from '../../../worker/accounts/md5'
import { hashPassword } from '../../../worker/accounts/password'
import { readAccounts, writeAccounts } from '../../../worker/accounts/repository'
import type { AccountUser, User } from '../../../worker/accounts/schema'
import { ACCOUNTS_D1_READY_KEY, markModuleReady } from '../../../worker/db/module-switch'
import { applyMigrations } from './d1'
import { jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)

const cookieOf = (response: Response): string => {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Response did not return a session cookie')
  return cookie
}

const loginRaw = (identifier: { username?: string; identifier?: string }, password: string) =>
  fetchApi('/api/login', jsonRequest({ ...identifier, password }))

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

async function bindEmail(cookie: string, email: string): Promise<void> {
  const bind = await fetchApi('/api/account/email/bind', withCookie(cookie, jsonRequest({ email })))
  expect(bind.status).toBe(200)
  const confirm = await fetchApi(
    '/api/account/email/bind/confirm',
    withCookie(cookie, jsonRequest({ code: sentCodes.at(-1)?.code as string })),
  )
  expect(confirm.status).toBe(200)
}

const profileOf = (cookie: string) => fetchApi('/api/account/profile', withCookie(cookie))
const changeEmail = (cookie: string, email: string) =>
  fetchApi('/api/account/email/change', withCookie(cookie, jsonRequest({ email })))
const confirmChange = (cookie: string, code: string) =>
  fetchApi('/api/account/email/change/confirm', withCookie(cookie, jsonRequest({ code })))

interface ProfileBody {
  user: { id: string; username: string; role: string; email: string | null; emailVerifiedAt: string | null; createdAt: string }
  emailBound: boolean
  avatar: { kind: string; url: string; seed: string }
  session: { issuedAt: string; expiresAt: string } | null
}

describe('md5 and avatar selection', () => {
  it('matches published MD5 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6')
    expect(md5Hex('1234567890'.repeat(8))).toBe('57edf4a22be3c955ac49da2e2107b67a')
    // Gravatar's documented example: trim + lowercase, then MD5.
    expect(md5Hex('myemailaddress@example.com')).toBe('0bc83cb571cd1c50ba6f3e8a78ef1346')
  })

  it('gives regular users a seeded DiceBear avatar even with a bound email', () => {
    const user = {
      id: 'usr_7',
      role: 'user',
      email: 'someone@example.com',
      emailNormalized: 'someone@example.com',
    } as AccountUser
    const avatar = resolveAvatar(user)
    expect(avatar.kind).toBe('dicebear')
    expect(avatar.seed).toBe('usr_7')
    expect(avatar.url).toBe('https://api.dicebear.com/9.x/notionists-neutral/svg?seed=usr_7')
  })

  it('gives admins Gravatar by bound email and DiceBear before binding', () => {
    const unbound = { id: 'usr_1', role: 'admin', email: null, emailNormalized: null } as AccountUser
    expect(resolveAvatar(unbound).kind).toBe('dicebear')
    const bound = {
      id: 'usr_1',
      role: 'admin',
      email: 'MyEmailAddress@example.com',
      emailNormalized: 'myemailaddress@example.com',
    } as AccountUser
    const avatar = resolveAvatar(bound)
    expect(avatar.kind).toBe('gravatar')
    expect(avatar.url).toBe('https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=160')
  })
})

describe('account profile center', () => {
  it('aggregates profile, avatar and session in one response', async () => {
    await setupAdmin()
    const user = await createUser('gina', 'gina-password-12')
    const cookie = await login('gina', 'gina-password-12')

    const response = await profileOf(cookie)
    expect(response.status).toBe(200)
    const profile = (await response.json()) as ProfileBody
    expect(profile.user.id).toBe(user.id)
    expect(profile.user.username).toBe('gina')
    expect(profile.user.role).toBe('user')
    expect(profile.user.email).toBeNull()
    expect(profile.user.createdAt).toBe(user.createdAt)
    expect(profile.emailBound).toBe(false)
    expect(profile.avatar.kind).toBe('dicebear')
    expect(profile.avatar.seed).toBe(user.id)
    expect(profile.session).not.toBeNull()
    const session = profile.session as { issuedAt: string; expiresAt: string }
    expect(Date.parse(session.expiresAt) - Date.parse(session.issuedAt)).toBe(24 * 60 * 60 * 1_000)
  })

  it('serves the admin Gravatar branch through the profile endpoint', async () => {
    await setupAdmin()
    const cookie = await login()
    await bindEmail(cookie, 'MyEmailAddress@example.com')

    const profile = (await (await profileOf(cookie)).json()) as ProfileBody
    expect(profile.user.role).toBe('admin')
    expect(profile.emailBound).toBe(true)
    expect(profile.avatar.kind).toBe('gravatar')
    expect(profile.avatar.url).toContain('0bc83cb571cd1c50ba6f3e8a78ef1346')
  })

  it('changes the bound email and moves login to the new address', async () => {
    await setupAdmin()
    const user = await createUser('henry', 'henry-password-1')
    const cookie = await login('henry', 'henry-password-1')
    await bindEmail(cookie, 'henry.old@example.com')

    const request = await changeEmail(cookie, ' Henry.New@Example.com ')
    expect(request.status).toBe(200)
    expect(sentCodes.at(-1)?.to).toBe('henry.new@example.com')
    const code = sentCodes.at(-1)?.code as string
    const wrong = code === '000000' ? '000001' : '000000'
    expect((await confirmChange(cookie, wrong)).status).toBe(401)

    const confirm = await confirmChange(cookie, code)
    expect(confirm.status).toBe(200)
    const confirmed = (await confirm.json()) as { user: { email: string | null } }
    expect(confirmed.user.email).toBe('henry.new@example.com')

    expect((await loginRaw({ identifier: 'henry.new@example.com' }, 'henry-password-1')).status).toBe(200)
    expect((await loginRaw({ identifier: 'henry.old@example.com' }, 'henry-password-1')).status).toBe(401)
    const profile = (await (await profileOf(cookie)).json()) as ProfileBody
    expect(profile.user.email).toBe('henry.new@example.com')
    expect(user.id).toBe(profile.user.id)
  })

  it('rejects unbound, unchanged, occupied and expired email changes', async () => {
    await setupAdmin()
    await createUser('ivan', 'ivan-password-12')
    await createUser('judy', 'judy-password-12')
    const ivanCookie = await login('ivan', 'ivan-password-12')
    const judyCookie = await login('judy', 'judy-password-12')

    // No bound email yet: the change flow refuses and points at binding.
    expect((await changeEmail(ivanCookie, 'ivan@example.com')).status).toBe(409)

    await bindEmail(ivanCookie, 'ivan@example.com')
    await bindEmail(judyCookie, 'judy@example.com')

    // Same address, another account's address: both refused at request time.
    expect((await changeEmail(ivanCookie, ' IVAN@example.com ')).status).toBe(409)
    expect((await changeEmail(ivanCookie, 'judy@example.com')).status).toBe(409)

    // An address with a pending change by someone else is occupied too.
    expect((await changeEmail(judyCookie, 'shared@example.com')).status).toBe(200)
    expect((await changeEmail(ivanCookie, 'shared@example.com')).status).toBe(409)

    // Expired codes cannot confirm a change.
    expect((await changeEmail(ivanCookie, 'ivan.new@example.com')).status).toBe(200)
    const code = sentCodes.at(-1)?.code as string
    await env.DB
      .prepare("UPDATE email_verifications SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email_normalized = 'ivan.new@example.com'")
      .run()
    expect((await confirmChange(ivanCookie, code)).status).toBe(410)
  })

  it('logs out every device by bumping the session version', async () => {
    await setupAdmin()
    await createUser('kate', 'kate-password-12')
    const first = await login('kate', 'kate-password-12')
    const second = cookieOf(await loginRaw({ username: 'kate' }, 'kate-password-12'))
    expect((await profileOf(first)).status).toBe(200)
    expect((await profileOf(second)).status).toBe(200)

    const response = await fetchApi('/api/account/logout-all', withCookie(first, jsonRequest({})))
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await profileOf(first)).status).toBe(401)
    expect((await profileOf(second)).status).toBe(401)
    expect((await loginRaw({ username: 'kate' }, 'kate-password-12')).status).toBe(200)
  })

  it('keeps the current session after a password change and drops the others', async () => {
    await setupAdmin()
    await createUser('liam', 'liam-password-12')
    const current = await login('liam', 'liam-password-12')
    const other = cookieOf(await loginRaw({ username: 'liam' }, 'liam-password-12'))

    const change = await fetchApi(
      '/api/account/password',
      withCookie(current, jsonRequest({ currentPassword: 'liam-password-12', newPassword: 'liam-password-34' })),
    )
    expect(change.status).toBe(200)
    const renewed = cookieOf(change)
    expect((await profileOf(renewed)).status).toBe(200)
    expect((await profileOf(current)).status).toBe(401)
    expect((await profileOf(other)).status).toBe(401)
  })
})
