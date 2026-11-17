import { applyMigrations, emptyDatabase } from './d1'
import { ACCOUNTS_D1_READY_KEY, markModuleReady } from '../../../worker/db/module-switch'
import { putRegistrationMode } from '../../../worker/db/settings-repository'
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
  await emptyDatabase()
  await applyMigrations()
  await markModuleReady(env.DB, ACCOUNTS_D1_READY_KEY)
  await setupAdmin()
  await putRegistrationMode(env.DB, 'invite')
})

describe('administrator account controls', () => {
  it('creates a one-use invitation and can revoke the resulting user session', async () => {
    const adminCookie = await login()
    const inviteResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/invites`,
      jsonRequest({}, withCookie(adminCookie)),
    )
    expect(inviteResponse.status).toBe(201)
    const invite = (await inviteResponse.json() as { invite: { link: string } }).invite
    const token = new URL(invite.link).pathname.split('/').at(-1)!
    const row = await env.DB.prepare('SELECT used_count FROM invite_codes WHERE token_hash = ?').bind(await hashToken(token)).first()
    expect(row).toMatchObject({ used_count: 0 })

    const redeemed = await exports.default.fetch(
      `${TEST_ORIGIN}/api/register`,
      jsonRequest({ username: 'alice', email: 'alice@example.com', inviteCode: token, password: 'alice correct password' }),
    )
    expect(redeemed.status).toBe(201)
    expect((await redeemed.json() as { user: { role: string } }).user.role).toBe('user')

    const reused = await exports.default.fetch(
      `${TEST_ORIGIN}/api/register`,
      jsonRequest({ username: 'alice', email: 'alice@example.com', inviteCode: token, password: 'alice other password' }),
    )
    expect(reused.status).toBe(409)

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

    const response = await exports.default.fetch(`${TEST_ORIGIN}/api/register`, jsonRequest({ username: 'fresh', email: 'fresh@example.com', password: 'fresh password 123', inviteCode: token }))
    expect(response.status).toBe(410)
  })
})
