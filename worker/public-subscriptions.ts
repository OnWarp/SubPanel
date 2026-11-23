import type { RenderClient } from './renderers/index.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from './app-env.js'
import { apiError, ApiError } from './platform/api-error.js'
import { hashToken } from './platform/crypto.js'
import { noteSubscriptionFetch, stageSubscriptionFetch } from './delivery/fetch-stats.js'
import { subscriptionRowStatus } from './delivery/expiry.js'
import type { Subscription } from './delivery/schema.js'
import { loadSubscriptionArtifact } from './delivery/artifacts.js'
import { isPublicSubscriptionCurrent, readDeliverySubscription } from './delivery/d1-repository.js'
import { allowSubscriptionFetch } from './delivery/public-rate-limit.js'

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
  if (!tokenPattern.test(token)) {
    console.info(JSON.stringify({ event: 'subscription_delivery', status: 404, reason: 'invalid_format' }))
    throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  }
  const address = c.req.header('CF-Connecting-IP') ?? 'no-edge-address'
  if (!await allowSubscriptionFetch(c.env.DB, 'address', address)) {
    console.info(JSON.stringify({ event: 'subscription_delivery', status: 429, scope: 'address' }))
    c.header('Retry-After', '60')
    throw apiError(429, 'SUBSCRIPTION_RATE_LIMITED', '请求过于频繁')
  }
  const explicit = clientParam !== undefined
  const requestedRaw = explicit ? clientParam : clientFromUserAgent(c.req.header('User-Agent') ?? '')
  const requested = requestedRaw.toLowerCase()
  const client = clientAliases[requested] ?? requested
  if (!clients.has(client)) {
    console.info(JSON.stringify({ event: 'subscription_delivery', status: 404, reason: 'invalid_client' }))
    throw apiError(404, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')
  }
  const detect = explicit ? 'path' : requested === 'generic' ? 'fallback' : 'user-agent'

  const globalLimit = Number(c.env.PUBLIC_FETCH_GLOBAL_LIMIT ?? 0)
  if (Number.isSafeInteger(globalLimit) && globalLimit > 0 &&
    !await allowSubscriptionFetch(c.env.DB, 'global', 'all', globalLimit)) {
    console.info(JSON.stringify({ event: 'subscription_delivery', status: 429, scope: 'global' }))
    c.header('Retry-After', '60')
    throw apiError(429, 'SUBSCRIPTION_RATE_LIMITED', '请求过于频繁')
  }
  const tokenHash = await hashToken(token)
  let subscription: Subscription | undefined
  let statusCode = 500
  let ok = false
  let limitedScope: 'subscription' | undefined
  let cache: 'hit' | 'miss' | 'blocked' | undefined
  try {
    try {
      subscription = await readDeliverySubscription(c.env.DB, { tokenHash }) ?? undefined
    } catch {
      throw apiError(500, 'SUBSCRIPTION_RENDER_FAILED', '订阅生成失败')
    }

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

    if (!await allowSubscriptionFetch(c.env.DB, 'subscription', subscription.id)) {
      limitedScope = 'subscription'
      c.header('Retry-After', '60')
      throw apiError(429, 'SUBSCRIPTION_RATE_LIMITED', '请求过于频繁')
    }

    let result: Awaited<ReturnType<typeof loadSubscriptionArtifact>>
    try {
      result = await loadSubscriptionArtifact(c.env, subscription, client as RenderClient, now, undefined,
        write => c.executionCtx.waitUntil(write))
    } catch (error) {
      console.error(JSON.stringify({
        event: 'subscription_render_failed', subscriptionId: subscription.id,
        code: error instanceof ApiError ? error.code : 'SUBSCRIPTION_RENDER_FAILED',
      }))
      if (error instanceof ApiError) throw error
      throw apiError(500, 'SUBSCRIPTION_RENDER_FAILED', '订阅生成失败')
    }
    cache = result.outcome
    if (result.outcome === 'blocked') throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    const { artifact } = result
    if (!artifact.available && (client === 'mihomo' || artifact.inputNodes > 0)) {
      statusCode = 422
      throw apiError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点', { reason: result.reason })
    }

    if (!await isPublicSubscriptionCurrent(c.env.DB, subscription)) {
      throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    }
    if (subscription.expiresAt !== null && subscription.expiresAt <= Date.now()) {
      throw apiError(410, 'SUB_EXPIRED', '订阅已过期')
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
    console.info(JSON.stringify({
      event: 'subscription_delivery', platform: client, cache, status: statusCode, scope: limitedScope, durationMs: Date.now() - started,
    }))
    if (subscription && statusCode !== 429) {
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

export const publicSubscriptionRoutes = new Hono<AppEnv>()
publicSubscriptionRoutes.get('/sub/:token', (c) => serve(c))
publicSubscriptionRoutes.get('/sub/:token/:client', (c) => serve(c, c.req.param('client')))
