import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accountsSnapshotSchema, emptyAccountsSnapshot } from '../../../worker/accounts/schema'
import { readAccounts, writeAccounts } from '../../../worker/accounts/repository'
import { resetData } from './helpers'

beforeEach(resetData)

const now = '2026-07-23T00:00:00.000Z'
const password = {
  algorithm: 'PBKDF2-SHA-256' as const,
  iterations: 600_000,
  salt: 'A'.repeat(22),
  hash: 'B'.repeat(43),
}

describe('accounts snapshot repository', () => {
  it('rejects a next user ID that can collide with an existing account', () => {
    expect(accountsSnapshotSchema.safeParse({
      ...emptyAccountsSnapshot(now),
      nextUserId: 1,
      users: [{
        id: 'usr_1',
        username: 'admin',
        role: 'admin',
        enabled: true,
        password,
        sessionVersion: 0,
        createdAt: now,
        updatedAt: now,
      }],
    }).success).toBe(false)
  })

  it('returns a valid empty snapshot when KV has no state', async () => {
    expect(await readAccounts(env.DATA)).toEqual(emptyAccountsSnapshot())
  })

  it('increments revision and rejects a second administrator', async () => {
    const current = await readAccounts(env.DATA)
    const saved = await writeAccounts(env.DATA, {
      ...current,
      users: [
        {
          id: 'usr_1',
          username: 'admin',
          role: 'admin',
          enabled: true,
          password,
          sessionVersion: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
      nextUserId: 2,
    }, now)

    expect(saved.revision).toBe(1)
    expect(accountsSnapshotSchema.parse(JSON.parse((await env.DATA.get('state:accounts'))!))).toEqual(saved)
    await expect(writeAccounts(env.DATA, {
      ...saved,
      users: [...saved.users, { ...saved.users[0], id: 'usr_2', username: 'root' }],
    }, now)).rejects.toThrow('Accounts snapshot validation failed')
  })

  it('fails closed when stored JSON is corrupt', async () => {
    await env.DATA.put('state:accounts', '{broken')
    await expect(readAccounts(env.DATA)).rejects.toThrow('Accounts snapshot is corrupt')
  })
})
