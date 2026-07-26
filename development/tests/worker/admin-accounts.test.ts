import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashToken } from '../../../worker/platform/crypto'
import {
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

describe('administrator account controls', () => {
  it('creates a one-use invitation and can revoke the resulting user session', async () => {
    const adminCookie = await login()
    const inviteResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/invites`,
      jsonRequest({ username: 'alice' }, withCookie(adminCookie)),
    )
    expect(inviteResponse.status).toBe(201)
    const invite = (await inviteResponse.json() as { invite: { link: string } }).invite
    const token = new URL(invite.link).pathname.split('/').at(-1)!
    expect(JSON.parse((await env.DATA.get(`invite:${await hashToken(token)}`))!)).toMatchObject({ userId: 'usr_2' })

    const status = await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`)
    expect(await status.json()).toMatchObject({ invite: { username: 'alice' } })

    const redeemed = await exports.default.fetch(
      `${TEST_ORIGIN}/api/invites/${token}`,
      jsonRequest({ password: 'alice correct password' }),
    )
    expect(redeemed.status).toBe(201)
    expect((await redeemed.json() as { user: { role: string } }).user.role).toBe('user')

    const reused = await exports.default.fetch(
      `${TEST_ORIGIN}/api/invites/${token}`,
      jsonRequest({ password: 'alice other password' }),
    )
    expect(reused.status).toBe(404)

    const userCookie = await login('alice', 'alice correct password')
    const forbidden = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/users`,
      withCookie(userCookie),
    )
    expect(forbidden.status).toBe(403)

    const users = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(adminCookie))
    const alice = (await users.json() as { users: Array<{ id: string; username: string }> }).users
      .find(({ username }) => username === 'alice')!
    const disabled = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/users/${alice.id}`,
      jsonRequest({ enabled: false }, { ...withCookie(adminCookie), method: 'PATCH' }),
    )
    expect(disabled.status).toBe(200)

    const revoked = await exports.default.fetch(`${TEST_ORIGIN}/api/account`, withCookie(userCookie))
    expect(revoked.status).toBe(401)
  })

  it('rejects an expired invitation', async () => {
    const token = 'A'.repeat(43)
    await env.DATA.put(`invite:${await hashToken(token)}`, JSON.stringify({
      schemaVersion: 1,
      userId: 'usr_2',
      username: 'expired',
      createdAt: '2026-07-21T00:00:00.000Z',
      expiresAt: '2026-07-22T00:00:00.000Z',
    }))

    const response = await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`)
    expect(response.status).toBe(410)
  })
})
