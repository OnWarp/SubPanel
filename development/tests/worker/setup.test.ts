import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { PASSWORD_ITERATIONS } from '../../../worker/accounts/password'
import { readAccounts } from '../../../worker/accounts/repository'
import { jsonRequest, resetData, TEST_ORIGIN } from './helpers'

beforeEach(resetData)

describe('administrator setup', () => {
  it('uses a PBKDF2 iteration count supported by Cloudflare Workers', () => {
    expect(PASSWORD_ITERATIONS).toBeLessThanOrEqual(100_000)
  })

  it('reports an uninitialized service', async () => {
    const response = await exports.default.fetch(`${TEST_ORIGIN}/api/bootstrap`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ initialized: false, user: null })
  })

  it('creates exactly one administrator without deployment secrets', async () => {
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/setup`,
      jsonRequest({ username: 'Admin', password: 'correct horse battery staple' }),
    )
    expect(created.status).toBe(201)
    expect(created.headers.get('set-cookie')).toBeNull()
    expect(await created.json()).toMatchObject({
      user: { id: 'usr_1', username: 'admin', role: 'admin', enabled: true },
    })

    const accounts = await readAccounts(env.DATA)
    expect(accounts.users).toHaveLength(1)
    expect(accounts.users[0].password.iterations).toBe(PASSWORD_ITERATIONS)
    expect(JSON.stringify(accounts)).not.toContain('correct horse battery staple')
    expect(await env.DATA.get('system:crypto')).not.toBeNull()

    const repeated = await exports.default.fetch(
      `${TEST_ORIGIN}/api/setup`,
      jsonRequest({ username: 'other', password: 'another correct password' }),
    )
    expect(repeated.status).toBe(409)
    expect((await readAccounts(env.DATA)).users).toHaveLength(1)
  })
})
