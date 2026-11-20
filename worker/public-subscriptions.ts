import { disableExpiredSubscriptions } from './delivery/service.js'
import type { RenderClient } from './renderers/index.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from './app-env.js'
import { apiError, ApiError } from './platform/api-error.js'
import { hashToken } from './platform/crypto.js'
import { assertSubscriptionAvailable } from './delivery/expiry.js'
import { compiledArtifactSchema } from './delivery/schema.js'
import { renderEntitledSubscription } from './delivery/compiler.js'
import { compiledKey, readDelivery } from './delivery/repository.js'

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

async function serve(c: Context<AppEnv>, clientParam?: string) {
  const token = c.req.param('token') ?? ''
  if (!tokenPattern.test(token)) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  const requestedClient = clientParam ?? clientFromUserAgent(c.req.header('User-Agent') ?? '')
  const client = clientAliases[requestedClient.toLowerCase()] ?? requestedClient.toLowerCase()
  if (!clients.has(client)) throw apiError(404, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')

  const tokenHash = await hashToken(token)
  let delivery: Awaited<ReturnType<typeof readDelivery>>
  try {
    delivery = await readDelivery(c.env)
  } catch {
    console.error(JSON.stringify({ event: 'subscription_storage_failed' }))
    throw apiError(500, 'SUBSCRIPTION_RENDER_FAILED', '订阅生成失败')
  }

  const subscription = delivery.subscriptions.find((candidate) => candidate.encryptedToken && candidate.tokenHash === tokenHash)
  if (subscription && subscription.expiresAt !== null && subscription.expiresAt <= Date.now()) {
    await disableExpiredSubscriptions(c.env)
    throw apiError(410, 'SUB_EXPIRED', '订阅已过期')
  }
  if (!subscription?.userId || !subscription.enabled) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')

  assertSubscriptionAvailable(subscription)

  let artifact: Awaited<ReturnType<typeof renderEntitledSubscription>>
  try {
    artifact = await renderEntitledSubscription(c.env, subscription, client as RenderClient)
  } catch (error) {
    console.error(JSON.stringify({
      event: 'subscription_render_failed', subscriptionId: subscription.id,
      code: error instanceof ApiError ? error.code : 'SUBSCRIPTION_RENDER_FAILED',
    }))
    if (error instanceof ApiError) throw error
    throw apiError(500, 'SUBSCRIPTION_RENDER_FAILED', '订阅生成失败')
  }

  if (artifact.zeroNodeReason === 'ownerUnavailable') throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  if (!artifact.available && (client === 'mihomo' || artifact.inputNodes > 0)) {
    throw apiError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点', { reason: artifact.zeroNodeReason })
  }

  // Compare the live result against KV only to decide whether the derived
  // artifact needs refreshing. Authorization and response bytes come from D1
  // and the current catalog, even if an older request races with this write.
  if (artifact.available) {
    const key = compiledKey(tokenHash, client)
    c.executionCtx.waitUntil(refreshArtifact(c.env.DATA, key, artifact))
  }

  c.header('Cache-Control', 'no-store')
  c.header('ETag', artifact.etag)
  c.header('Content-Type', artifact.contentType)
  const extension = artifact.fileName.includes('.') ? artifact.fileName.slice(artifact.fileName.lastIndexOf('.')) : ''
  c.header('Content-Disposition', `attachment; filename="${artifact.fileName.replaceAll('"', '')}"; filename*=UTF-8''${encodeURIComponent(`${subscription.name}${extension}`)}`)
  c.header('profile-title', encodeURIComponent(subscription.name))

  const ifNoneMatch = c.req.header('If-None-Match')
  if (artifact.available && ifNoneMatch?.split(',').some(value => value.trim().replace(/^W\//u, '') === artifact.etag)) {
    return c.body(null, 304)
  }
  return c.body(artifact.body)
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
