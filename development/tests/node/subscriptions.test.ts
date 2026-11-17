import { beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createSubscription, transferSubscription, disableExpiredSubscriptions, updateSubscription } from '../../../worker/delivery/service'
import { readDelivery } from '../../../worker/delivery/repository'
import { publicSubscriptionRoutes } from '../../../worker/public-subscriptions'
import { createShare, readShareMeta } from '../../../worker/shares/service'
import type { DataEnv } from '../../../worker/db/module-switch'

vi.mock('../../../worker/db/module-switch', async importOriginal => ({ ...await importOriginal<object>(), isModuleReady: async () => false }))
vi.mock('../../../worker/accounts/repository', () => ({ readAccounts: async () => ({ users: [{ id: 'usr_1', enabled: true, deletedAt: null }, { id: 'usr_2', enabled: true, deletedAt: null }] }) }))
vi.mock('../../../worker/catalog/repository', () => ({ readCatalog: async () => ({ revision: 1, groups: [], nodes: [] }) }))
vi.mock('../../../worker/entitlements/service', () => ({ getUserEntitlement: async () => ({ current: null }) }))
let env: DataEnv
beforeEach(() => {
  const values = new Map<string, string>()
  env = {
    DATA: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) },
      delete: async (key: string) => { values.delete(key) },
      list: async ({ prefix = '' } = {}) => ({ keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
  }
})
const app = new Hono().route('/', publicSubscriptionRoutes).onError((error, c) => c.json({ error: error.message }, 'status' in error ? error.status as 400 : 500))
const pull = (token: string) => app.request(`/sub/${token}/mihomo`, {}, env)

it('creates an unavailable pool subscription, rotates on each assignment and preserves all other fields', async () => {
  const pool = await createSubscription(env, { name: 'Pool', groupIds: [], expiresAt: Date.now() + 86400000 })
  expect(pool.subscription.userId).toBeNull()
  expect((await pull(pool.token)).status).toBe(404)
  let previous = pool
  for (const userId of ['usr_1', 'usr_2', null]) {
    const result = await transferSubscription(env, pool.subscription.id, userId)
    expect(result.token).not.toBe(previous.token)
    expect((await pull(previous.token)).status).toBe(404)
    expect((await pull(result.token)).status).toBe(userId ? 200 : 404)
    const { userId: _owner, tokenHash: _hash, tokenPrefix: _prefix, encryptedToken: _encrypted, revision: _revision, updatedAt: _updated, ...preserved } = pool.subscription
    expect(result.subscription).toMatchObject(preserved)
    previous = result
  }
})

it('rejects invalid transfer targets without changing ownership or token', async () => {
  const created = await createSubscription(env, { userId: 'usr_1', name: 'Owned', groupIds: [] })
  await expect(transferSubscription(env, created.subscription.id, 'usr_99')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' })
  expect((await readDelivery(env)).subscriptions[0]).toEqual(created.subscription)
  expect((await pull(created.token)).status).toBe(200)
})

it('retains and disables at exact expiry and restores after extension and enable', async () => {
  const now = Date.now()
  const created = await createSubscription(env, { userId: 'usr_1', name: 'Expiry', groupIds: [], expiresAt: now + 10000 })
  await disableExpiredSubscriptions(env, new Date(now + 10000).toISOString())
  const snapshot = await readDelivery(env)
  expect(snapshot.subscriptions).toHaveLength(1)
  expect(snapshot.subscriptions[0].enabled).toBe(false)
  expect((await pull(created.token)).status).toBe(404)
  await updateSubscription(env, created.subscription.id, { expiresAt: now + 86400000, enabled: true }, { actorRole: 'admin' })
  expect((await pull(created.token)).status).toBe(200)
})

it('public expiry disables and denies even when the owner has no entitlement', async () => {
  const created = await createSubscription(env, { userId: 'usr_1', name: 'Expired', groupIds: [], expiresAt: Date.now() - 1 })
  expect((await pull(created.token)).status).toBe(410)
  expect((await readDelivery(env)).subscriptions[0].enabled).toBe(false)
})

it('uses existing share storage and guards for temporary links and preserves other shares', async () => {
  const now = new Date()
  const subscription = await createSubscription(env, { userId: 'usr_1', name: 'Sharing', groupIds: [] })
  const expiresAt = new Date(now.getTime() + 3600000).toISOString()
  const temporary = await createShare(env, 'usr_1', { subscriptionId: subscription.subscription.id, expiresAt }, now)
  const existing = await createShare(env, 'usr_1', { subscriptionId: subscription.subscription.id }, now)
  expect(temporary.share.expiresAt).toBe(expiresAt)
  await expect(readShareMeta(env, temporary.token, null, null, now)).resolves.toBeDefined()
  await expect(readShareMeta(env, temporary.token, null, null, new Date(expiresAt))).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' })
  await expect(readShareMeta(env, existing.token, null, null, new Date(expiresAt))).resolves.toBeDefined()
  await transferSubscription(env, subscription.subscription.id, 'usr_2')
  await expect(readShareMeta(env, existing.token, null, null, now)).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' })
})
