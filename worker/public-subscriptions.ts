import type { RenderClient } from './renderers/index.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from './app-env.js'
import { apiError, ApiError } from './platform/api-error.js'
import { hashToken } from './platform/crypto.js'
import { noteSubscriptionFetch, stageSubscriptionFetch } from './delivery/fetch-stats.js'
import { subscriptionRowStatus } from './delivery/expiry.js'
import { compiledArtifactSchema, type Subscription } from './delivery/schema.js'
import { renderEntitledSubscription } from './delivery/compiler.js'
import { compiledKey, compiledPrefix, readDelivery } from './delivery/repository.js'

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u
const clients = new Set(['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'])
const clientAliases: Record<string, string> = {
  clash: 'mihomo',
  'clash-meta': 'mihomo',
  stash: 'mihomo',
  karing: 'singbox',
  'sing-box': 'singbox',
  'quantumult-x': 'quantumultx',
  v2rayng: 'v2rayn',
  'neko-box': 'nekobox',
}

function clientFromUserAgent(userAgent: string): string {
  const value = userAgent.toLowerCase()
  if (value.includes('mihomo') || value.includes('clash') || value.includes('stash')) return 'mihomo'
  if (value.includes('sing-box') || value.includes('singbox') || value.includes('karing')) return 'singbox'
  if (value.includes('surge')) return 'surge'
  if (value.includes('loon')) return 'loon'
  if (value.includes('quantumult')) return 'quantumultx'
  if (value.includes('v2rayn') || value.includes('v2rayng')) return 'v2rayn'
  if (value.includes('nekobox')) return 'nekobox'
  if (value.includes('shadowrocket')) return 'shadowrocket'
  return 'generic'
}

const BLOCKED_PUBLIC = new Set(['revoked', 'disabled', 'owner_unavailable'])

async function serve(c: Context<AppEnv>, clientParam?: string) {
  const started = Date.now()
  const token = c.req.param('token') ?? ''
  if (!tokenPattern.test(token)) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  const explicit = clientParam !== undefined
  const requestedRaw = explicit ? clientParam : clientFromUserAgent(c.req.header('User-Agent') ?? '')
  const requested = requestedRaw.toLowerCase()
  const client = clientAliases[requested] ?? requested
  if (!clients.has(client)) throw apiError(404, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')
  const detect = explicit ? 'path' : requested === 'generic' ? 'fallback' : 'user-agent'

  const tokenHash = await hashToken(token)
  let subscription: Subscription | undefined
  let statusCode = 500
  let ok = false
  try {
    let delivery: Awaited<ReturnType<typeof readDelivery>>
    try {
      delivery = await readDelivery(c.env)
    } catch {
      console.error(JSON.stringify({ event: 'subscription_storage_failed' }))
      statusCode = 500
      throw apiError(500, 'SUBSCRIPTION_RENDER_FAILED', '订阅生成失败')
    }

    subscription = delivery.subscriptions.find((candidate) => candidate.encryptedToken && candidate.tokenHash === tokenHash)
    if (!subscription) {
      statusCode = 404
      throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    }

    const now = new Date().toISOString()
    const status = subscriptionRowStatus(subscription, Date.parse(now))
    if (status === 'expired') {
      statusCode = 410
      throw apiError(410, 'SUB_EXPIRED', '订阅已过期')
    }
    if (status === 'pending') {
      statusCode = 403
      throw apiError(403, 'SUB_NOT_STARTED', '订阅尚未生效')
    }
    if (status && BLOCKED_PUBLIC.has(status)) {
      statusCode = 404
      throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    }

    let artifact: Awaited<ReturnType<typeof renderEntitledSubscription>>
    try {
      artifact = await renderEntitledSubscription(c.env, subscription, client as RenderClient, now)
    } catch (error) {
      console.error(JSON.stringify({
        event: 'subscription_render_failed', subscriptionId: subscription.id,
        code: error instanceof ApiError ? error.code : 'SUBSCRIPTION_RENDER_FAILED',
      }))
      if (error instanceof ApiError) throw error
      statusCode = 500
      throw apiError(500, 'SUBSCRIPTION_RENDER_FAILED', '订阅生成失败')
    }

    if (artifact.zeroNodeReason === 'ownerUnavailable') {
      statusCode = 404
      throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    }
    if (!artifact.available && (client === 'mihomo' || artifact.inputNodes > 0)) {
      statusCode = 422
      throw apiError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点', { reason: artifact.zeroNodeReason })
    }

    // Compare the live result against KV only to decide whether the derived
    // artifact needs refreshing. Authorization and response bytes come from D1
    // and the current catalog, even if an older request races with this write.
    if (artifact.available) {
      const key = compiledKey(tokenHash, client, artifact.templateVersionId, artifact.rendererVersion)
      c.executionCtx.waitUntil(refreshArtifact(c.env.DATA, key, artifact))
      const legacyKey = `${compiledPrefix(tokenHash)}${client}`
      if (key !== legacyKey) {
        c.executionCtx.waitUntil(refreshArtifact(c.env.DATA, legacyKey, artifact))
      }
    }

    c.header('Cache-Control', 'no-store')
    c.header('ETag', artifact.etag)
    c.header('Content-Type', artifact.contentType)
    const extension = artifact.fileName.includes('.') ? artifact.fileName.slice(artifact.fileName.lastIndexOf('.')) : ''
    c.header('Content-Disposition', `attachment; filename="${artifact.fileName.replaceAll('"', '')}"; filename*=UTF-8''${encodeURIComponent(`${subscription.name}${extension}`)}`)
    c.header('profile-title', encodeURIComponent(subscription.name))
    c.header('x-subscription-client', client)
    c.header('x-subscription-detect', detect)
    if (detect === 'fallback') c.header('x-subscription-notice', 'generic-import-differs')

    const ifNoneMatch = c.req.header('If-None-Match')
    if (artifact.available && ifNoneMatch?.split(',').some(value => value.trim().replace(/^W\//u, '') === artifact.etag)) {
      statusCode = 304
      ok = true
      return c.body(null, 304)
    }
    statusCode = 200
    ok = true
    return c.body(artifact.body)
  } catch (error) {
    if (error instanceof ApiError) statusCode = error.status
    throw error
  } finally {
    if (subscription) {
      const sample = {
        at: new Date().toISOString(),
        platform: client,
        ok,
        status: statusCode,
        durationMs: Math.max(0, Date.now() - started),
      }
      stageSubscriptionFetch(subscription.id, sample)
      c.executionCtx.waitUntil(noteSubscriptionFetch(c.env.DATA, subscription.id, sample))
    }
  }
}

async function refreshArtifact(kv: KVNamespace, key: string, artifact: Awaited<ReturnType<typeof renderEntitledSubscription>>) {
  try {
    const raw = await kv.get(key)
    if (raw) {
      let cached: ReturnType<typeof compiledArtifactSchema.safeParse> | undefined
      try {
        cached = compiledArtifactSchema.safeParse(JSON.parse(raw))
      } catch {
        // Older or malformed entries are replaced.
      }
      if (cached?.success && cached.data.client === artifact.client
        && cached.data.rendererVersion === artifact.rendererVersion
        && cached.data.subscriptionRevision === artifact.subscriptionRevision
        && cached.data.catalogRevision === artifact.catalogRevision
        && cached.data.templateVersionId === artifact.templateVersionId
        && cached.data.body === artifact.body && cached.data.etag === artifact.etag) return
    }
    await kv.put(key, JSON.stringify(artifact))
  } catch {
    console.warn(JSON.stringify({ event: 'subscription_cache_refresh_failed', client: artifact.client }))
  }
}

export const publicSubscriptionRoutes = new Hono<AppEnv>()
publicSubscriptionRoutes.get('/sub/:token', (c) => serve(c))
publicSubscriptionRoutes.get('/sub/:token/:client', (c) => serve(c, c.req.param('client')))
