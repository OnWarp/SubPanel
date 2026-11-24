import type { DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import type { RenderClient } from '../renderers/index.js'
import { getEffectiveTemplate } from '../templates/repository.js'
import { resolveUserSubscription } from './aggregate.js'
import { readArtifactCatalog } from './artifacts.js'
import { renderResolvedSubscription, RENDERER_VERSION } from './compiler.js'
import { catalogRelevantRevision } from './dependencies.js'
import { accountAvailable, readUserAccess, requireUnifiedSubscription, subscriptionNotFound } from './user-access.js'

const ttl = 60_000
const maxOutputBytes = 2 * 1024 * 1024

async function loadInputs(env: DataEnv, userId: string, tokenHash: string, client: RenderClient, now: number) {
  const catalog = await readArtifactCatalog(env)
  const aggregate = await resolveUserSubscription(env.DB, userId, now, catalog)
  const { access } = aggregate
  if (!accountAvailable(access) || access.enabled !== 1 || access.token_hash !== tokenHash) throw subscriptionNotFound()
  if (aggregate.diagnostics.length) throw apiError(409, 'PLAN_POLICY_UNVERIFIED', '授权限制需要管理员处理')
  if (aggregate.status === 'expired') throw apiError(410, 'SUB_EXPIRED', '订阅已过期')
  if (aggregate.status === 'pending') throw apiError(403, 'SUB_NOT_STARTED', '订阅尚未生效')
  if (aggregate.status !== 'active') throw subscriptionNotFound()

  const conversion = client === 'mihomo' || client === 'singbox'
    ? await getEffectiveTemplate(env.DB, null, client) : undefined
  const conversionVersion = conversion?.version_id ?? null
  const catalogRevision = await catalogRelevantRevision(aggregate.nodes, aggregate.speed, client)
  const key = JSON.stringify([userId, access.revision, tokenHash, aggregate.templateRevision,
    catalog.revision, catalogRevision, conversionVersion, client, RENDERER_VERSION, aggregate.effectiveTemplateIds])
  return { aggregate, conversion, conversionVersion, catalogRevision, key }
}

async function compile(env: DataEnv, inputs: Awaited<ReturnType<typeof loadInputs>>, client: RenderClient, now: number) {
  const { aggregate, conversion, conversionVersion, catalogRevision } = inputs
  const revision = aggregate.access!.revision!
  const result = await renderResolvedSubscription(env, { id: null, revision }, client,
    aggregate, new Date(now).toISOString(), undefined, undefined, conversion)
  if (new TextEncoder().encode(result.body).length > maxOutputBytes) {
    throw apiError(422, 'UNIFIED_RESOURCE_LIMIT', '订阅输出过大')
  }
  const { subscriptionRevision: userRevision, ...rendered } = result
  return {
    ...rendered, schemaVersion: 3 as const, userRevision, conversionVersion,
    templateDependencyRevision: aggregate.templateRevision, catalogRelevantRevision: catalogRevision,
    validUntil: Math.min(now + ttl, aggregate.nextTransitionAt ?? Infinity),
  }
}

export type UnifiedCompiledArtifact = Awaited<ReturnType<typeof compile>>

// Bounded per-isolate storage avoids persisting credential-bearing payloads.
const artifacts = new WeakMap<D1Database, Map<string, UnifiedCompiledArtifact>>()
let activeCompiles = 0

export async function loadUnifiedArtifact(env: DataEnv, userId: string, tokenHash: string, client: RenderClient) {
  const now = Date.now()
  const inputs = await loadInputs(env, userId, tokenHash, client, now)
  const key = await hashToken(inputs.key)
  const cache = artifacts.get(env.DB) ?? new Map<string, UnifiedCompiledArtifact>()
  artifacts.set(env.DB, cache)
  const cached = cache.get(key)
  let artifact = cached
  if (!artifact || now >= artifact.validUntil) {
    if (activeCompiles >= 4) throw apiError(503, 'SUBSCRIPTION_COMPILE_BUSY', '订阅生成繁忙，请稍后重试')
    activeCompiles++
    try {
      artifact = await compile(env, inputs, client, now)
    } finally {
      activeCompiles--
    }
  }

  await requireUnifiedSubscription(env.DB, true)
  const current = await loadInputs(env, userId, tokenHash, client, Date.now())
  // Check the credential after resolving all other dependencies.
  const access = await readUserAccess(env.DB, { tokenHash })
  if (!accountAvailable(access) || access.enabled !== 1 || access.user_id !== userId) throw subscriptionNotFound()
  if (inputs.key !== current.key || access.revision !== artifact.userRevision || Date.now() >= artifact.validUntil) {
    throw apiError(503, 'SUBSCRIPTION_REFRESH_IN_PROGRESS', '订阅正在更新，请稍后重试')
  }
  if (cache.size >= 16) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, artifact)
  return artifact
}
