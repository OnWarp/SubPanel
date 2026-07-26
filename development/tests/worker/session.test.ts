import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN_PASSWORD,
  jsonRequest,
  login,
  resetData,
  setupAdmin,
  TEST_ORIGIN,
  withCookie,
} from './helpers'

beforeEach(async () => {
  await resetData()
  await setupAdmin()
})

describe('signed account sessions', () => {
  it('sets a hardened cookie and resolves it through bootstrap', async () => {
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/login`,
      jsonRequest({ username: 'ADMIN', password: ADMIN_PASSWORD }),
    )
    expect(response.status).toBe(200)
    const setCookie = response.headers.get('set-cookie')!
    expect(setCookie).toContain('subpanel_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=86400')

    const cookie = setCookie.split(';', 1)[0]
    const bootstrap = await exports.default.fetch(
      `${TEST_ORIGIN}/api/bootstrap`,
      withCookie(cookie),
    )
    expect(await bootstrap.json()).toMatchObject({
      initialized: true,
      user: { username: 'admin', role: 'admin' },
    })
  })

  it('rejects invalid credentials and tampered cookies', async () => {
    const denied = await exports.default.fetch(
      `${TEST_ORIGIN}/api/login`,
      jsonRequest({ username: 'admin', password: 'wrong password!' }),
    )
    expect(denied.status).toBe(401)

    const cookie = await login()
    const tampered = `${cookie}x`
    const account = await exports.default.fetch(`${TEST_ORIGIN}/api/account`, withCookie(tampered))
    expect(account.status).toBe(401)
  })
})
