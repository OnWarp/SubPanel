import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { PASSWORD_ITERATIONS } from '../../../worker/accounts/password'
import { readAccounts } from '../../../worker/accounts/repository'
import { getOrCreateCryptoMaterial, randomToken } from '../../../worker/platform/crypto'
import { applyMigrations } from './d1'
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

  it('requires the bootstrap secret and creates one administrator across concurrent requests', async () => {
    await applyMigrations()
    await getOrCreateCryptoMaterial(env.DATA)
    env.BOOTSTRAP_SECRET = randomToken()
    const setup = (username: string, setupSecret: string) => exports.default.fetch(
      `${TEST_ORIGIN}/api/setup`,
      jsonRequest({ username, password: 'correct horse battery staple', setupSecret }),
    )

    expect((await setup('admin', randomToken())).status).toBe(403)
    const responses = await Promise.all([setup('admin', env.BOOTSTRAP_SECRET), setup('other', env.BOOTSTRAP_SECRET)])
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    const accounts = await readAccounts(env)
    expect(accounts.users).toHaveLength(1)
    expect(accounts.users[0].password.iterations).toBe(PASSWORD_ITERATIONS)
  })
})
