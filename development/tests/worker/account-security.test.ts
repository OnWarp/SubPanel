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

describe('account security', () => {
  it('changes the password, refreshes the current cookie, and revokes older sessions', async () => {
    const firstCookie = await login()
    const secondCookie = await login()
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/account/password`,
      jsonRequest(
        { currentPassword: ADMIN_PASSWORD, newPassword: 'new correct horse password' },
        withCookie(firstCookie),
      ),
    )
    expect(response.status).toBe(200)
    const refreshedCookie = response.headers.get('set-cookie')!.split(';', 1)[0]

    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/account`, withCookie(firstCookie))).status).toBe(401)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/account`, withCookie(secondCookie))).status).toBe(401)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/account`, withCookie(refreshedCookie))).status).toBe(200)

    const oldLogin = await exports.default.fetch(
      `${TEST_ORIGIN}/api/login`,
      jsonRequest({ username: 'admin', password: ADMIN_PASSWORD }),
    )
    expect(oldLogin.status).toBe(401)
    await expect(login('admin', 'new correct horse password')).resolves.toContain('subpanel_session=')
  })

  it('clears the browser cookie on logout', async () => {
    const cookie = await login()
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/account/logout`,
      jsonRequest({}, withCookie(cookie)),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('lets the administrator reset a normal user password and revoke old sessions', async () => {
    const adminCookie = await login()
    const deniedSelfReset = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/users/usr_1/password`,
      jsonRequest({ newPassword: 'bypass current password' }, withCookie(adminCookie)),
    )
    expect(deniedSelfReset.status).toBe(409)

    const inviteResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/invites`,
      jsonRequest({ username: 'alice' }, withCookie(adminCookie)),
    )
    const inviteLink = (await inviteResponse.json() as { invite: { link: string } }).invite.link
    const token = new URL(inviteLink).pathname.split('/').at(-1)!
    await exports.default.fetch(
      `${TEST_ORIGIN}/api/invites/${token}`,
      jsonRequest({ password: 'alice correct password' }),
    )
    const oldCookie = await login('alice', 'alice correct password')
    const usersResponse = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(adminCookie))
    const alice = (await usersResponse.json() as { users: Array<{ id: string; username: string }> }).users
      .find(({ username }) => username === 'alice')!

    const reset = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/users/${alice.id}/password`,
      jsonRequest({ newPassword: 'alice replacement password' }, withCookie(adminCookie)),
    )
    expect(reset.status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/account`, withCookie(oldCookie))).status).toBe(401)
    await expect(login('alice', 'alice correct password')).rejects.toThrow('Login failed with 401')
    await expect(login('alice', 'alice replacement password')).resolves.toContain('subpanel_session=')
  })
})
