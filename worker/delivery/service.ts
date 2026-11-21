import type { BindingInput } from '../templates/repository.js'
import { readAccounts } from '../accounts/repository.js'
import { readCatalog } from '../catalog/repository.js'
import type { DataEnv } from '../db/module-switch.js'
import { encryptText, getOrCreateCryptoMaterial, hashToken, randomToken, readCryptoMaterial, decryptText } from '../platform/crypto.js'
import { batch } from '../db/db.js'
import { apiError } from '../platform/api-error.js'
import { bumpDeliveryRevision, getPlan, requirePlanStorage } from './plans.js'
import { deleteFetchStats } from './fetch-stats.js'
import { deleteCompiledArtifacts } from './repository.js'
import { readDelivery, writeDelivery } from './repository.js'
import {
  clientIdSchema,
  subscriptionIdSchema,
  toPublicSubscription,
  type ClientId,
  type PublicSubscription,
  type Subscription,
} from './schema.js'

export { toPublicSubscription }
export type { PublicSubscription }

export type SubscriptionInput = {
  planId?: string | null
  userId?: string | null
  name: string
  groupIds: string[]
  enabled?: boolean
  defaultClient?: ClientId
  startsAt?: number | null
  expiresAt?: number | null
  templateBinding?: BindingInput
}

export type SubscriptionMutationOptions = {
  now?: string
  token?: string
  actorUserId?: string
  actorRole?: 'admin' | 'user'
}

export type SubscriptionMutationResult = {
  subscription: Subscription
  token: string
}

export class DeliveryError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'DeliveryError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new DeliveryError(code)
}

function normalizedName(name: string): string {
  const value = name.trim()
  if (!value || value.length > 128) fail('SUBSCRIPTION_INVALID')
  return value
}

function validToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) fail('SUBSCRIPTION_TOKEN_INVALID')
  return token
}

function cleanEpoch(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) fail('SUBSCRIPTION_INVALID')
  return value
}

function assertWindow(startsAt: number | null, expiresAt: number | null): void {
  if (startsAt !== null && expiresAt !== null && expiresAt <= startsAt) fail('SUBSCRIPTION_WINDOW_INVALID')
}

async function assertReferences(env: DataEnv, userId: string | null | undefined, groupIds: string[]): Promise<void> {
  const accounts = await readAccounts(env)
  if (userId != null && !accounts.users.some((user) => user.id === userId && !user.deletedAt)) fail('USER_NOT_FOUND')
  const groups = new Set((await readCatalog(env)).groups.map((group) => group.id))
  if (groupIds.some((groupId) => !groups.has(groupId))) fail('GROUP_NOT_FOUND')
  if (new Set(groupIds).size !== groupIds.length) fail('SUBSCRIPTION_INVALID')
}

function findSubscription(snapshot: Awaited<ReturnType<typeof readDelivery>>, id: string): Subscription {
  if (!subscriptionIdSchema.safeParse(id).success) fail('SUBSCRIPTION_NOT_FOUND')
  const subscription = snapshot.subscriptions.find((candidate) => candidate.id === id)
  if (!subscription) fail('SUBSCRIPTION_NOT_FOUND')
  return subscription
}

function assertActor(subscription: Subscription, options: SubscriptionMutationOptions): void {
  if (options.actorRole === 'admin') return
  if (!options.actorUserId || options.actorUserId !== subscription.userId) fail('SUBSCRIPTION_FORBIDDEN')
}

export async function createToken(kv: KVNamespace, token: string): Promise<Pick<Subscription, 'tokenHash' | 'tokenPrefix' | 'encryptedToken'>> {
  const material = await getOrCreateCryptoMaterial(kv)
  return {
    tokenHash: await hashToken(token),
    tokenPrefix: token.slice(0, 8),
    encryptedToken: await encryptText(token, material.encryptionKey),
  }
}

async function subscriptionPlanFields(env: DataEnv, planId: string | null) {
  const plan = planId ? await getPlan(env.DB, planId) : null
  if (plan && !plan.enabled) throw apiError(409, 'PLAN_DISABLED', '计划已停用')
  if (plan) await requirePlanStorage(env)
  return {
    planId, trafficGb: plan?.trafficGb ?? 0, speedLimitMbps: plan?.speedLimitMbps ?? 0,
    deviceLimit: plan?.deviceLimit ?? 0, planSource: plan ? 'admin' as const : null,
    planNote: '', planRevoked: false, lastRemindedAt: null,
  }
}

export async function createSubscription(
  env: DataEnv,
  input: SubscriptionInput,
  options: SubscriptionMutationOptions = {},
): Promise<SubscriptionMutationResult> {
  await assertReferences(env, input.userId, input.groupIds)
  const plan = input.planId ? await subscriptionPlanFields(env, input.planId) : {}
  const snapshot = await readDelivery(env)
  const now = options.now ?? new Date().toISOString()
  const token = validToken(options.token ?? randomToken())
  const id = `sub_${snapshot.nextSubscriptionId}` as const
  const tokenData = await createToken(env.DATA, token)
  if (snapshot.subscriptions.some((item) => item.tokenHash === tokenData.tokenHash)) fail('SUBSCRIPTION_TOKEN_COLLISION')
  const startsAt = cleanEpoch(input.startsAt ?? null)
  const expiresAt = cleanEpoch(input.expiresAt ?? null)
  assertWindow(startsAt, expiresAt)
  const subscription: Subscription = {
    id,
    userId: (input.userId ?? null) as Subscription['userId'],
    name: normalizedName(input.name),
    groupIds: [...input.groupIds] as Subscription['groupIds'],
    ...tokenData,
    ...plan,
    enabled: input.enabled ?? true,
    defaultClient: clientIdSchema.parse(input.defaultClient ?? 'mihomo'),
    revision: 1,
    startsAt,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  }
  await writeDelivery(env, {
    ...snapshot,
    nextSubscriptionId: snapshot.nextSubscriptionId + 1,
    subscriptions: [...snapshot.subscriptions, subscription],
  }, now, input.templateBinding ? { id, binding: input.templateBinding } : undefined)
  return { subscription, token }
}

async function bindingForCopy(env: DataEnv, id: string): Promise<BindingInput | undefined> {
  try {
    const row = await env.DB.prepare(
      'SELECT mode, template_id FROM subscription_template_bindings WHERE subscription_id=?',
    ).bind(id).first<{ mode: BindingInput['mode']; template_id: string | null }>()
    if (!row) return undefined
    if (row.mode === 'specific') {
      if (!row.template_id) return undefined
      return { mode: 'specific', templateId: row.template_id, expectedRevision: 1 }
    }
    return { mode: row.mode, expectedRevision: 1 }
  } catch {
    return undefined
  }
}

export async function copySubscription(
  env: DataEnv,
  id: string,
  options: SubscriptionMutationOptions = {},
): Promise<SubscriptionMutationResult> {
  const current = await getSubscription(env, id)
  const templateBinding = await bindingForCopy(env, id)
  return createSubscription(env, {
    userId: current.userId,
    planId: current.planId ?? null,
    name: `${current.name} 副本`.slice(0, 128),
    groupIds: [...current.groupIds],
    enabled: current.enabled,
    defaultClient: current.defaultClient,
    startsAt: current.startsAt,
    expiresAt: current.expiresAt,
    templateBinding,
  }, options)
}

export async function listSubscriptionsForUser(env: DataEnv, userId: string): Promise<PublicSubscription[]> {
  return (await listAllSubscriptions(env)).filter(subscription => subscription.userId === userId).map(toPublicSubscription)
}

export async function listAllSubscriptions(env: DataEnv): Promise<Subscription[]> {
  return (await readDelivery(env)).subscriptions
}

export async function getSubscription(env: DataEnv, id: string): Promise<Subscription> {
  return findSubscription(await readDelivery(env), id)
}

export type UpdateSubscriptionInput = Partial<Pick<SubscriptionInput, 'name' | 'groupIds' | 'enabled' | 'defaultClient' | 'startsAt' | 'expiresAt' | 'templateBinding' | 'planId'>>

export async function updateSubscription(
  env: DataEnv,
  id: string,
  input: UpdateSubscriptionInput,
  options: SubscriptionMutationOptions = {},
): Promise<Subscription> {
  if (input.planId !== undefined && options.actorRole !== 'admin') fail('SUBSCRIPTION_FORBIDDEN')
  const snapshot = await readDelivery(env)
  const current = findSubscription(snapshot, id)
  assertActor(current, options)
  const plan = input.planId === undefined || input.planId === (current.planId ?? null)
    ? undefined : await subscriptionPlanFields(env, input.planId)
  const nextName = input.name === undefined ? current.name : normalizedName(input.name)
  const nextGroups = input.groupIds === undefined ? current.groupIds : [...input.groupIds]
  await assertReferences(env, current.userId, nextGroups)
  const startsAt = cleanEpoch(input.startsAt === undefined ? current.startsAt : input.startsAt)
  const expiresAt = cleanEpoch(input.expiresAt === undefined ? current.expiresAt : input.expiresAt)
  assertWindow(startsAt, expiresAt)
  const now = options.now ?? new Date().toISOString()
  const updated: Subscription = {
    ...current,
    ...plan,
    name: nextName,
    groupIds: nextGroups as Subscription['groupIds'],
    enabled: input.enabled ?? current.enabled,
    ...(current.planRevoked && input.enabled ? { planRevoked: false } : {}),
    defaultClient: input.defaultClient === undefined ? current.defaultClient : clientIdSchema.parse(input.defaultClient),
    startsAt,
    expiresAt,
    revision: current.revision + 1,
    updatedAt: now,
  }
  await writeDelivery(env, { ...snapshot, subscriptions: snapshot.subscriptions.map((item) => item.id === id ? updated : item) }, now,
    input.templateBinding ? { id, binding: input.templateBinding } : undefined)
  return updated
}

export async function setSubscriptionEnabled(
  env: DataEnv,
  id: string,
  enabled: boolean,
  options: SubscriptionMutationOptions = {},
): Promise<Subscription> {
  return updateSubscription(env, id, { enabled }, options)
}

export async function transferSubscription(env: DataEnv, id: string, userId: string | null): Promise<SubscriptionMutationResult> {
  const snapshot = await readDelivery(env)
  const current = findSubscription(snapshot, id)
  await assertReferences(env, userId, current.groupIds)
  const token = randomToken()
  const tokenData = await createToken(env.DATA, token)
  if (snapshot.subscriptions.some(item => item.tokenHash === tokenData.tokenHash)) fail('SUBSCRIPTION_TOKEN_COLLISION')
  const now = new Date().toISOString()
  const updated = { ...current, userId, ...tokenData, revision: current.revision + 1, updatedAt: now }
  // Ownership and token are written in the same D1 batch (or single KV snapshot).
  await writeDelivery(env, { ...snapshot, subscriptions: snapshot.subscriptions.map(item => item.id === id ? updated : item) }, now)
  await deleteCompiledArtifacts(env.DATA, current.tokenHash)
  return { subscription: updated, token }
}

export async function disableExpiredSubscriptions(env: DataEnv, now = new Date().toISOString()): Promise<void> {
  const snapshot = await readDelivery(env)
  let changed = false
  const subscriptions = snapshot.subscriptions.map(item => {
    if (!item.enabled || item.expiresAt === null || item.expiresAt > Date.parse(now)) return item
    changed = true
    return { ...item, enabled: false, revision: item.revision + 1, updatedAt: now }
  })
  if (changed) await writeDelivery(env, { ...snapshot, subscriptions }, now)
}

export async function resetSubscriptionToken(
  env: DataEnv,
  id: string,
  options: SubscriptionMutationOptions = {},
): Promise<SubscriptionMutationResult> {
  const snapshot = await readDelivery(env)
  const current = findSubscription(snapshot, id)
  assertActor(current, options)
  const now = options.now ?? new Date().toISOString()
  const token = validToken(options.token ?? randomToken())
  const tokenData = await createToken(env.DATA, token)
  if (snapshot.subscriptions.some((item) => item.id !== id && item.tokenHash === tokenData.tokenHash)) fail('SUBSCRIPTION_TOKEN_COLLISION')
  const updated: Subscription = {
    ...current,
    ...tokenData,
    revision: current.revision + 1,
    updatedAt: now,
  }
  await writeDelivery(env, { ...snapshot, subscriptions: snapshot.subscriptions.map((item) => item.id === id ? updated : item) }, now)
  await deleteCompiledArtifacts(env.DATA, current.tokenHash)
  return { subscription: updated, token }
}

export async function deleteSubscription(
  env: DataEnv,
  id: string,
  options: SubscriptionMutationOptions = {},
): Promise<void> {
  const snapshot = await readDelivery(env)
  const current = findSubscription(snapshot, id)
  assertActor(current, options)
  await writeDelivery(env, { ...snapshot, subscriptions: snapshot.subscriptions.filter((item) => item.id !== id) }, undefined, { id, deleteBinding: true })
  await deleteCompiledArtifacts(env.DATA, current.tokenHash)
  await deleteFetchStats(env.DATA, id)
}

export async function decryptSubscriptionToken(env: DataEnv, subscription: Subscription): Promise<string> {
  if (subscription.encryptedToken) {
    const material = await readCryptoMaterial(env.DATA)
    return decryptText(subscription.encryptedToken, material.encryptionKey)
  }
  const token = randomToken()
  const data = await createToken(env.DATA, token)
  const now = new Date().toISOString()
  const [result] = await batch(env.DB, [
    env.DB.prepare(`UPDATE subscriptions SET token_hash=?, token_prefix=?, encrypted_token=?, revision=revision+1
      WHERE id=? AND user_id IS ? AND token_hash=? AND encrypted_token='{}'`)
      .bind(data.tokenHash, data.tokenPrefix, JSON.stringify(data.encryptedToken), subscription.id, subscription.userId, subscription.tokenHash),
    bumpDeliveryRevision(env.DB, now, true),
  ])
  if (result.meta.changes === 1) return token
  const current = await getSubscription(env, subscription.id)
  if (current.userId !== subscription.userId || current.revision !== subscription.revision + 1 || !current.encryptedToken) {
    throw apiError(409, 'SUBSCRIPTION_CONFLICT', '订阅已被修改，请刷新后重试')
  }
  return decryptSubscriptionToken(env, current)
}

export async function removeGroupReference(env: DataEnv, groupId: string): Promise<void> {
  const snapshot = await readDelivery(env)
  const subscriptions = snapshot.subscriptions.map((subscription) => {
    if (!subscription.groupIds.includes(groupId)) return subscription
    return {
      ...subscription,
      groupIds: subscription.groupIds.filter((id) => id !== groupId),
      revision: subscription.revision + 1,
      updatedAt: new Date().toISOString(),
    }
  })
  if (subscriptions.every((subscription, index) => subscription === snapshot.subscriptions[index])) return
  await writeDelivery(env, { ...snapshot, subscriptions })
}
