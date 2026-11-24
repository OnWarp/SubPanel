import { readCatalogFromD1 } from '../catalog/d1-repository.js'
import type { CatalogSnapshot } from '../catalog/schema.js'
import { CATALOG_SETTING_KEYS, readSettingMap, type DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { env as workerEnv } from 'cloudflare:workers'
import { decryptText, encryptText, hashToken, readCryptoMaterial } from '../platform/crypto.js'
import type { RenderClient } from '../renderers/index.js'
import { getEffectiveTemplate } from '../templates/repository.js'
import { renderResolvedSubscription, RENDERER_VERSION, resolveEntitlement, type AccessSnapshot } from './compiler.js'
import { catalogRelevantRevision } from './dependencies.js'
import { compiledKey } from './repository.js'
import { compiledArtifactSchema, type CompiledArtifact, type Subscription } from './schema.js'

export async function readCurrentArtifact(
  kv: KVNamespace, subscription: Subscription, client: RenderClient, relevant: string, profile?: string | null,
) {
  const encrypted = (workerEnv.REQUIRE_WORKER_SECRETS as string | undefined) === 'true'
  const baseKey = compiledKey(subscription.tokenHash, client, {
    subscription: subscription.revision, catalogRelevant: relevant, profile,
  })
  const key = encrypted ? `${baseKey}:encrypted` : baseKey
  try {
    const raw = await kv.get(key)
    const json = raw && encrypted ? await decryptText(JSON.parse(raw), (await readCryptoMaterial(kv)).encryptionKey) : raw
    const parsed = json && compiledArtifactSchema.safeParse(JSON.parse(json))
    if (parsed && parsed.success) {
      const artifact = parsed.data
      if (artifact.client === client && artifact.rendererVersion === RENDERER_VERSION
        && artifact.subscriptionRevision === subscription.revision && artifact.catalogRelevantRevision === relevant
        && artifact.templateVersionId === (profile ?? undefined)
        && artifact.etag === `"${await hashToken(artifact.body)}"`) return { artifact, key }
    }
  } catch {
    // KV is a derived store. A read or validation failure is a cache miss.
  }
  return { key }
}

const catalogCache = new WeakMap<D1Database, CatalogSnapshot>()

async function readArtifactCatalog(env: DataEnv): Promise<CatalogSnapshot> {
  const keys = [CATALOG_SETTING_KEYS.revision, CATALOG_SETTING_KEYS.updatedAt]
  const matches = (snapshot: CatalogSnapshot, settings: Map<string, unknown>) =>
    settings.get(keys[0]) === snapshot.revision && settings.get(keys[1]) === snapshot.updatedAt
  const before = await readSettingMap(env.DB, keys)
  const cached = catalogCache.get(env.DB)
  if (cached && matches(cached, before)) return cached

  const latest = await readCatalogFromD1(env.DB)
  const after = await readSettingMap(env.DB, keys)
  if (keys.every(key => before.get(key) === after.get(key))) {
    if (matches(latest, after)) catalogCache.set(env.DB, latest)
    return latest
  }
  catalogCache.delete(env.DB)
  throw apiError(503, 'CATALOG_REFRESH_IN_PROGRESS', '目录正在更新，请稍后重试')
}

export async function inspectSubscriptionArtifact(
  env: DataEnv,
  subscription: Subscription,
  client: RenderClient,
  now: string,
  snapshot?: Partial<AccessSnapshot>,
) {
  const catalog = snapshot?.catalog ?? await readArtifactCatalog(env)
  const access = await resolveEntitlement(env, subscription, now, { ...snapshot, catalog })
  const reason = access.zeroNodeReason
  if (reason === 'disabled' || reason === 'expired' || reason === 'pending' || reason === 'ownerUnavailable' || reason === 'noPlan') {
    return { outcome: 'blocked' as const, reason }
  }
  const effective = access.nodes.length > 0 && (client === 'mihomo' || client === 'singbox')
    ? await getEffectiveTemplate(env.DB, subscription.id, client)
    : undefined
  const relevant = await catalogRelevantRevision(access.nodes, access.speed, client)
  const { key, artifact } = await readCurrentArtifact(env.DATA, subscription, client, relevant, effective?.version_id)
  return { outcome: artifact ? 'hit' as const : 'miss' as const, artifact, key, reason, access, effective, relevant }
}

export async function loadSubscriptionArtifact(
  env: DataEnv,
  subscription: Subscription,
  client: RenderClient,
  now: string,
  snapshot?: Partial<AccessSnapshot>,
  persist?: (write: Promise<void>) => void,
) {
  const currentState = await inspectSubscriptionArtifact(env, subscription, client, now, snapshot)
  if (currentState.outcome === 'blocked') return currentState
  const { artifact, key, reason, access, effective, relevant } = currentState
  if (artifact) {
    return { outcome: 'hit' as const, artifact, reason: artifact.available ? null : reason ?? 'incompatible' }
  }
  const rendered = await renderResolvedSubscription(env, subscription, client, access, now, undefined, undefined, effective)
  const current: CompiledArtifact = {
    ...rendered, catalogRelevantRevision: relevant, templateVersionId: effective?.version_id ?? undefined,
  }
  const serialized = JSON.stringify(current)
  const encrypted = (workerEnv.REQUIRE_WORKER_SECRETS as string | undefined) === 'true'
  const write = (async () => {
    const value = encrypted
      ? JSON.stringify(await encryptText(serialized, (await readCryptoMaterial(env.DATA)).encryptionKey))
      : serialized
    await env.DATA.put(key, value, { expirationTtl: encrypted ? 86400 : 7 * 86400 })
  })()
  if (persist) persist(write.catch(() => {
    console.warn(JSON.stringify({ event: 'subscription_cache_write_failed', platform: client }))
  }))
  else await write
  return { outcome: 'miss' as const, artifact: current, reason: rendered.zeroNodeReason }
}
