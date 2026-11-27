import { readShareSettings } from '../shares/repository.js'
import { canUseShareFeature } from '../shares/service.js'
import { bindingSchema, getEffectiveTemplate, isLegacyTemplateVersion } from '../templates/repository.js'
import { validateTemplate, type Template } from '../templates/validation.js'
import { listPlans, subscriptionPlanState } from './plans.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { logAudit } from '../admin/audit.js'
import { DomainService } from '../domains/domain-service.js'
import { readCatalog } from '../catalog/repository.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { previewAuthorizedOutput, type AccessSnapshot } from './compiler.js'
import { readFetchSummary } from './fetch-stats.js'
import {
  classifySubscription,
  loadAccessSnapshot,
  presentSubscriptionStatus,
} from './lifecycle.js'
import {
  createSubscription,
  disableExpiredSubscriptions,
  decryptSubscriptionToken,
  deleteSubscription,
  getSubscription,
  listAllSubscriptions,
  resetSubscriptionToken,
  updateSubscription,
  DeliveryError,
} from './service.js'
import { directNodeIdsSchema, durationSchema } from './entitlement-templates.js'
import { readCurrentArtifact } from './artifacts.js'
import { catalogRelevantRevision } from './dependencies.js'
import { CLIENT_IDS } from '../renderers/index.js'
import { isWithinExpiryDays, subscriptionExpiryKind, type SubscriptionExpiryKind } from './expiry.js'
import { epochMillisSchema, type Subscription } from './schema.js'
import { attachTrafficUsage, measuredTrafficForSubscription } from './traffic-usage.js'

const client = z.enum(['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'])
const epochField = epochMillisSchema.nullable().optional()
const allowanceFields = {
  trafficGb: z.number().nonnegative().max(1e9).optional(),
  speedLimitMbps: z.number().int().nonnegative().max(1_000_000).optional(),
  deviceLimit: z.number().int().nonnegative().max(1_000_000).optional(),
}
const createSchema = z.object({
  ...allowanceFields,
  mode: z.literal('manual').optional(),
  duration: durationSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  userId: z.string().regex(/^usr_[1-9]\d*$/).nullable().optional(),
  planId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(128),
  groupIds: z.array(z.string().regex(/^grp_[1-9]\d*$/)),
  nodeIds: directNodeIdsSchema.optional(),
  enabled: z.boolean().optional(),
  defaultClient: client.optional(),
  startsAt: epochField,
  expiresAt: epochField,
  templateBinding: bindingSchema.optional(),
}).strict()
const templateCreateSchema = createSchema.omit({ mode: true, planId: true, userId: true, deviceLimit: true })
  .partial().extend({
    mode: z.literal('template'),
    templateVersionId: z.uuid(),
    userId: z.string().regex(/^usr_[1-9]\d*$/),
  }).strict()
const updateSchema = z.object({
  ...allowanceFields,
  planId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(128).optional(),
  groupIds: z.array(z.string().regex(/^grp_[1-9]\d*$/)).optional(),
  nodeIds: directNodeIdsSchema.optional(),
  enabled: z.boolean().optional(),
  defaultClient: client.optional(),
  startsAt: epochField,
  expiresAt: epochField,
  templateBinding: bindingSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
const emptySchema = z.object({}).default({})

const deliveryNotice = '下次下载将按当前订阅生成'

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

type ViewOptions = {
  snapshot?: AccessSnapshot
  audience?: 'admin' | 'user'
}

async function view(
  c: Context<AppEnv>,
  subscription: Awaited<ReturnType<typeof getSubscription>>,
  viewOptions: ViewOptions = {},
) {
  const audience = viewOptions.audience ?? 'admin'
  const token = await decryptSubscriptionToken(c.env, subscription)
  if (!subscription.encryptedToken) {
    const current = await getSubscription(c.env, subscription.id)
    if (current.userId !== subscription.userId) throw apiError(409, 'SUBSCRIPTION_CONFLICT', '订阅已被修改，请刷新后重试')
    subscription = current
  }
  const plan = subscription.planId
    ? (viewOptions.snapshot?.plans ?? await listPlans(c.env.DB)).find(item => item.id === subscription.planId) ?? null
    : null
  // Subscription links are always generated on the primary subscription
  // domain (plan section 7.1). When no usable primary is configured the
  // links stay empty and linkError tells the UI to prompt for domain
  // configuration instead of silently falling back to the request Host.
  const links = await new DomainService(c.env.DB).buildSubscriptionLinks(token)
  const linkError = links === null ? 'SUBSCRIPTION_DOMAIN_NOT_CONFIGURED' : null
  let configVersion: number | null = null
  let conversionMode: string | null = null
  let conversionTemplate: string | null = null
  let template: Template | undefined
  let templateInvalid = false
  let effective: Awaited<ReturnType<typeof getEffectiveTemplate>> | undefined
  try {
    effective = await getEffectiveTemplate(c.env.DB, subscription.id)
    configVersion = effective.sequence
    conversionMode = effective.mode
    conversionTemplate = effective.template_name
    if (effective.yaml !== null) template = validateTemplate(effective.yaml, isLegacyTemplateVersion(effective.validator_version)).template
  } catch {
    templateInvalid = true
  }
  const singbox = await getEffectiveTemplate(c.env.DB, subscription.id, 'singbox').catch(() => undefined)
  const access = await classifySubscription(c.env, subscription, new Date().toISOString(), viewOptions.snapshot, template, templateInvalid, Boolean(singbox?.version_id))
  const presented = presentSubscriptionStatus(access.status, audience)
  const fetchSummary = audience === 'admin' ? await readFetchSummary(c.env.DATA, subscription.id) : undefined
  const diagnostics: Record<string, unknown> = {}
  if (access.status === 'active' || access.status === 'incompatible') {
    await Promise.all(CLIENT_IDS.map(async name => {
      const versionId = name === 'singbox' ? singbox?.version_id : name === 'mihomo' ? effective?.version_id : undefined
      if ((name === 'mihomo' && templateInvalid) || (name === 'singbox' && !singbox)) return
      const relevant = await catalogRelevantRevision(access.nodes, access.speed, name)
      const { artifact } = await readCurrentArtifact(c.env.DATA, subscription, name, relevant, versionId)
      if (artifact) diagnostics[name] = {
        inputNodes: artifact.inputNodes,
        outputNodes: artifact.outputNodes,
        skippedNodes: artifact.skippedNodes,
        diagnostics: artifact.diagnostics,
        available: artifact.available,
        rendererVersion: artifact.rendererVersion,
        templateVersionId: artifact.templateVersionId,
      }
    }))
  }
  return {
    sourceType: subscription.sourceType ?? 'legacy',
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
    directNodeCount: subscription.nodeIds?.length ?? 0,
    tokenPrefix: subscription.tokenPrefix,
    enabled: subscription.enabled,
    defaultClient: subscription.defaultClient,
    revision: subscription.revision,
    startsAt: subscription.startsAt,
    expiresAt: subscription.expiresAt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    links: links ?? {},
    linkError,
    diagnostics,
    ...presented,
    authorizedNodeCount: access.authorizedNodeCount,
    authorizedGroupIds: access.authorizedGroupIds,
    formats: access.formats,
    fetch: fetchSummary,
    configVersion,
    ...(audience === 'admin' ? {
      ...(subscription.nodeIds?.length ? { nodeIds: subscription.nodeIds } : {}),
      ...(subscription.templateVersionId ? {
        templateVersionId: subscription.templateVersionId,
        entitlementTemplateName: subscription.entitlementTemplateName,
        entitlementVersionNumber: subscription.entitlementVersionNumber,
      } : {}),
      conversion: {
        mode: conversionMode,
        templateName: conversionTemplate,
        versionId: configVersion,
        note: '显示现行渲染能力',
      },
    } : {}),
  }
}

async function userSubscriptionView(c: Context<AppEnv>, subscription: Awaited<ReturnType<typeof getSubscription>>, snapshot?: AccessSnapshot) {
  const body = await view(c, subscription, { snapshot, audience: 'user' })
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
  const [subscriptions, snapshot] = await Promise.all([listAllSubscriptions(c.env), loadAccessSnapshot(c.env)])
  const query = c.req.query()
  const viewOptions = { snapshot, audience: 'admin' as const }
  if (!hasAdminSubscriptionParams(query)) {
    return c.json({ subscriptions: await Promise.all(subscriptions.map((subscription) => view(c, subscription, viewOptions))) })
  }
  const { page, pageSize } = parsePagination(query)
  const filters = parseAdminSubscriptionFilters(query)
  const userNames = new Map(snapshot.users.map((user) => [user.id, user.username]))
  const groupNames = new Map(snapshot.catalog.groups.map((group) => [group.id, group.name]))
  const now = Date.now()
  const filtered = subscriptions.filter((subscription) =>
    matchesAdminSubscriptionFilters(subscription, filters, userNames, groupNames, now))
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize)
  return c.json({
    subscriptions: await Promise.all(pageItems.map((subscription) => view(c, subscription, viewOptions))),
    total: filtered.length,
    page,
    pageSize,
  })
})

adminDeliveryRoutes.post('/batch', () => {
  throw apiError(409, 'BATCH_PREVIEW_REQUIRED', '请先预览批量任务，再确认执行')
})

adminDeliveryRoutes.post('/output-preview', async (c) => {
  const input = await readJson(c, z.object({
    planId: z.string().min(1).nullable().optional(),
    userId: z.string().nullable().optional(),
    speedLimitMbps: allowanceFields.speedLimitMbps,
    groupIds: z.array(z.string()),
    nodeIds: directNodeIdsSchema.optional(),
    defaultClient: client.optional(),
  }))
  const plans = await listPlans(c.env.DB)
  const plan = input.planId ? plans.find((item) => item.id === input.planId) ?? null : null
  const catalog = await readCatalog(c.env)
  const preview = await previewAuthorizedOutput(catalog, input.userId === null || !input.planId ? input.groupIds : plan?.groupIds ?? [],
    input.groupIds, input.defaultClient ?? 'mihomo', input.speedLimitMbps ?? plan?.speedLimitMbps ?? 0, input.planId ? undefined : input.nodeIds)
  return c.json({
    planGroupIds: plan?.groupIds ?? [],
    selectedGroupIds: input.groupIds,
    authorizedGroupIds: preview.authorizedGroupIds,
    outputNodes: preview.outputNodes,
  })
})

adminDeliveryRoutes.post('/', async (c) => {
  const { mode: _mode, ...input } = await readJson(c, z.union([createSchema, templateCreateSchema]))
  const rawKey = c.req.header('Idempotency-Key') ?? input.idempotencyKey
  const key = z.string().trim().min(1).max(128).optional().safeParse(rawKey)
  if (!key.success || (input.idempotencyKey && input.idempotencyKey !== key.data)) {
    throw apiError(422, 'VALIDATION_FAILED', '幂等键无效')
  }
  const result = await run(() => createSubscription(c.env, { ...input, idempotencyKey: key.data }, {
    actorRole: 'admin', actorUserId: c.get('principal').id,
  }))
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning: deliveryNotice }, 201)
})

adminDeliveryRoutes.get('/:id', async (c) => {
  const subscription = await run(() => getSubscription(c.env, c.req.param('id')))
  return c.json({ subscription: await view(c, subscription) })
})

adminDeliveryRoutes.patch('/:id', async (c) => {
  const input = await readJson(c, updateSchema)
  const subscription = await run(() => updateSubscription(c.env, c.req.param('id'), input, { actorRole: 'admin' }))
  return c.json({ subscription: await view(c, subscription), warning: deliveryNotice })
})

adminDeliveryRoutes.put('/:id', async (c) => {
  const input = await readJson(c, updateSchema)
  const subscription = await run(() => updateSubscription(c.env, c.req.param('id'), input, { actorRole: 'admin' }))
  return c.json({ subscription: await view(c, subscription), warning: deliveryNotice })
})

adminDeliveryRoutes.post('/:id/token/reset', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), { actorRole: 'admin' }))
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning: deliveryNotice })
})

adminDeliveryRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), { actorRole: 'admin' }))
  return c.json({ subscription: await view(c, result.subscription), token: result.token, warning: deliveryNotice })
})

adminDeliveryRoutes.delete('/:id', async (c) => {
  await run(() => deleteSubscription(c.env, c.req.param('id'), { actorRole: 'admin' }))
  return c.body(null, 204)
})

export const userDeliveryRoutes = new Hono<AppEnv>()

userDeliveryRoutes.get('/', async (c) => {
  await disableExpiredSubscriptions(c.env)
  const [subscriptions, snapshot, shareSettings] = await Promise.all([
    listAllSubscriptions(c.env),
    loadAccessSnapshot(c.env),
    readShareSettings(c.env),
  ])
  const { id: userId, role } = c.get('principal')
  const views = await Promise.all(subscriptions.filter(subscription => subscription.userId === userId)
    .map(subscription => userSubscriptionView(c, subscription, snapshot)))
  return c.json({ subscriptions: views, shareEnabled: canUseShareFeature(role, shareSettings) })
})

userDeliveryRoutes.get('/:id', async (c) => {
  const subscription = await run(() => getSubscription(c.env, c.req.param('id'), c.get('principal').id))
  return c.json({ subscription: await userSubscriptionView(c, subscription) })
})

userDeliveryRoutes.post('/:id/token/reset', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), {
    actorUserId: c.get('principal').id,
    actorRole: 'user',
  }))
  try {
    await logAudit(c.env.DB, c.get('principal').id, 'post.subscriptions.token.reset', 'subscriptions', result.subscription.id, { status: 200 })
  } catch {
    // Audit is best-effort and must not include the new token.
  }
  return c.json({ subscription: await userSubscriptionView(c, result.subscription), token: result.token, warning: deliveryNotice })
})

userDeliveryRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetSubscriptionToken(c.env, c.req.param('id'), {
    actorUserId: c.get('principal').id,
    actorRole: 'user',
  }))
  try {
    await logAudit(c.env.DB, c.get('principal').id, 'post.subscriptions.token.reset', 'subscriptions', result.subscription.id, { status: 200 })
  } catch {
    // Audit is best-effort and must not include the new token.
  }
  return c.json({ subscription: await userSubscriptionView(c, result.subscription), token: result.token, warning: deliveryNotice })
})
