import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { decryptText, readCryptoMaterial } from '../../../worker/platform/crypto.js'
import {
  createSubscription,
  listSubscriptionsForUser,
  resetSubscriptionToken,
  toPublicSubscription,
} from '../../../worker/delivery/service.js'
import { readDelivery } from '../../../worker/delivery/repository.js'
import { compiledArtifactSchema, deliverySnapshotSchema, emptyDeliverySnapshot } from '../../../worker/delivery/schema.js'
import { resetData, setupAdmin } from './helpers'

const now = '2026-07-25T00:00:00.000Z'

beforeEach(async () => {
  await resetData()
  await setupAdmin()
})

describe('Delivery snapshot and token service', () => {
  it('rejects a next subscription ID that can collide with an existing subscription', async () => {
    await createSubscription(env.DATA, { userId: 'usr_1', name: 'Existing', groupIds: [] }, { token: 'Z'.repeat(43) })
    const snapshot = await readDelivery(env.DATA)
    expect(deliverySnapshotSchema.safeParse({ ...snapshot, nextSubscriptionId: 1 }).success).toBe(false)
  })

  it('rejects inconsistent or unsafe compiled artifacts', () => {
    const base = {
      schemaVersion: 2 as const,
      client: 'mihomo' as const,
      body: 'proxies: []',
      contentType: 'text/yaml; charset=utf-8',
      fileName: 'mihomo.yaml',
      etag: `"${'A'.repeat(43)}"`,
      lastModified: now,
      subscriptionRevision: 1,
      catalogRevision: 1,
      inputNodes: 1,
      outputNodes: 1,
      skippedNodes: 0,
      diagnostics: [],
      available: true,
    }
    expect(compiledArtifactSchema.safeParse({ ...base, outputNodes: 2 }).success).toBe(false)
    expect(compiledArtifactSchema.safeParse({ ...base, available: false }).success).toBe(false)
    expect(compiledArtifactSchema.safeParse({ ...base, fileName: '../mihomo.yaml' }).success).toBe(false)
    expect(compiledArtifactSchema.safeParse({ ...base, contentType: 'text/plain\r\nX-Injected: yes' }).success).toBe(false)
  })

  it('returns an empty validated delivery snapshot when absent', async () => {
    const snapshot = await readDelivery(env.DATA)
    expect(snapshot).toEqual(emptyDeliverySnapshot())
    expect(deliverySnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it('rejects a corrupt snapshot', async () => {
    await env.DATA.put('state:delivery', '{}')
    await expect(readDelivery(env.DATA)).rejects.toThrow('Delivery snapshot is corrupt')
  })

  it('stores only a hash and encrypted recoverable token', async () => {
    const result = await createSubscription(env.DATA, {
      userId: 'usr_1',
      name: 'Primary',
      groupIds: [],
    }, { now, token: 'A'.repeat(43) })

    const snapshot = await readDelivery(env.DATA)
    const stored = snapshot.subscriptions[0]
    expect(result.token).toBe('A'.repeat(43))
    expect(stored.tokenHash).not.toBe(result.token)
    expect(stored.encryptedToken).toBeDefined()
    expect(JSON.stringify(snapshot)).not.toContain(result.token)

    const material = await readCryptoMaterial(env.DATA)
    await expect(decryptText(stored.encryptedToken!, material.encryptionKey)).resolves.toBe(result.token)
  })

  it('returns only the owner subscriptions and rotates the old token', async () => {
    const first = await createSubscription(env.DATA, { userId: 'usr_1', name: 'One', groupIds: [] }, { token: 'B'.repeat(43) })
    expect((await listSubscriptionsForUser(env.DATA, 'usr_1')).map((item) => item.id)).toEqual([first.subscription.id])

    const rotated = await resetSubscriptionToken(env.DATA, first.subscription.id, { actorUserId: 'usr_1', token: 'D'.repeat(43) })
    expect(rotated.token).toBe('D'.repeat(43))
    expect(rotated.subscription.tokenPrefix).toBe('DDDDDDDD')
    expect((await readDelivery(env.DATA)).subscriptions[0].tokenHash).not.toBe(first.subscription.tokenHash)
    expect(toPublicSubscription(rotated.subscription)).not.toHaveProperty('encryptedToken')
  })

  it('rejects a non-owner token reset', async () => {
    const created = await createSubscription(env.DATA, { userId: 'usr_1', name: 'Private', groupIds: [] }, { token: 'E'.repeat(43) })
    await expect(resetSubscriptionToken(env.DATA, created.subscription.id, { actorUserId: 'usr_2', token: 'F'.repeat(43) }))
      .rejects.toThrow('SUBSCRIPTION_FORBIDDEN')
  })

  it('rejects a duplicate externally supplied token', async () => {
    await createSubscription(env.DATA, { userId: 'usr_1', name: 'First', groupIds: [] }, { token: 'G'.repeat(43) })
    await expect(createSubscription(env.DATA, { userId: 'usr_1', name: 'Second', groupIds: [] }, { token: 'G'.repeat(43) }))
      .rejects.toThrow('SUBSCRIPTION_TOKEN_COLLISION')
  })

  it('allocates unique IDs and preserves an explicitly disabled subscription', async () => {
    const first = await createSubscription(env.DATA, { userId: 'usr_1', name: 'Disabled', groupIds: [], enabled: false }, { token: 'H'.repeat(43) })
    const second = await createSubscription(env.DATA, { userId: 'usr_1', name: 'Enabled', groupIds: [] }, { token: 'I'.repeat(43) })
    expect([first.subscription.id, second.subscription.id]).toEqual(['sub_1', 'sub_2'])
    expect(first.subscription.enabled).toBe(false)
  })
})
