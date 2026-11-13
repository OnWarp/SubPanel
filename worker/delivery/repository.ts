import { readAccounts } from '../accounts/repository.js'
import { DELIVERY_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { persistDeliverySnapshot, readDeliveryFromD1 } from './d1-repository.js'
import { deliverySnapshotSchema, emptyDeliverySnapshot, type DeliverySnapshot } from './schema.js'

export const DELIVERY_KEY = 'state:delivery'
export const MAX_DELIVERY_BYTES = 20 * 1024 * 1024

export async function readDeliveryKv(kv: KVNamespace): Promise<DeliverySnapshot> {
  const raw = await kv.get(DELIVERY_KEY)
  if (raw === null) return emptyDeliverySnapshot()
  try {
    return deliverySnapshotSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Delivery snapshot is corrupt')
  }
}

function prepareDeliveryWrite(snapshot: DeliverySnapshot, now: string): DeliverySnapshot {
  const result = deliverySnapshotSchema.safeParse({
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt: now,
  })
  if (!result.success) throw new Error('Delivery snapshot validation failed')

  const serialized = JSON.stringify(result.data)
  if (new TextEncoder().encode(serialized).byteLength > MAX_DELIVERY_BYTES) {
    throw new Error('Delivery snapshot is too large')
  }
  return result.data
}

export async function readDelivery(env: DataEnv): Promise<DeliverySnapshot> {
  if (await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)) return readDeliveryFromD1(env.DB)
  return readDeliveryKv(env.DATA)
}

export async function writeDeliveryKv(
  kv: KVNamespace,
  snapshot: DeliverySnapshot,
  now = new Date().toISOString(),
): Promise<DeliverySnapshot> {
  const next = prepareDeliveryWrite(snapshot, now)
  await kv.put(DELIVERY_KEY, JSON.stringify(next))
  return next
}

export async function writeDelivery(
  env: DataEnv,
  snapshot: DeliverySnapshot,
  now = new Date().toISOString(),
): Promise<DeliverySnapshot> {
  // One backend only: the import flag selects D1, and its absence keeps KV.
  if (await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)) {
    const next = prepareDeliveryWrite(snapshot, now)
    const accounts = await readAccounts(env)
    await persistDeliverySnapshot(env.DB, next, accounts.users)
    return next
  }
  return writeDeliveryKv(env.DATA, snapshot, now)
}

export const compiledPrefix = (tokenHash: string): string => `compiled:${tokenHash}:`
export const compiledKey = (tokenHash: string, client: string): string => `${compiledPrefix(tokenHash)}${client}`

export async function deleteCompiledArtifacts(kv: KVNamespace, tokenHash: string): Promise<void> {
  try {
    const listed = await kv.list({ prefix: compiledPrefix(tokenHash) })
    if (listed.keys.length > 0) await Promise.allSettled(listed.keys.map(({ name }) => kv.delete(name)))
  } catch {
    // Public delivery validates the current subscription, so stale derived keys remain inert.
  }
}
