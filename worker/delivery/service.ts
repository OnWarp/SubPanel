import { readAccounts } from '../accounts/repository.js'
import { readCatalog } from '../catalog/repository.js'
import { encryptText, getOrCreateCryptoMaterial, hashToken, randomToken, readCryptoMaterial, decryptText } from '../platform/crypto.js'
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
  userId: string
  name: string
  groupIds: string[]
  enabled?: boolean
  defaultClient?: ClientId
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

async function assertReferences(kv: KVNamespace, userId: string, groupIds: string[]): Promise<void> {
  const accounts = await readAccounts(kv)
  if (!accounts.users.some((user) => user.id === userId)) fail('USER_NOT_FOUND')
  const groups = new Set((await readCatalog(kv)).groups.map((group) => group.id))
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

async function createToken(kv: KVNamespace, token: string): Promise<Pick<Subscription, 'tokenHash' | 'tokenPrefix' | 'encryptedToken'>> {
  const material = await getOrCreateCryptoMaterial(kv)
  return {
    tokenHash: await hashToken(token),
    tokenPrefix: token.slice(0, 8),
    encryptedToken: await encryptText(token, material.encryptionKey),
  }
}

export async function createSubscription(
  kv: KVNamespace,
  input: SubscriptionInput,
  options: SubscriptionMutationOptions = {},
): Promise<SubscriptionMutationResult> {
  await assertReferences(kv, input.userId, input.groupIds)
  const snapshot = await readDelivery(kv)
  const now = options.now ?? new Date().toISOString()
  const token = validToken(options.token ?? randomToken())
  const id = `sub_${snapshot.nextSubscriptionId}` as const
  const tokenData = await createToken(kv, token)
  if (snapshot.subscriptions.some((item) => item.tokenHash === tokenData.tokenHash)) fail('SUBSCRIPTION_TOKEN_COLLISION')
  const subscription: Subscription = {
    id,
    userId: input.userId as Subscription['userId'],
    name: normalizedName(input.name),
    groupIds: [...input.groupIds] as Subscription['groupIds'],
    ...tokenData,
    enabled: input.enabled ?? true,
    defaultClient: clientIdSchema.parse(input.defaultClient ?? 'mihomo'),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  await writeDelivery(kv, {
    ...snapshot,
    nextSubscriptionId: snapshot.nextSubscriptionId + 1,
    subscriptions: [...snapshot.subscriptions, subscription],
  }, now)
  return { subscription, token }
}

export async function listSubscriptionsForUser(kv: KVNamespace, userId: string): Promise<PublicSubscription[]> {
  const snapshot = await readDelivery(kv)
  return snapshot.subscriptions
    .filter((subscription) => subscription.userId === userId)
    .map(toPublicSubscription)
}

export async function listAllSubscriptions(kv: KVNamespace): Promise<Subscription[]> {
  return (await readDelivery(kv)).subscriptions
}

export async function getSubscription(kv: KVNamespace, id: string): Promise<Subscription> {
  return findSubscription(await readDelivery(kv), id)
}

export type UpdateSubscriptionInput = Partial<Pick<SubscriptionInput, 'name' | 'groupIds' | 'enabled' | 'defaultClient'>>

export async function updateSubscription(
  kv: KVNamespace,
  id: string,
  input: UpdateSubscriptionInput,
  options: SubscriptionMutationOptions = {},
): Promise<Subscription> {
  const snapshot = await readDelivery(kv)
  const current = findSubscription(snapshot, id)
  assertActor(current, options)
  const nextName = input.name === undefined ? current.name : normalizedName(input.name)
  const nextGroups = input.groupIds === undefined ? current.groupIds : [...input.groupIds]
  await assertReferences(kv, current.userId, nextGroups)
  const now = options.now ?? new Date().toISOString()
  const updated: Subscription = {
    ...current,
    name: nextName,
    groupIds: nextGroups as Subscription['groupIds'],
    enabled: input.enabled ?? current.enabled,
    defaultClient: input.defaultClient === undefined ? current.defaultClient : clientIdSchema.parse(input.defaultClient),
    revision: current.revision + 1,
    updatedAt: now,
  }
  await writeDelivery(kv, { ...snapshot, subscriptions: snapshot.subscriptions.map((item) => item.id === id ? updated : item) }, now)
  return updated
}

export async function setSubscriptionEnabled(
  kv: KVNamespace,
  id: string,
  enabled: boolean,
  options: SubscriptionMutationOptions = {},
): Promise<Subscription> {
  return updateSubscription(kv, id, { enabled }, options)
}

export async function resetSubscriptionToken(
  kv: KVNamespace,
  id: string,
  options: SubscriptionMutationOptions = {},
): Promise<SubscriptionMutationResult> {
  const snapshot = await readDelivery(kv)
  const current = findSubscription(snapshot, id)
  assertActor(current, options)
  const now = options.now ?? new Date().toISOString()
  const token = validToken(options.token ?? randomToken())
  const tokenData = await createToken(kv, token)
  if (snapshot.subscriptions.some((item) => item.id !== id && item.tokenHash === tokenData.tokenHash)) fail('SUBSCRIPTION_TOKEN_COLLISION')
  const updated: Subscription = {
    ...current,
    ...tokenData,
    revision: current.revision + 1,
    updatedAt: now,
  }
  await writeDelivery(kv, { ...snapshot, subscriptions: snapshot.subscriptions.map((item) => item.id === id ? updated : item) }, now)
  await deleteCompiledArtifacts(kv, current.tokenHash)
  return { subscription: updated, token }
}

export async function deleteSubscription(
  kv: KVNamespace,
  id: string,
  options: SubscriptionMutationOptions = {},
): Promise<void> {
  const snapshot = await readDelivery(kv)
  const current = findSubscription(snapshot, id)
  assertActor(current, options)
  await writeDelivery(kv, { ...snapshot, subscriptions: snapshot.subscriptions.filter((item) => item.id !== id) })
  await deleteCompiledArtifacts(kv, current.tokenHash)
}

export async function decryptSubscriptionToken(kv: KVNamespace, subscription: Subscription): Promise<string> {
  const material = await readCryptoMaterial(kv)
  return decryptText(subscription.encryptedToken, material.encryptionKey)
}

export async function removeGroupReference(kv: KVNamespace, groupId: string): Promise<void> {
  const snapshot = await readDelivery(kv)
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
  await writeDelivery(kv, { ...snapshot, subscriptions })
}
