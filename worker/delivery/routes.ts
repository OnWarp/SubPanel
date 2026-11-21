import { readShareSettings } from '../shares/repository.js'
import { canUseShareFeature } from '../shares/service.js'
import { bindingSchema } from '../templates/repository.js'
import { listPlans, subscriptionPlanState } from './plans.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { primaryDomainOriginSafe } from '../domains/service.js'
import { SUBSCRIPTION_LINK_PLATFORMS } from '../domains/platforms.js'
import { readAccounts } from '../accounts/repository.js'
import { readCatalog } from '../catalog/repository.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { compileAllSubscriptions, compileSubscription, RENDERER_VERSION } from './compiler.js'
import {
  createSubscription,
  transferSubscription,
  disableExpiredSubscriptions,
  decryptSubscriptionToken,
  deleteSubscription,
  getSubscription,
  listAllSubscriptions,
  resetSubscriptionToken,
  updateSubscription,
  DeliveryError,
} from './service.js'
import { compiledKey } from './repository.js'
import { isWithinExpiryDays, subscriptionExpiryKind, type SubscriptionExpiryKind } from './expiry.js'
import { compiledArtifactSchema, epochMillisSchema, type Subscription } from './schema.js'
import { attachTrafficUsage, measuredTrafficForSubscription } from './traffic-usage.js'

const client = z.enum(['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'])
const epochField = epochMillisSchema.nullable().optional()
const createSchema = z.object({
  userId: z.string().regex(/^usr_[1-9]\d*$/).nullable().optional(),
  planId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(128),
  groupIds: z.array(z.string().regex(/^grp_[1-9]\d*$/)),
  enabled: z.boolean().optional(),
  defaultClient: client.optional(),
  startsAt: epochField,
  expiresAt: epochField,
  templateBinding: bindingSchema.optional(),
})
const updateSchema = z.object({
  planId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(128).optional(),
  groupIds: z.array(z.string().regex(/^grp_[1-9]\d*$/)).optional(),
  enabled: z.boolean().optional(),
  defaultClient: client.optional(),
  startsAt: epochField,
  expiresAt: epochField,
  templateBinding: bindingSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
const emptySchema = z.object({}).default({})

const propagationWarning = 'KV 更新可能需要约 60 秒或更久才能在所有地区生效'
const compilationWarning = '订阅已保存，但客户端缓存编译失败，将在后续变更时重试'

async function mutationWarning(compile?: () => Promise<unknown>): Promise<string> {
  if (!compile) return propagationWarning
  try {
    await compile()
    return propagationWarning
  } catch {
    return `${propagationWarning}；${compilationWarning}`
  }
}

function mapError(error: unknown): never {
  if (error instanceof DeliveryError) {
    const statuses: Record<string, 400 | 403 | 404 | 409 | 422> = {
      SUBSCRIPTION_INVALID: 422,
      SUBSCRIPTION_WINDOW_INVALID: 422,
      SUBSCRIPTION_TOKEN_INVALID: 422,
      SUBSCRIPTION_TOKEN_COLLISION: 409,
      SUBSCRIPTION_NOT_FOUND: 404,
      SUBSCRIPTION_FORBIDDEN: 403,
      USER_NOT_FOUND: 404,
      GROUP_NOT_FOUND: 404,
    }
    const status = statuses[error.code] ?? 422
    const messages: Record<string, string> = {
      SUBSCRIPTION_FORBIDDEN: '无权操作该订阅',
      SUBSCRIPTION_NOT_FOUND: '订阅不存在',
      SUBSCRIPTION_WINDOW_INVALID: '到期时间必须晚于生效时间',
      USER_NOT_FOUND: '用户不存在',
      GROUP_NOT_FOUND: '分组不存在',
    }
    throw apiError(status, error.code, messages[error.code] ?? '订阅输入无效')
  }
  if (error instanceof Error && error.message === 'SUBSCRIPTION_NOT_FOUND') throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  throw error
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    mapError(error)
  }
}

async function view(c: Context<AppEnv>, subscription: Awaited<ReturnType<typeof getSubscription>>, catalogRevision?: number) {
  const token = await decryptSubscriptionToken(c.env, subscription)
  if (!subscription.encryptedToken) {
    const current = await getSubscription(c.env, subscription.id)
    if (current.userId !== subscription.userId) throw apiError(409, 'SUBSCRIPTION_CONFLICT', '订阅已被修改，请刷新后重试')
    subscription = current
  }
  const plan = subscription.planId ? (await listPlans(c.env.DB)).find(plan => plan.id === subscription.planId) ?? null : null
  const currentCatalogRevision = catalogRevision ?? (await readCatalog(c.env)).revision
  // Subscription links are always generated on the primary subscription
  // domain (plan section 7.1). When no usable primary is configured the
  // links stay empty and linkError tells the UI to prompt for domain
  // configuration instead of silently falling back to the request Host.
  const origin = await primaryDomainOriginSafe(c.env.DB, 'subscription')
  const linkError = origin === null ? 'SUBSCRIPTION_DOMAIN_NOT_CONFIGURED' : null
  const links = origin === null
    ? {}
    : Object.fromEntries(
        SUBSCRIPTION_LINK_PLATFORMS.map(({ platform }) => [
          platform,
          `${origin}/sub/${token}${platform === 'auto' ? '' : `/${platform}`}`,
        ]),
      )
  const diagnostics: Record<string, unknown> = {}
  for (const name of ['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic']) {
    const raw = await c.env.DATA.get(compiledKey(subscription.tokenHash, name))
    if (!raw) continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    const artifact = compiledArtifactSchema.safeParse(value)
    if (
      subscription.enabled &&
      artifact.success &&
      artifact.data.rendererVersion === RENDERER_VERSION &&
      artifact.data.subscriptionRevision === subscription.revision &&
      artifact.data.catalogRevision === currentCatalogRevision
    ) diagnostics[name] = {
      inputNodes: artifact.data.inputNodes,
      outputNodes: artifact.data.outputNodes,
      skippedNodes: artifact.data.skippedNodes,
      diagnostics: artifact.data.diagnostics,
      available: artifact.data.available,
      rendererVersion: artifact.data.rendererVersion,
      templateVersionId: artifact.data.templateVersionId,
    }
  }
  return {
    planId: subscription.planId ?? null,
    planName: plan?.name ?? null,
    planState: subscriptionPlanState(subscription, plan, Date.now()),
    trafficGb: subscription.trafficGb ?? 0,
    speedLimitMbps: subscription.speedLimitMbps ?? 0,
    deviceLimit: subscription.deviceLimit ?? 0,
    id: subscription.id,
    userId: subscription.userId,
    name: subscription.name,
    groupIds: subscription.groupIds,
    tokenPrefix: subscription.tokenPrefix,
    enabled: subscription.enabled,
    defaultClient: subscription.defaultClient,
    revision: subscription.revision,
    startsAt: subscription.startsAt,
    expiresAt: subscription.expiresAt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    links,
    linkError,
    diagnostics,
  }
}

async function userSubscriptionView(c: Context<AppEnv>, subscription: Awaited<ReturnType<typeof getSubscription>>, catalogRevision?: number) {
  const body = await view(c, subscription, catalogRevision)
  return attachTrafficUsage(body, body.trafficGb, measuredTrafficForSubscription(body.id))
}


// Copied from the admin users list (worker/accounts/admin-routes.ts) so every
// paginated list shares one parameter contract: page defaults to 1 and
// pageSize defaults to 20, clamped to 100.
const parsePagination = (query: Record<string, string | undefined>): { page: number, pageSize: number } => {
  const page = Number.parseInt(query.page ?? '', 10)
  const pageSize = Number.parseInt(query.pageSize ?? '', 10)
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
  }
}

type AdminSubscriptionFilters = {
  query: string | null
  status: boolean | null
  expiry: SubscriptionExpiryKind | '7' | '15' | '30' | null
  enabledOnly: boolean
}

const EXPIRY_KINDS: SubscriptionExpiryKind[] = ['active', 'pending', 'soon', 'expired', 'permanent']
const EXPIRY_WINDOWS = ['7', '15', '30']

const parseAdminSubscriptionFilters = (query: Record<string, string | undefined>): AdminSubscriptionFilters => {
  const needle = query.q?.trim().toLowerCase()
  const expiry = query.expiry ?? ''
  return {
    query: needle ? needle : null,
    status: query.status === 'enabled' ? true : query.status === 'disabled' ? false : null,
    expiry: (EXPIRY_KINDS as string[]).includes(expiry) || EXPIRY_WINDOWS.includes(expiry)
      ? expiry as AdminSubscriptionFilters['expiry']
      : null,
    enabledOnly: query.enabled === '1',
  }
}

// The list endpoint keeps its historical full-list response for callers that
// pass no parameters (dashboard counts, group counts, share pickers and the
// user page all read the whole set). Any pagination or filter parameter
// switches it to the paginated contract the admin subscriptions page uses.
const hasAdminSubscriptionParams = (query: Record<string, string | undefined>): boolean =>
  ['page', 'pageSize', 'q', 'status', 'expiry', 'enabled'].some((key) => query[key] !== undefined)

// Same matching the admin page applied client-side before pagination: status
// and the enabled-only flag first, then the expiry classification (worker
// mirror of the UI helper), then a case-insensitive substring over the
// subscription name, the owner's username and its group names.
function matchesAdminSubscriptionFilters(
  subscription: Subscription,
  filters: AdminSubscriptionFilters,
  userNames: ReadonlyMap<string, string>,
  groupNames: ReadonlyMap<string, string>,
  now: number,
): boolean {
  if (filters.status !== null && subscription.enabled !== filters.status) return false
  if (filters.enabledOnly && !subscription.enabled) return false
  if (filters.expiry !== null) {
    if (filters.expiry === '7' || filters.expiry === '15' || filters.expiry === '30') {
      if (!isWithinExpiryDays(subscription, Number(filters.expiry), now)) return false
    } else if (subscriptionExpiryKind(subscription, now) !== filters.expiry) return false
  }
  if (filters.query !== null) {
    const user = (subscription.userId ? userNames.get(subscription.userId) ?? subscription.userId : '未分配')
    const groupLabel = subscription.groupIds.map((id) => groupNames.get(id) ?? id).join(' ')
    const hit = [subscription.name, user, groupLabel].some((value) => value.toLowerCase().includes(filters.query!))
    if (!hit) return false
  }
  return true
}

export const adminDeliveryRoutes = new Hono<AppEnv>()

adminDeliveryRoutes.get('/', async (c) => {
  await disableExpiredSubscriptions(c.env)
  const [subscriptions, catalog] = await Promise.all([listAllSubscriptions(c.env), readCatalog(c.env)])
  const query = c.req.query()
  if (!hasAdminSubscriptionParams(query)) {
    return c.json({ subscriptions: await Promise.all(subscriptions.map((subscription) => view(c, subscription, catalog.revision))) })
  }
  const { page, pageSize } = parsePagination(query)
  const filters = parseAdminSubscriptionFilters(query)
  const accounts = await readAccounts(c.env)
  const userNames = new Map(accounts.users.map((user) => [user.id, user.username]))
  const groupNames = new Map(catalog.groups.map((group) => [group.id, group.name]))
  const now = Date.now()
  const filtered = subscriptions.filter((subscription) =>
    matchesAdminSubscriptionFilters(subscription, filters, userNames, groupNames, now))
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize)
  return c.json({
    subscriptions: await Promise.all(pageItems.map((subscription) => view(c, subscription, catalog.revision))),
    total: filtered.length,
    page,
    pageSize,
  })
})

adminDeliveryRoutes.post('/', async (c) => {
  const input = await readJson(c, createSchema)
  const result = await run(() => createSubscription(c.env, input, { actorRole: 'admin' }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning }, 201)
})

adminDeliveryRoutes.post('/:id/transfer', async (c) => {
  const input = await readJson(c, z.object({ userId: z.string().regex(/^usr_[1-9]\d*$/).nullable() }))
  const result = await run(() => transferSubscription(c.env, c.req.param('id'), input.userId))
  const warning = await mutationWarning(() => compileSubscription(c.env, result.subscription))
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning })
})

adminDeliveryRoutes.patch('/:id', async (c) => {
  const input = await readJson(c, updateSchema)
  const subscription = await run(() => updateSubscription(c.env, c.req.param('id'), input, { actorRole: 'admin' }))
  const warning = await mutationWarning(() => compileAllSubscriptions(c.env))
  return c.json({ subscription: await view(c, subscription), warning })
})

adminDeliveryRoutes.put('/:id', async (c) => {
  const input = await readJson(c, updateSchema)
  const subscription = await run(() => updateSubscription(c.env, c.req.param('id'), input, { actorRole: 'admin' }))
  const warning = await mutationWarning(() => compileAllSubscriptions(c.env))
  return c.json({ subscription: await view(c, subscription), warning })
})

adminDeliveryRoutes.post('/:id/token/reset', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), { actorRole: 'admin' }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning })
})

adminDeliveryRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), { actorRole: 'admin' }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning })
})

adminDeliveryRoutes.delete('/:id', async (c) => {
  await run(() => deleteSubscription(c.env, c.req.param('id'), { actorRole: 'admin' }))
  return c.body(null, 204)
})

export const userDeliveryRoutes = new Hono<AppEnv>()

userDeliveryRoutes.get('/', async (c) => {
  await disableExpiredSubscriptions(c.env)
  const [subscriptions, catalog, shareSettings] = await Promise.all([
    listAllSubscriptions(c.env),
    readCatalog(c.env),
    readShareSettings(c.env),
  ])
  const { id: userId, role } = c.get('principal')
  const views = await Promise.all(subscriptions.filter(subscription => subscription.userId === userId)
    .map(subscription => userSubscriptionView(c, subscription, catalog.revision)))
  return c.json({ subscriptions: views, shareEnabled: canUseShareFeature(role, shareSettings) })
})

userDeliveryRoutes.post('/:id/token/reset', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), {
    actorUserId: c.get('principal').id,
    actorRole: 'user',
  }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env, result.subscription) : undefined)
  return c.json({ subscription: await userSubscriptionView(c, result.subscription), token: result.token, warning })
})

userDeliveryRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), {
    actorUserId: c.get('principal').id,
    actorRole: 'user',
  }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env, result.subscription) : undefined)
  return c.json({ subscription: await userSubscriptionView(c, result.subscription), token: result.token, warning })
})
