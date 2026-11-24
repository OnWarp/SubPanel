import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { requireAuth } from '../accounts/auth.js'
import { listEnabledPlatforms, primaryDomainOriginSafe } from '../domains/service.js'
import { apiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { clientAliases, clientFromUserAgent, tokenPattern } from '../public-subscriptions.js'
import { getEffectiveTemplate } from '../templates/repository.js'
import { resolveUserSubscription } from './aggregate.js'
import { readArtifactCatalog } from './artifacts.js'
import { bindingInput, mutateBinding, planBinding, readBindings, replaceInput, type Binding, type BindingChange } from './bindings.js'
import { renderResolvedSubscription } from './compiler.js'
import { createEntitlementTemplate, templateInputSchema } from './entitlement-templates.js'
import { allowSubscriptionFetch } from './public-rate-limit.js'
import { clientIdSchema } from './schema.js'
import { verifyShadowUser } from './shadow.js'
import { DELIVERY_D1_READY_KEY, isModuleReady } from '../db/module-switch.js'
import { loadUnifiedArtifact } from './unified-artifacts.js'
import { accountAvailable, readUserAccess, requireUnifiedSubscription, resetUserToken, revealUserToken, subscriptionNotFound } from './user-access.js'

const resetInput = z.strictObject({ expectedRevision: z.number().int().positive() })
const removeInput = resetInput.extend({ requestId: z.string().min(1).max(128) })

const iso = (date: number | null) => date === null ? null : new Date(date).toISOString()

function bindingView(row: Binding) {
  return {
    templateId: row.template_id, status: row.status, revision: row.revision,
    startsAt: iso(row.starts_at), expiresAt: iso(row.expires_at),
  }
}

function changesView(changes: BindingChange[]) {
  return changes.map(({ before, after }) => ({
    before: before ? bindingView(before) : null,
    after: bindingView(after),
  }))
}

async function privateResponse(c: Context<AppEnv>, next: () => Promise<void>, publicAccess = false) {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await requireUnifiedSubscription(c.env.DB, publicAccess)
  await next()
}

export const unifiedUserRoutes = new Hono<AppEnv>()
unifiedUserRoutes.use('*', requireAuth, (c, next) => privateResponse(c, next, true))

unifiedUserRoutes.get('/', async c => {
  const catalog = await readArtifactCatalog(c.env)
  const result = await resolveUserSubscription(c.env.DB, c.get('principal').id, Date.now(), catalog)
  const token = result.diagnostics.length ? null : await revealUserToken(c.env, result.access)
  const origin = token && (await primaryDomainOriginSafe(c.env.DB, 'subscription') ?? new URL(c.req.url).origin)
  const enabledFormats = await listEnabledPlatforms(c.env.DB)
  const supportedFormats = [...new Set(enabledFormats.flatMap(({ platform }) =>
    platform === 'auto' ? [] : [clientAliases[platform] ?? platform]))]
  return c.json({
    status: result.status,
    expiresAt: iso(result.expiresAt),
    lastExpiredAt: result.status === 'expired' ? iso(result.lastExpiredAt) : null,
    permanent: result.permanent,
    subscriptionUrl: origin && token ? `${origin}/s/${token}` : null,
    supportedFormats,
    hasAvailableNodes: result.nodes.length > 0,
  })
})

unifiedUserRoutes.post('/reset-token', async c => {
  const user = c.get('principal').id
  const access = await readUserAccess(c.env.DB, { userId: user })
  if (!accountAvailable(access) || access.revision === null) throw subscriptionNotFound()
  await resetUserToken(c.env, user, access.revision, user)
  return c.json({ ok: true })
})

export const unifiedAdminRoutes = new Hono<AppEnv>()
const bindings = '/users/:id/template-bindings'
const subscription = '/users/:id/subscription'
unifiedAdminRoutes.use(bindings, privateResponse)
unifiedAdminRoutes.use(`${bindings}/*`, privateResponse)
unifiedAdminRoutes.use(`${subscription}/*`, privateResponse)

unifiedAdminRoutes.get(bindings, async c => {
  const access = await readUserAccess(c.env.DB, { userId: c.req.param('id') })
  if (!access) throw subscriptionNotFound()
  const rows = await readBindings(c.env.DB, access.user_id)
  return c.json({ revision: access.revision ?? 0, bindings: rows.map(row => ({
    ...bindingView(row), templateStatus: row.template_status, templateRevision: row.template_revision,
    scope: row.owner_user_id === null ? 'shared' : 'private',
  })) })
})

unifiedAdminRoutes.post(`${bindings}/private-template`, async c => {
  const userId = c.req.param('id')
  if (!accountAvailable(await readUserAccess(c.env.DB, { userId }))) throw subscriptionNotFound()
  const input = await readJson(c, templateInputSchema)
  const template = await createEntitlementTemplate(c.env.DB, input, c.get('principal').id, 'enabled', userId)
  return c.json({ template: { ...template, scope: 'private', ownerUserId: userId } }, 201)
})

unifiedAdminRoutes.get(`${bindings}/:templateId/preview`, async c => {
  const revision = c.req.query('expectedRevision')
  const expiryType = c.req.query('expiry') ?? 'default'
  const time = c.req.query('time')
  const mode = c.req.query('mode') ?? 'assign'
  const startsAt = c.req.query('startsAt')
  const isReplace = mode === 'replace' || mode === 'replaceAll'
  const args = {
    mode, expectedRevision: revision === undefined ? undefined : Number(revision), requestId: 'preview',
    ...(startsAt !== undefined ? { startsAt: Number(startsAt) } : {}),
    ...(mode === 'assign' || mode === 'renew' || isReplace ? { expiry: expiryType === 'duration'
      ? { type: 'duration', duration: { unit: c.req.query('unit'), value: Number(time) } }
      : expiryType === 'absolute' ? { type: 'absolute', expiresAt: Number(time) } : { type: expiryType } } : {}),
    ...(isReplace ? { newTemplateId: c.req.param('templateId') } : {}),
    ...(mode === 'replace' ? { oldTemplateId: c.req.query('oldTemplateId') } : {}),
    ...(mode === 'replaceAll' ? { confirm: c.req.query('confirm') === 'true' } : {}),
  }
  const input = (isReplace ? replaceInput : bindingInput).safeParse(args)
  if (!input.success) throw apiError(400, 'BINDING_PREVIEW_INVALID', '授权预览参数无效')
  const { changes } = await planBinding(c.env.DB, c.req.param('id'), c.req.param('templateId'), input.data, Date.now())
  return c.json({ changes: changesView(changes) })
})

unifiedAdminRoutes.put(`${bindings}/:templateId`, async c => {
  const input = await readJson(c, bindingInput)
  const result = await mutateBinding(c.env, c.req.param('id'), c.req.param('templateId'), input, c.get('principal').id)
  return c.json({ revision: result.revision, changes: changesView(result.changes) })
})

unifiedAdminRoutes.delete(`${bindings}/:templateId`, async c => {
  const input = await readJson(c, removeInput)
  const result = await mutateBinding(c.env, c.req.param('id'), c.req.param('templateId'),
    { ...input, mode: 'revoke' }, c.get('principal').id)
  return c.json({ revision: result.revision, changes: changesView(result.changes) })
})

unifiedAdminRoutes.post(`${bindings}/replace`, async c => {
  const input = await readJson(c, replaceInput)
  const result = await mutateBinding(c.env, c.req.param('id'), input.newTemplateId, input, c.get('principal').id)
  return c.json({ revision: result.revision, changes: changesView(result.changes) })
})

unifiedAdminRoutes.post(`${subscription}/reset-token`, async c => {
  const input = await readJson(c, resetInput)
  return c.json(await resetUserToken(c.env, c.req.param('id'), input.expectedRevision, c.get('principal').id))
})

unifiedAdminRoutes.get(`${subscription}/preview`, async c => {
  const client = clientIdSchema.safeParse(c.req.query('client') ?? 'generic')
  if (!client.success) throw apiError(400, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')
  const now = Date.now()
  const result = await resolveUserSubscription(c.env.DB, c.req.param('id'), now, await readArtifactCatalog(c.env))
  if (!result.access) throw subscriptionNotFound()
  const effective = client.data === 'mihomo' || client.data === 'singbox'
    ? await getEffectiveTemplate(c.env.DB, null, client.data) : undefined
  const output = await renderResolvedSubscription(c.env, { id: null, revision: result.access.revision ?? 0 },
    client.data, result, new Date(now).toISOString(), undefined, undefined, effective)
  return c.json({
    status: result.status, expiresAt: iso(result.expiresAt), permanent: result.permanent, nextTransitionAt: iso(result.nextTransitionAt),
    nodeCount: result.nodes.length, outputNodes: output.outputNodes, diagnostics: result.diagnostics,
    rendererDiagnostics: output.diagnostics,
  })
})

unifiedAdminRoutes.get(`${subscription}/shadow`, async c => {
  if (!await isModuleReady(c.env.DB, DELIVERY_D1_READY_KEY)) {
    throw apiError(503, 'UNIFIED_SHADOW_UNAVAILABLE', '旧订阅 D1 数据未就绪')
  }
  return c.json(await verifyShadowUser(c.env, c.req.param('id'), Date.now(), await readArtifactCatalog(c.env)))
})

export const unifiedPublicRoutes = new Hono<AppEnv>()
unifiedPublicRoutes.all('/s', c => {
  c.header('Cache-Control', 'private, no-store')
  throw subscriptionNotFound()
})
unifiedPublicRoutes.use('/s/*', (c, next) => privateResponse(c, next, true))
unifiedPublicRoutes.get('/s/:token/:client?', async c => {
  const limited = () => {
    c.header('Retry-After', '60')
    return apiError(429, 'SUBSCRIPTION_RATE_LIMITED', '请求过于频繁')
  }
  const address = c.req.header('CF-Connecting-IP') ?? 'no-edge-address'
  if (!await allowSubscriptionFetch(c.env.DB, 'address', address, undefined, 'unified_subscription')) throw limited()
  const configured = Number(c.env.PUBLIC_FETCH_GLOBAL_LIMIT)
  const globalLimit = Number.isSafeInteger(configured) && configured > 0 ? configured : 2400
  if (!await allowSubscriptionFetch(c.env.DB, 'global', 'all', globalLimit, 'unified_subscription')) throw limited()
  const raw = c.req.param('token')
  if (!tokenPattern.test(raw)) throw subscriptionNotFound()
  const tokenHash = await hashToken(raw)
  if (!await allowSubscriptionFetch(c.env.DB, 'subscription', `token:${tokenHash}`, undefined, 'unified_subscription')) throw limited()
  const access = await readUserAccess(c.env.DB, { tokenHash })
  if (!accountAvailable(access) || access.enabled !== 1) throw subscriptionNotFound()
  if (!await allowSubscriptionFetch(c.env.DB, 'subscription', `user:${access.user_id}`, undefined, 'unified_subscription')) throw limited()

  const detected = clientFromUserAgent(c.req.header('User-Agent') ?? '')
  const requested = (c.req.param('client') ?? c.req.query('format') ??
    (detected === 'generic' ? access.default_client ?? detected : detected)).toLowerCase()
  const client = clientIdSchema.safeParse(clientAliases[requested] ?? requested)
  if (!client.success) throw apiError(404, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')
  const artifact = await loadUnifiedArtifact(c.env, access.user_id, tokenHash, client.data)
  if (!artifact.available && (client.data === 'mihomo' || artifact.inputNodes > 0)) {
    throw apiError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点')
  }
  c.header('Content-Type', artifact.contentType)
  c.header('Content-Disposition', `attachment; filename="${artifact.fileName.replaceAll('"', '')}"`)
  c.header('ETag', artifact.etag)
  c.header('x-subscription-client', client.data)
  if (artifact.available && c.req.header('If-None-Match')?.split(',')
    .some(value => value.trim().replace(/^W\//u, '') === artifact.etag)) return c.body(null, 304)
  return c.body(artifact.body)
})

unifiedPublicRoutes.all('/s/*', () => { throw subscriptionNotFound() })
