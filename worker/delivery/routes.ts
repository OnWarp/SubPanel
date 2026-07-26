import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { readCatalog } from '../catalog/repository.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { compileAllSubscriptions, compileSubscription } from './compiler.js'
import {
  createSubscription,
  decryptSubscriptionToken,
  deleteSubscription,
  getSubscription,
  listAllSubscriptions,
  listSubscriptionsForUser,
  resetSubscriptionToken,
  updateSubscription,
  DeliveryError,
} from './service.js'
import { compiledKey } from './repository.js'
import { compiledArtifactSchema } from './schema.js'

const client = z.enum(['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'])
const createSchema = z.object({
  userId: z.string().regex(/^usr_[1-9]\d*$/),
  name: z.string().trim().min(1).max(128),
  groupIds: z.array(z.string().regex(/^grp_[1-9]\d*$/)),
  enabled: z.boolean().optional(),
  defaultClient: client.optional(),
})
const updateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  groupIds: z.array(z.string().regex(/^grp_[1-9]\d*$/)).optional(),
  enabled: z.boolean().optional(),
  defaultClient: client.optional(),
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
  const token = await decryptSubscriptionToken(c.env.DATA, subscription)
  const currentCatalogRevision = catalogRevision ?? (await readCatalog(c.env.DATA)).revision
  const origin = new URL(c.req.url).origin
  const links = Object.fromEntries(
    ['auto', 'mihomo', 'clash', 'clash-meta', 'stash', 'singbox', 'karing', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket']
      .map((name) => [name, `${origin}/sub/${token}${name === 'auto' ? '' : `/${name}`}`]),
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
      artifact.data.subscriptionRevision === subscription.revision &&
      artifact.data.catalogRevision === currentCatalogRevision
    ) diagnostics[name] = {
      inputNodes: artifact.data.inputNodes,
      outputNodes: artifact.data.outputNodes,
      skippedNodes: artifact.data.skippedNodes,
      diagnostics: artifact.data.diagnostics,
      available: artifact.data.available,
    }
  }
  return {
    id: subscription.id,
    userId: subscription.userId,
    name: subscription.name,
    groupIds: subscription.groupIds,
    tokenPrefix: subscription.tokenPrefix,
    enabled: subscription.enabled,
    defaultClient: subscription.defaultClient,
    revision: subscription.revision,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    links,
    diagnostics,
  }
}

export const adminDeliveryRoutes = new Hono<AppEnv>()

adminDeliveryRoutes.get('/', async (c) => {
  const [subscriptions, catalog] = await Promise.all([listAllSubscriptions(c.env.DATA), readCatalog(c.env.DATA)])
  return c.json({ subscriptions: await Promise.all(subscriptions.map((subscription) => view(c, subscription, catalog.revision))) })
})

adminDeliveryRoutes.post('/', async (c) => {
  const input = await readJson(c, createSchema)
  const result = await run(() => createSubscription(c.env.DATA, input, { actorRole: 'admin' }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env.DATA, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning }, 201)
})

adminDeliveryRoutes.patch('/:id', async (c) => {
  const input = await readJson(c, updateSchema)
  const subscription = await run(() => updateSubscription(c.env.DATA, c.req.param('id'), input, { actorRole: 'admin' }))
  const warning = await mutationWarning(() => compileAllSubscriptions(c.env.DATA))
  return c.json({ subscription: await view(c, subscription), warning })
})

adminDeliveryRoutes.put('/:id', async (c) => {
  const input = await readJson(c, updateSchema)
  const subscription = await run(() => updateSubscription(c.env.DATA, c.req.param('id'), input, { actorRole: 'admin' }))
  const warning = await mutationWarning(() => compileAllSubscriptions(c.env.DATA))
  return c.json({ subscription: await view(c, subscription), warning })
})

adminDeliveryRoutes.post('/:id/token/reset', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env.DATA, c.req.param('id'), { actorRole: 'admin' }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env.DATA, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning })
})

adminDeliveryRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env.DATA, c.req.param('id'), { actorRole: 'admin' }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env.DATA, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning })
})

adminDeliveryRoutes.delete('/:id', async (c) => {
  await run(() => deleteSubscription(c.env.DATA, c.req.param('id'), { actorRole: 'admin' }))
  return c.body(null, 204)
})

export const userDeliveryRoutes = new Hono<AppEnv>()

userDeliveryRoutes.get('/', async (c) => {
  const [subscriptions, catalog] = await Promise.all([
    listSubscriptionsForUser(c.env.DATA, c.get('principal').id),
    readCatalog(c.env.DATA),
  ])
  const views = await Promise.all(subscriptions.map(async (summary) => view(c, await getSubscription(c.env.DATA, summary.id), catalog.revision)))
  return c.json({ subscriptions: views })
})

userDeliveryRoutes.post('/:id/token/reset', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env.DATA, c.req.param('id'), {
    actorUserId: c.get('principal').id,
    actorRole: 'user',
  }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env.DATA, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning })
})

userDeliveryRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env.DATA, c.req.param('id'), {
    actorUserId: c.get('principal').id,
    actorRole: 'user',
  }))
  const warning = await mutationWarning(result.subscription.enabled ? () => compileSubscription(c.env.DATA, result.subscription) : undefined)
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning })
})
