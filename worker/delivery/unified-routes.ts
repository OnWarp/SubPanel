import { planUserEnabled, readPlanUser } from '../plans/entitlements.js'
import { resolveForApi } from '../plans/routes.js'
import { changeToken, readOwnedInstance } from '../plans/service.js'
import { hasPlanAggregate, planStorageAvailable, readAliasTarget, readPlanToken } from '../plans/tokens.js'
import { tokenPattern } from './subscription-token.js'
import { readShare, readShareSettings } from '../shares/repository.js'
import { noteSubscriptionFetch, readUserFetchSummary, stageSubscriptionFetch } from './fetch-stats.js'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { requireAuth } from '../accounts/auth.js'
import { listEnabledPlatforms } from '../domains/service.js'
import { DomainService } from '../domains/domain-service.js'
import { apiError, ApiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { clientAliases, clientFromUserAgent } from './public-client.js'
import { resolveUserSubscription } from './aggregate.js'
import { readArtifactCatalog } from './artifacts.js'
import { bindingInput, mutateBinding, planBinding, readBindings, replaceInput, type Binding, type BindingChange } from './bindings.js'
import { renderResolvedSubscription } from './compiler.js'
import { createEntitlementTemplate, templateInputSchema } from './entitlement-templates.js'
import { allowSubscriptionFetch } from './public-rate-limit.js'
import { clientIdSchema } from './schema.js'
import { enforceUnifiedOutputLimit, loadUnifiedArtifact } from './unified-artifacts.js'
import { accountAvailable, prepareUserAccess, readUserAccess, requireUnifiedSubscription, resetUserToken, revealUserToken, subscriptionNotFound, unifiedOperationsEnabled } from './user-access.js'

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

async function privateResponse(c: Context<AppEnv>, next: () => Promise<void>, publicAccess = false, signedIn = false) {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  try {
    await requireUnifiedSubscription(c.env.DB, publicAccess)
  } catch (error) {
    if (signedIn && error instanceof ApiError && error.status === 404) {
      throw apiError(404, 'UNIFIED_SUBSCRIPTION_DISABLED', '统一订阅暂未开放')
    }
    throw error
  }
  await next()
}

export const unifiedUserRoutes = new Hono<AppEnv>()
unifiedUserRoutes.use('*', requireAuth, (c, next) => privateResponse(c, next, true, true))

unifiedUserRoutes.get('/', async c => {
  const userId = c.get('principal').id
  const access = await readUserAccess(c.env.DB, { userId })
  if (accountAvailable(access) && access.revision === null) {
    await (await prepareUserAccess(c.env, userId, new Date().toISOString())).run()
  }
  const result = await resolveUserSubscription(c.env.DB, userId, Date.now(), await readArtifactCatalog(c.env))
  const token = result.diagnostics.length ? null : await revealUserToken(c.env, result.access)
  const subscriptionUrl = token ? await new DomainService(c.env.DB).buildUnifiedSubscriptionUrl(token) : null
  const [enabledFormats, shareSettings] = await Promise.all([listEnabledPlatforms(c.env.DB), readShareSettings(c.env)])
  const supportedFormats = [...new Set(enabledFormats.flatMap(({ platform }) =>
    platform === 'auto' ? [] : [clientAliases[platform] ?? platform]))]
  return c.json({
    status: result.status,
    expiresAt: iso(result.expiresAt),
    lastExpiredAt: result.status === 'expired' ? iso(result.lastExpiredAt) : null,
    permanent: result.permanent,
    subscriptionUrl,
    supportedFormats,
    importPlatforms: enabledFormats.filter(({ platform }) => platform !== 'auto'),
    shareEnabled: shareSettings.enabled && shareSettings.createAllowed,
    hasAvailableNodes: result.nodes.length > 0,
    nodeCount: result.nodes.length,
  })
})

unifiedUserRoutes.get('/nodes', async c => {
  const result = await resolveUserSubscription(c.env.DB, c.get('principal').id, Date.now(), await readArtifactCatalog(c.env))
  return c.json({ nodes: result.nodes.map(node => ({ name: node.displayName, protocol: node.protocol })) })
})

unifiedUserRoutes.post('/reset-token', async c => {
  const user = c.get('principal').id
  const access = await readUserAccess(c.env.DB, { userId: user })
  if (!accountAvailable(access) || access.revision === null) throw subscriptionNotFound()
  if (await planStorageAvailable(c.env.DB) && await hasPlanAggregate(c.env.DB, user)) {
    await changeToken(c.env, user, null, user, 'reset', access.revision)
  } else {
    await resetUserToken(c.env, user, access.revision, user)
  }
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
  const id = c.req.param('id')
  const actor = c.get('principal').id
  if (await planStorageAvailable(c.env.DB) && await hasPlanAggregate(c.env.DB, id)) {
    await changeToken(c.env, id, null, actor, 'reset', input.expectedRevision)
    return c.json({ revision: input.expectedRevision + 1 })
  }
  return c.json(await resetUserToken(c.env, id, input.expectedRevision, actor))
})

unifiedAdminRoutes.get(`${subscription}/summary`, async c => {
  const result = await resolveUserSubscription(c.env.DB, c.req.param('id'), Date.now(), await readArtifactCatalog(c.env))
  if (!result.access) throw subscriptionNotFound()
  const token = await unifiedOperationsEnabled(c.env.DB) && !result.diagnostics.length
    ? await revealUserToken(c.env, result.access) : null
  const subscriptionUrl = token ? await new DomainService(c.env.DB).buildUnifiedSubscriptionUrl(token) : null
  const logs = await c.env.DB.prepare(`SELECT id, action, created_at AS createdAt FROM audit_logs
    WHERE target_type='user' AND target_id=? ORDER BY created_at DESC, id DESC LIMIT 50`)
    .bind(result.access.user_id).all<{ id: string; action: string; createdAt: string }>()
  return c.json({
    expiresAt: iso(result.expiresAt), permanent: result.permanent,
    status: result.status, effectiveBindingCount: result.effectiveTemplateIds.length,
    latestExpiresAt: iso(result.latestExpiresAt), lastExpiredAt: iso(result.lastExpiredAt),
    nodes: result.nodes.map(node => ({ name: node.displayName, protocol: node.protocol })),
    subscriptionUrl,
    logs: logs.results,
  })
})

unifiedAdminRoutes.get(`${subscription}/preview`, async c => {
  const client = clientIdSchema.safeParse(c.req.query('client') ?? 'generic')
  if (!client.success) throw apiError(400, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')
  const now = Date.now()
  const result = await resolveUserSubscription(c.env.DB, c.req.param('id'), now, await readArtifactCatalog(c.env))
  if (!result.access) throw subscriptionNotFound()
  const output = await renderResolvedSubscription(c.env, { id: null, revision: result.access.revision ?? 0 },
    client.data, result, new Date(now).toISOString())
  return c.json({
    status: result.status, expiresAt: iso(result.expiresAt), permanent: result.permanent, nextTransitionAt: iso(result.nextTransitionAt),
    nodeCount: result.nodes.length, outputNodes: output.outputNodes, diagnostics: result.diagnostics,
    rendererDiagnostics: output.diagnostics,
  })
})

unifiedAdminRoutes.get(`${subscription}/fetch-stats`, async c => {
  const userId = c.req.param('id')
  if (!await readUserAccess(c.env.DB, { userId })) throw subscriptionNotFound()
  const archived = await c.env.DB.prepare('SELECT id FROM legacy_subscriptions_archive WHERE user_id=? ORDER BY id')
    .bind(userId).all<{ id: string }>()
  return c.json({ fetches: await readUserFetchSummary(c.env.DATA, userId, archived.results.map(row => row.id)), measuredTraffic: null })
})

export const unifiedPublicRoutes = new Hono<AppEnv>()
unifiedPublicRoutes.all('/s', c => {
  c.header('Cache-Control', 'private, no-store')
  throw subscriptionNotFound()
})
function publicRateLimited(c: Context<AppEnv>) {
  c.header('Retry-After', '60')
  return apiError(429, 'SUBSCRIPTION_RATE_LIMITED', '请求过于频繁')
}

// A browser document asks for text/html and has no client segment. Those
// navigations render the share page. Other clients keep the JSON contract.
function shareDocument(c: Context<AppEnv>): boolean {
  return !c.req.param('client') && (c.req.header('Accept') ?? '').includes('text/html')
}

async function shareShell(c: Context<AppEnv>): Promise<Response> {
  const shell = await c.env.ASSETS.fetch(new URL('/', c.req.url))
  const headers = new Headers(shell.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Referrer-Policy', 'no-referrer')
  const html = await shell.text()
  // Vite's dev shell has one inline refresh preamble. The document CSP
  // allows that exact script so the share page can render during local dev.
  const preamble = html.match(/<script type="module">([\s\S]*?injectIntoGlobalHook[\s\S]*?)<\/script>/u)
  if (preamble) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preamble[1])))
    let binary = ''
    for (const byte of digest) binary += String.fromCharCode(byte)
    const hash = btoa(binary)
    headers.set('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: https://www.gravatar.com https://api.dicebear.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'sha256-" + hash + "'; connect-src 'self'")
  }
  headers.delete('content-length')
  return new Response(html, { status: shell.status, headers })
}

async function limitPublicFetch(c: Context<AppEnv>, next: () => Promise<void>) {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const address = c.req.header('CF-Connecting-IP') ?? 'no-edge-address'
  if (!await allowSubscriptionFetch(c.env.DB, 'address', address, undefined, 'unified_subscription')) throw publicRateLimited(c)
  const configured = Number(c.env.PUBLIC_FETCH_GLOBAL_LIMIT)
  const globalLimit = Number.isSafeInteger(configured) && configured > 0 ? configured : 2400
  if (!await allowSubscriptionFetch(c.env.DB, 'global', 'all', globalLimit, 'unified_subscription')) throw publicRateLimited(c)
  await next()
}

unifiedPublicRoutes.use('/s/*', limitPublicFetch)
unifiedPublicRoutes.use('/sub/*', limitPublicFetch)

function publicClient(c: Context<AppEnv>, defaultClient?: string | null) {
  const detected = clientFromUserAgent(c.req.header('User-Agent') ?? '')
  const requested = (c.req.param('client') ?? c.req.query('format') ??
    (detected === 'generic' ? defaultClient ?? detected : detected)).toLowerCase()
  const client = clientIdSchema.safeParse(clientAliases[requested] ?? requested)
  if (!client.success) throw apiError(404, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')
  return client.data
}

function etagMatches(c: Context<AppEnv>, etag: string) {
  return c.req.header('If-None-Match')?.split(',')
    .some(value => value.trim().replace(/^W\//u, '') === etag)
}

async function renderPlanLink(c: Context<AppEnv>, userId: string, instanceId: string | null) {
  const db = c.env.DB
  const user = await readPlanUser(db, userId)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  if (instanceId !== null) {
    const instance = await readOwnedInstance(db, instanceId, userId)
    if (!instance || instance.status === 'revoked') throw subscriptionNotFound()
  }
  if (!await allowSubscriptionFetch(db, 'subscription', `user:${userId}`, undefined, 'unified_subscription')) throw publicRateLimited(c)
  const now = Date.now()
  const access = await readUserAccess(db, { userId })
  const client = publicClient(c, access?.default_client)
  const { catalog, nodes } = await resolveForApi(db, user, instanceId, now)
  const artifact = await renderResolvedSubscription(c.env, { id: null, revision: access?.revision ?? 1 }, client,
    { catalog, nodes, speed: 0, zeroNodeReason: nodes.length ? null : 'noEnabledNodes' }, new Date(now).toISOString())
  enforceUnifiedOutputLimit(artifact.body)
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Content-Type', artifact.contentType)
  c.header('Content-Disposition', `attachment; filename="${artifact.fileName.replaceAll('"', '')}"`)
  c.header('x-subscription-client', client)
  if (artifact.available) {
    c.header('ETag', artifact.etag)
    if (etagMatches(c, artifact.etag)) return c.body(null, 304)
  }
  return c.body(artifact.body)
}

unifiedPublicRoutes.get('/sub/:token/:client?', async c => {
  const raw = c.req.param('token')
  if (!tokenPattern.test(raw) || !await planStorageAvailable(c.env.DB)) return c.notFound()
  const digest = await hashToken(raw)
  if (!await allowSubscriptionFetch(c.env.DB, 'subscription', `token:${digest}`, undefined, 'unified_subscription')) throw publicRateLimited(c)
  const target = await readAliasTarget(c.env.DB, digest)
  if (!target) return c.notFound()
  try {
    await requireUnifiedSubscription(c.env.DB, true)
    return await renderPlanLink(c, target.userId, target.instanceId)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return c.notFound()
    throw error
  }
})

unifiedPublicRoutes.get('/s/:token/:client?', async c => {
  const started = Date.now()
  const raw = c.req.param('token')
  const document = shareDocument(c)
  // Legacy browser navigations still reach the share UI for short or malformed
  // links. Phase 3 credentials have a fixed 43-character shape.
  const legacyDocument = document && raw.length !== 43
  if (!tokenPattern.test(raw)) {
    if (legacyDocument) return shareShell(c)
    throw subscriptionNotFound()
  }
  const tokenHash = await hashToken(raw)
  if (!await allowSubscriptionFetch(c.env.DB, 'subscription', `token:${tokenHash}`, undefined, 'unified_subscription')) throw publicRateLimited(c)
  const planStorage = await planStorageAvailable(c.env.DB)
  const planToken = planStorage ? await readPlanToken(c.env.DB, tokenHash) : null
  if (planToken) {
    if (planToken.revoked_at !== null) throw subscriptionNotFound()
    await requireUnifiedSubscription(c.env.DB, true)
    const instanceId = planToken.scope === 'package' ? planToken.user_plan_id : null
    if (planToken.scope === 'package' && instanceId === null) throw subscriptionNotFound()
    return renderPlanLink(c, planToken.user_id, instanceId)
  }
  if (document && await readShare(c.env, tokenHash)) return shareShell(c)
  try {
    await requireUnifiedSubscription(c.env.DB, true)
  } catch (error) {
    if ((legacyDocument || document && !planStorage) && error instanceof ApiError && error.code === 'SUBSCRIPTION_NOT_FOUND') return shareShell(c)
    throw error
  }
  const access = await readUserAccess(c.env.DB, { tokenHash })
  if (!accountAvailable(access) || access.enabled !== 1) {
    if (legacyDocument || document && !planStorage) return shareShell(c)
    throw subscriptionNotFound()
  }
  if (planStorage && await hasPlanAggregate(c.env.DB, access.user_id)) throw subscriptionNotFound()
  if (!await allowSubscriptionFetch(c.env.DB, 'subscription', `user:${access.user_id}`, undefined, 'unified_subscription')) throw publicRateLimited(c)

  const client = publicClient(c, access.default_client)
  let status = 500
  try {
    const artifact = await loadUnifiedArtifact(c.env, access.user_id, tokenHash, client)
    if (!artifact.available && (client === 'mihomo' || artifact.inputNodes > 0)) {
      throw apiError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点')
    }
    c.header('Content-Type', artifact.contentType)
    c.header('Content-Disposition', `attachment; filename="${artifact.fileName.replaceAll('"', '')}"`)
    c.header('ETag', artifact.etag)
    c.header('x-subscription-client', client)
    if (artifact.available && etagMatches(c, artifact.etag)) {
        status = 304
        return c.body(null, 304)
      }
    status = 200
    return c.body(artifact.body)
  } catch (err) {
    if (err instanceof ApiError) status = err.status
    throw err
  } finally {
    const key = `user:${access.user_id}`
    stageSubscriptionFetch(key, {
      at: new Date().toISOString(), platform: client, ok: status < 400, status, durationMs: Date.now()-started,
    })
    c.executionCtx.waitUntil(noteSubscriptionFetch(c.env.DATA, key))
  }
})

unifiedPublicRoutes.all('/s/*', () => { throw subscriptionNotFound() })
