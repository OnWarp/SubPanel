import { deliverySnapshotSchema, emptyDeliverySnapshot, type DeliverySnapshot } from './schema.js'

export const DELIVERY_KEY = 'state:delivery'
export const MAX_DELIVERY_BYTES = 20 * 1024 * 1024

export async function readDelivery(kv: KVNamespace): Promise<DeliverySnapshot> {
  const raw = await kv.get(DELIVERY_KEY)
  if (raw === null) return emptyDeliverySnapshot()
  try {
    return deliverySnapshotSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Delivery snapshot is corrupt')
  }
}

export async function writeDelivery(
  kv: KVNamespace,
  snapshot: DeliverySnapshot,
  now = new Date().toISOString(),
): Promise<DeliverySnapshot> {
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

  // ponytail: KV is last-writer-wins; move Delivery writes to a Durable Object or D1 when concurrent subscription writers become normal.
  await kv.put(DELIVERY_KEY, serialized)
  return result.data
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
