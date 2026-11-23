import type { BindingInput } from '../templates/repository.js'
import { readAccounts } from '../accounts/repository.js'
import { readCatalog } from '../catalog/repository.js'
import { CATALOG_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { bytesPerGiB, getIssuableVersion, getRedemptionVersion } from './entitlement-templates.js'
import { encryptText, getOrCreateCryptoMaterial, hashToken, randomToken, readCryptoMaterial, decryptText } from '../platform/crypto.js'
import { batch } from '../db/db.js'
import { apiError } from '../platform/api-error.js'
import { bumpDeliveryRevision, getPlan, requirePlanStorage, type Plan } from './plans.js'
import { subscriptionInsert } from './d1-repository.js'
import { subscriptionToColumns } from '../migration/delivery.js'
import { expiryFromDuration, type SubscriptionDuration } from './expiry.js'
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
  nodeIds?: string[]
  enabled?: boolean
  defaultClient?: ClientId
  startsAt?: number | null
  expiresAt?: number | null
  templateBinding?: BindingInput
  trafficGb?: number
  speedLimitMbps?: number
  deviceLimit?: number
  idempotencyKey?: string
  duration?: SubscriptionDuration
}

export type SubscriptionMutationOptions = {
  now?: string
  token?: string
  actorUserId?: string
  actorRole?: 'admin' | 'user'
  redemption?: {
    templateName: string
    statements: (subscription: Subscription) => D1PreparedStatement[]
  }
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

async function assertReferences(env: DataEnv, userId: string | null | undefined, groupIds: string[]) {
  const accounts = await readAccounts(env)
  if (userId != null && !accounts.users.some((user) => user.id === userId && !user.deletedAt)) fail('USER_NOT_FOUND')
  const catalog = await readCatalog(env)
  const groups = new Set(catalog.groups.map((group) => group.id))
  if (groupIds.some((groupId) => !groups.has(groupId))) fail('GROUP_NOT_FOUND')
  if (new Set(groupIds).size !== groupIds.length) fail('SUBSCRIPTION_INVALID')
  return catalog
}

async function assertDirectNodes(
  env: DataEnv, catalog: Awaited<ReturnType<typeof readCatalog>>, ids: string[], planId: string | null | undefined,
) {
  if (planId) throw apiError(422, 'SUBSCRIPTION_DIRECT_NODES_WITH_PLAN', '关联旧计划的订阅只能通过分组选节点')
  if (!await isModuleReady(env.DB, CATALOG_D1_READY_KEY)) throw apiError(409, 'CATALOG_STORAGE_NOT_READY', '请先完成目录 D1 迁移')
  const nodes = new Set(catalog.nodes.filter((node) => node.enabled).map((node) => node.id))
  if (ids.some((id) => !nodes.has(id))) throw apiError(422, 'SUBSCRIPTION_NODE_UNAVAILABLE', '请选择当前可用的节点')
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
    planId, ...subscriptionEntitlementFields(plan, {}), planSource: plan ? 'admin' as const : null,
    planNote: '', planRevoked: false, lastRemindedAt: null,
  }
}

function subscriptionEntitlementFields(plan: Plan | null, input: Partial<SubscriptionInput>) {
  return {
    trafficGb: input.trafficGb ?? plan?.trafficGb ?? 0,
    speedLimitMbps: input.speedLimitMbps ?? plan?.speedLimitMbps ?? 0,
    deviceLimit: input.deviceLimit ?? plan?.deviceLimit ?? 0,
  }
}

async function prepareSubscription(
  env: DataEnv, input: SubscriptionInput, now: string, sourceType: 'manual' | 'legacy' | 'template' | 'redemption', suppliedToken?: string,
) {
  const startsAt = cleanEpoch(input.startsAt ?? null)
  if (input.duration && input.expiresAt != null) fail('SUBSCRIPTION_WINDOW_INVALID')
  const expiresAt = cleanEpoch(input.duration
    ? expiryFromDuration(startsAt ?? Date.parse(now), input.duration)
    : input.expiresAt ?? null)
  assertWindow(startsAt, expiresAt)
  const token = validToken(suppliedToken ?? randomToken())
  const subscription: Omit<Subscription, 'id'> = {
    userId: input.userId ?? null,
    name: normalizedName(input.name),
    groupIds: [...input.groupIds],
    ...(input.nodeIds?.length ? { nodeIds: [...input.nodeIds] } : {}),
    ...await createToken(env.DATA, token),
    ...subscriptionEntitlementFields(null, input),
    sourceType,
    enabled: input.enabled ?? true,
    defaultClient: clientIdSchema.parse(input.defaultClient ?? 'mihomo'),
    revision: 1,
    startsAt,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  }
  return { subscription, token }
}

type TemplateSubscriptionInput = Partial<Omit<SubscriptionInput, 'userId' | 'planId' | 'deviceLimit'>> & {
  userId: string
  templateVersionId: string
}

export async function createSubscription(
  env: DataEnv,
  { idempotencyKey, ...request }: SubscriptionInput | TemplateSubscriptionInput,
  options: SubscriptionMutationOptions = {},
): Promise<SubscriptionMutationResult> {
  const keyHash = idempotencyKey && await hashToken(JSON.stringify([options.actorUserId, idempotencyKey]))
  const fingerprint = keyHash ? await hashToken(JSON.stringify(request)) : ''
  const origin = 'templateVersionId' in request ? request.templateVersionId : undefined
  const redemption = options.redemption
  if (redemption && (!origin || !options.actorUserId || request.userId !== options.actorUserId)) fail('SUBSCRIPTION_FORBIDDEN')
  if (origin && !redemption && options.actorRole !== 'admin') fail('SUBSCRIPTION_FORBIDDEN')
  if (keyHash || origin || request.nodeIds?.length) await requirePlanStorage(env)
  const replay = async () => {
    if (!keyHash) return null
    const row = await env.DB.prepare(`SELECT subscription_id, request_fingerprint FROM subscription_creation
      WHERE request_key_hash=?`).bind(keyHash).first<{ subscription_id: string | null; request_fingerprint: string }>()
    if (!row) return null
    if (fingerprint !== row.request_fingerprint || !row.subscription_id) {
      throw apiError(409, 'SUBSCRIPTION_IDEMPOTENCY_CONFLICT', '此创建请求已使用，请刷新后重试')
    }
    const subscription = await getSubscription(env, row.subscription_id)
    return { subscription, token: await decryptSubscriptionToken(env, subscription) }
  }
  const previous = await replay()
  if (previous) return previous
  let version: Awaited<ReturnType<typeof getIssuableVersion>> | undefined
  let input: SubscriptionInput
  if ('templateVersionId' in request) {
    version = redemption
      ? await getRedemptionVersion(env.DB, request.templateVersionId, redemption.templateName)
      : await getIssuableVersion(env.DB, request.templateVersionId)
    const { name, config } = version
    input = {
      name,
      duration: request.expiresAt !== undefined ? undefined : config.duration,
      trafficGb: (config.quotaBytes ?? 0) / bytesPerGiB,
      speedLimitMbps: config.limits.speedLimitMbps,
      groupIds: config.groupIds,
      nodeIds: config.nodeIds,
      ...request,
    }
    if (!input.groupIds.length && !input.nodeIds?.length) fail('SUBSCRIPTION_INVALID')
    if (request.trafficGb !== undefined) {
      const quotaBytes = Math.round(request.trafficGb * bytesPerGiB)
      if (!Number.isSafeInteger(quotaBytes) || (request.trafficGb > 0 && quotaBytes === 0)) fail('SUBSCRIPTION_INVALID')
      input.trafficGb = quotaBytes / bytesPerGiB
    }
  } else {
    input = request
  }
  const catalog = await assertReferences(env, input.userId, input.groupIds)
  if (input.nodeIds?.length) {
    if (new Set(input.nodeIds).size !== input.nodeIds.length) fail('SUBSCRIPTION_INVALID')
    await assertDirectNodes(env, catalog, input.nodeIds, input.planId)
  }
  const plan = input.planId ? await subscriptionPlanFields(env, input.planId) : undefined
  const snapshot = await readDelivery(env)
  const now = options.now ?? new Date().toISOString()
  const sourceType = redemption ? 'redemption' : origin ? 'template' : 'manual'
  const prepared = await prepareSubscription(env, { ...plan, ...input }, now, sourceType, options.token)
  const id = `sub_${snapshot.nextSubscriptionId}` as const
  const subscription = { ...plan, ...prepared.subscription, id, ...(version ? {
    templateVersionId: version.id, entitlementTemplateName: version.name, entitlementVersionNumber: version.number,
  } : {}) }
  if (snapshot.subscriptions.some((item) => item.tokenHash === subscription.tokenHash)) fail('SUBSCRIPTION_TOKEN_COLLISION')
  try {
    await writeDelivery(env, {
      ...snapshot,
      nextSubscriptionId: snapshot.nextSubscriptionId + 1,
      subscriptions: [...snapshot.subscriptions, subscription],
    }, now, input.templateBinding ? { id, binding: input.templateBinding } : undefined,
    keyHash ? { id, keyHash, fingerprint } : undefined,
    origin || input.nodeIds?.length ? { id, nodeIds: input.nodeIds, templateVersionId: redemption ? undefined : origin } : undefined,
    redemption?.statements(subscription))
  } catch (error) {
    const concurrent = await replay()
    if (concurrent) return concurrent
    throw error
  }
  return { subscription, token: prepared.token }
}

// Registration appends these statements immediately after the guarded account insert.
export async function preparePlanSubscription(
  env: DataEnv, userId: string, plan: Plan, days: number, source: 'admin' | 'trial', note: string, now: string,
) {
  const start = Date.parse(now)
  const { subscription } = await prepareSubscription(env, {
    userId, name: plan.name, groupIds: plan.groupIds, startsAt: start, expiresAt: start + days * 86_400_000,
    ...subscriptionEntitlementFields(plan, {}),
  }, now, 'legacy')
  const { tokenHash } = subscription
  const row = subscriptionToColumns({ ...subscription, planId: plan.id, planSource: source, planNote: note })
  const guard = source === 'trial'
    ? 'changes() = 1'
    : `NOT EXISTS (SELECT 1 FROM subscriptions WHERE user_id=? AND plan_id IS NOT NULL AND plan_revoked=0)`
  return [
    subscriptionInsert(env.DB, row, {
      where: `${guard} AND EXISTS (SELECT 1 FROM plans WHERE id=? AND enabled=1 AND updated_at=?)`,
      bindings: [...(source === 'admin' ? [userId] : []), plan.id, plan.updatedAt],
    }),
    bumpDeliveryRevision(env.DB, now, true),
    env.DB.prepare(`INSERT INTO subscription_groups (subscription_id, group_id, position)
      SELECT s.id, pg.group_id, pg.position FROM subscriptions s JOIN plan_groups pg ON pg.plan_id=s.plan_id
      WHERE s.token_hash=?`).bind(tokenHash),
    env.DB.prepare(`INSERT INTO system_settings (key,value,updated_at)
      SELECT 'next_subscription_id', cast(substr(id,5) AS INTEGER)+1, ? FROM subscriptions WHERE token_hash=?
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(now, tokenHash),
    env.DB.prepare(`INSERT INTO system_settings (key,value,updated_at)
      SELECT 'delivery_entity_order', json_insert(coalesce(
        (SELECT value FROM system_settings WHERE key='delivery_entity_order' AND json_valid(value)), '[]'
      ), '$[#]', id), ? FROM subscriptions WHERE token_hash=?
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(now, tokenHash),
  ]
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
    nodeIds: current.planId ? undefined : current.nodeIds,
    enabled: current.enabled,
    defaultClient: current.defaultClient,
    startsAt: current.startsAt,
    expiresAt: current.expiresAt,
    templateBinding,
    trafficGb: current.trafficGb,
    speedLimitMbps: current.speedLimitMbps,
    deviceLimit: current.deviceLimit,
  }, options)
}

export async function listSubscriptionsForUser(env: DataEnv, userId: string): Promise<PublicSubscription[]> {
  return (await listAllSubscriptions(env)).filter(subscription => subscription.userId === userId).map(toPublicSubscription)
}

export async function listAllSubscriptions(env: DataEnv): Promise<Subscription[]> {
  return (await readDelivery(env)).subscriptions
}

export async function getSubscription(env: DataEnv, id: string, ownerUserId?: string): Promise<Subscription> {
  const subscription = findSubscription(await readDelivery(env), id)
  if (ownerUserId !== undefined && subscription.userId !== ownerUserId) fail('SUBSCRIPTION_NOT_FOUND')
  return subscription
}

export type UpdateSubscriptionInput = Partial<Pick<SubscriptionInput, 'name' | 'groupIds' | 'nodeIds' | 'enabled' | 'defaultClient' | 'startsAt' | 'expiresAt' | 'templateBinding' | 'planId' | 'trafficGb' | 'speedLimitMbps' | 'deviceLimit'>>

type PlanOperation = {
  action: 'grant' | 'renew' | 'switch' | 'revoke'
  userId: string
  previousPlanId: string | null
  plan: Plan | null
  note: string
}

// Compute renewals inside D1 so concurrent requests each extend the latest deadline.
async function applyPlanOperation(env: DataEnv, id: string, now: string, operation: PlanOperation) {
  const { action, userId, previousPlanId, plan, note } = operation
  const db = env.DB
  const time = Date.parse(now)
  const days = (plan?.durationDays ?? 0) * 86_400_000
  const statement = action === 'revoke'
    ? db.prepare("UPDATE subscriptions SET plan_revoked=1, plan_note=?, revision=revision+1, updated_at=? WHERE id=? AND user_id=? AND plan_id=? AND plan_revoked=0")
      .bind(note, now, id, userId, previousPlanId)
    : action === 'renew'
    ? db.prepare(`UPDATE subscriptions SET expires_at=max(coalesce(expires_at,?),?)+?,
        enabled=CASE WHEN expires_at <= ? THEN 1 ELSE enabled END,
        plan_note=?, revision=revision+1, updated_at=? WHERE id=? AND user_id=? AND plan_id=? AND plan_revoked=0`)
      .bind(time, time, days, time, note, now, id, userId, previousPlanId)
    : db.prepare(`UPDATE subscriptions SET plan_id=?, traffic_gb=?, speed_limit_mbps=?, device_limit=?,
        starts_at=?, expires_at=?, plan_note=?, plan_source='admin', last_reminded_at=NULL, revision=revision+1, updated_at=?
        WHERE id=? AND user_id=? AND plan_id IS ? AND plan_revoked=0
        AND (? IS NOT NULL OR NOT EXISTS (SELECT 1 FROM subscriptions WHERE user_id=? AND plan_id IS NOT NULL AND plan_revoked=0))`)
      .bind(plan!.id, plan!.trafficGb, plan!.speedLimitMbps, plan!.deviceLimit, time, time+days, note, now,
        id, userId, previousPlanId, previousPlanId, userId)
  const [result] = await batch(db, [statement, bumpDeliveryRevision(db, now, true)])
  if (result.meta.changes !== 1) throw apiError(409, 'ENTITLEMENT_CHANGED', '订阅已变更，请刷新')
}

export async function updateSubscription(
  env: DataEnv,
  id: string,
  input: UpdateSubscriptionInput,
  options: SubscriptionMutationOptions & { planOperation?: PlanOperation } = {},
): Promise<Subscription> {
  if (options.planOperation) {
    if (options.actorRole !== 'admin') fail('SUBSCRIPTION_FORBIDDEN')
    await applyPlanOperation(env, id, options.now ?? new Date().toISOString(), options.planOperation)
    return getSubscription(env, id, options.planOperation.userId)
  }
  if (input.planId !== undefined && options.actorRole !== 'admin') fail('SUBSCRIPTION_FORBIDDEN')
  const snapshot = await readDelivery(env)
  const current = findSubscription(snapshot, id)
  assertActor(current, options)
  const plan = input.planId === undefined || input.planId === (current.planId ?? null)
    ? undefined : await subscriptionPlanFields(env, input.planId)
  const nextName = input.name === undefined ? current.name : normalizedName(input.name)
  const nextGroups = input.groupIds === undefined ? current.groupIds : [...input.groupIds]
  const catalog = await assertReferences(env, current.userId, nextGroups)
  const nextNodeIds = input.nodeIds
  const currentNodeIds = current.nodeIds ?? []
  if (nextNodeIds) {
    if (new Set(nextNodeIds).size !== nextNodeIds.length) fail('SUBSCRIPTION_INVALID')
    const currentNodes = new Set(currentNodeIds)
    const additions = nextNodeIds.filter((nodeId) => !currentNodes.has(nodeId))
    if (additions.length) await assertDirectNodes(env, catalog, additions, input.planId === undefined ? current.planId : input.planId)
  }
  const startsAt = cleanEpoch(input.startsAt === undefined ? current.startsAt : input.startsAt)
  const expiresAt = cleanEpoch(input.expiresAt === undefined ? current.expiresAt : input.expiresAt)
  assertWindow(startsAt, expiresAt)
  const now = options.now ?? new Date().toISOString()
  const updated: Subscription = {
    ...current,
    ...plan,
    trafficGb: input.trafficGb ?? plan?.trafficGb ?? current.trafficGb,
    speedLimitMbps: input.speedLimitMbps ?? plan?.speedLimitMbps ?? current.speedLimitMbps,
    deviceLimit: input.deviceLimit ?? plan?.deviceLimit ?? current.deviceLimit,
    name: nextName,
    groupIds: nextGroups as Subscription['groupIds'],
    ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
    enabled: input.enabled ?? current.enabled,
    defaultClient: input.defaultClient === undefined ? current.defaultClient : clientIdSchema.parse(input.defaultClient),
    startsAt,
    expiresAt,
    revision: current.revision + 1,
    updatedAt: now,
  }
  const nodePolicyChanged = nextNodeIds && (nextNodeIds.length !== currentNodeIds.length ||
    nextNodeIds.some((nodeId, index) => nodeId !== currentNodeIds[index]))
  await writeDelivery(env, { ...snapshot, subscriptions: snapshot.subscriptions.map((item) => item.id === id ? updated : item) }, now,
    input.templateBinding ? { id, binding: input.templateBinding } : undefined,
    undefined, nodePolicyChanged ? { id, nodeIds: nextNodeIds } : undefined)
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
