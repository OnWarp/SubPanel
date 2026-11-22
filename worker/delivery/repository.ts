import { apiError } from '../platform/api-error.js'
import { bindingWrite, requirePublished, rethrowBindingError, type BindingInput } from '../templates/repository.js'
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

type BindingMutation = { id: string } & ({ binding: BindingInput } | { deleteBinding: true })

export async function writeDelivery(
  env: DataEnv,
  snapshot: DeliverySnapshot,
  now = new Date().toISOString(),
  mutation?: BindingMutation,
  request?: { id: string; keyHash: string; fingerprint: string },
): Promise<DeliverySnapshot> {
  const binding = mutation && 'binding' in mutation ? mutation.binding : undefined
  const cleanup = mutation && 'deleteBinding' in mutation
    ? env.DB.prepare('DELETE FROM subscription_template_bindings WHERE subscription_id=?').bind(mutation.id)
    : undefined
  if (await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)) {
    const next = prepareDeliveryWrite(snapshot, now)
    const accounts = await readAccounts(env)
    if (binding?.mode === 'specific') await requirePublished(env.DB, binding.templateId)
    const statement = binding && mutation ? bindingWrite(env.DB, mutation.id, binding, now, true) : cleanup
    await persistDeliverySnapshot(env.DB, next, accounts.users, statement, snapshot.revision, request).catch(rethrowBindingError)
    return next
  }
  if (binding) throw apiError(409, 'TEMPLATE_STORAGE_NOT_READY', '请先完成订阅 D1 迁移，再随订阅保存附加配置')
  const next = await writeDeliveryKv(env.DATA, snapshot, now)
  if (cleanup) await cleanup.run()
  return next
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
