import { disableExpiredSubscriptions } from './delivery/service.js'
import { getUserEntitlement } from './entitlements/service.js'
import type { RenderClient } from './renderers/index.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from './app-env.js'
import { readAccounts } from './accounts/repository.js'
import { readCatalog } from './catalog/repository.js'
import { apiError } from './platform/api-error.js'
import { hashToken } from './platform/crypto.js'
import { assertSubscriptionAvailable } from './delivery/expiry.js'
import { compiledArtifactSchema } from './delivery/schema.js'
import { compileSubscription, renderEntitledSubscription } from './delivery/compiler.js'
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
  let catalog: Awaited<ReturnType<typeof readCatalog>>
  try {
    [delivery, catalog] = await Promise.all([
      readDelivery(c.env),
      readCatalog(c.env),
    ])
  } catch {
    throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  }

  const subscription = delivery.subscriptions.find((candidate) => candidate.tokenHash === tokenHash)
  if (subscription && subscription.expiresAt !== null && subscription.expiresAt <= Date.now()) {
    await disableExpiredSubscriptions(c.env)
    throw apiError(410, 'SUB_EXPIRED', '订阅已过期')
  }
  if (!subscription?.userId || !subscription.enabled) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')

  // A soft-deleted owner loses public delivery immediately
  let ownerDeleted = false
  try {
    const accounts = await readAccounts(c.env)
    const owner = accounts.users.find((candidate) => candidate.id === subscription.userId)
    ownerDeleted = !owner || owner.deletedAt !== null
  } catch {
    ownerDeleted = true
  }
  if (ownerDeleted) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')

  assertSubscriptionAvailable(subscription)

  // ALWAYS check entitlement in real-time - never from cache
  const rights = await getUserEntitlement(c.env.DB, subscription.userId)
  if (!rights.current) {
    const empty = await renderEntitledSubscription(c.env, subscription, client as RenderClient)
    c.header('Content-Type', empty.contentType)
    c.header('Cache-Control', 'no-store')
    c.header('profile-title', encodeURIComponent(subscription.name))
    return c.body(empty.body)
  }

  // Try to get cached artifact
  let raw: string | null = null
  try {
    raw = await c.env.DATA.get(compiledKey(tokenHash, client))
  } catch {
    // KV error - treat as cache miss
  }

  let artifact: CompiledArtifact | null = null
  let cacheValid = false

  if (raw) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      // Invalid JSON - treat as cache miss
    }

    if (value) {
      const parsed = compiledArtifactSchema.safeParse(value)
      if (parsed.success) {
        artifact = parsed.data
        // Check if cache is valid: subscription revision, catalog revision, and template version must match
        cacheValid =
          artifact.subscriptionRevision === subscription.revision &&
          artifact.catalogRevision === catalog.revision &&
          // For Mihomo, also check template version
          (client !== 'mihomo' || !artifact.templateVersionId || await checkTemplateVersionMatches(c.env, subscription, artifact.templateVersionId))
      } else if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'schemaVersion' in value &&
        value.schemaVersion === 1
      ) {
        // Legacy schema v1 - rebuild
        cacheValid = false
      }
    }
  }

  // If cache miss or invalid, rebuild in real-time
  if (!cacheValid || !artifact) {
    try {
      artifact = await renderEntitledSubscription(c.env, subscription, client as RenderClient)
      // Backfill cache in background
      c.executionCtx?.waitUntil(
        c.env.DATA.put(compiledKey(tokenHash, client), JSON.stringify(artifact))
          .catch(() => { /* ignore cache write failures */ })
      )
    } catch (e) {
      console.error('Subscription render failed:', e)
      throw apiError(500, 'SUBSCRIPTION_RENDER_FAILED', '订阅生成失败')
    }
  }

  if (!artifact.available && artifact.inputNodes > 0) {
    throw apiError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点')
  }

  c.header('Cache-Control', 'no-store')
  c.header('ETag', artifact.etag)
  c.header('Last-Modified', new Date(artifact.lastModified).toUTCString())
  c.header('Content-Type', artifact.contentType)
  const extension = artifact.fileName.includes('.') ? artifact.fileName.slice(artifact.fileName.lastIndexOf('.')) : ''
  c.header('Content-Disposition', `attachment; filename="${artifact.fileName.replaceAll('"', '')}"; filename*=UTF-8''${encodeURIComponent(`${subscription.name}${extension}`)}`)
  c.header('profile-title', encodeURIComponent(subscription.name))

  const ifNoneMatch = c.req.header('If-None-Match')
  if (ifNoneMatch?.split(',').map((value: string) => value.trim()).includes(artifact.etag)) {
    return c.body(null, 304)
  }
  return c.body(artifact.body)
}

async function checkTemplateVersionMatches(env: DataEnv, subscription: Subscription, templateVersionId: string): Promise<boolean> {
  try {
    const { getEffectiveTemplate } = await import('../templates/repository.js')
    const effective = await getEffectiveTemplate(env.DB, subscription.id)
    return effective?.version.id === templateVersionId
  } catch {
    return false
  }
}

export const publicSubscriptionRoutes = new Hono<AppEnv>()
publicSubscriptionRoutes.get('/sub/:token', (c) => serve(c))
publicSubscriptionRoutes.get('/sub/:token/:client', (c) => serve(c, c.req.param('client')))