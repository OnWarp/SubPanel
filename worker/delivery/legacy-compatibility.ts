import type { DataEnv } from '../db/module-switch.js'
import { getSetting } from '../db/settings-repository.js'
import { enforceUnifiedOutputLimit } from './unified-artifacts.js'
import { apiError } from '../platform/api-error.js'
import type { RenderClient } from '../renderers/index.js'
import { getEffectiveTemplate } from '../templates/repository.js'
import { resolveUserSubscription } from './aggregate.js'
import { readArtifactCatalog } from './artifacts.js'
import { catalogRelevantRevision } from './dependencies.js'
import { renderResolvedSubscription, resolveEntitlement } from './compiler.js'
import { isPublicSubscriptionCurrent } from './d1-repository.js'
import { subscriptionRowStatus } from './expiry.js'
import type { Subscription } from './schema.js'
import { requireUnifiedSubscription, subscriptionNotFound } from './user-access.js'

export const cutoverSetting = 'unified_subscription_cutover_at'
const gracePeriod = 90 * 86_400_000
let active = 0

export function readCutover(db: D1Database) {
  return getSetting(db, cutoverSetting)
}

export async function renderLegacyCompatibility(env: DataEnv, subscription: Subscription, client: RenderClient, cutover: string) {
  const startedAt = Number(cutover)
  const deadline = startedAt + gracePeriod
  if (!/^[1-9][0-9]{0,14}$/u.test(cutover) || !subscription.userId) throw subscriptionNotFound()
  const userId = subscription.userId
  const mapping = await env.DB.prepare(`SELECT template_id,original_node_ids FROM unified_subscription_mappings
    WHERE legacy_subscription_id=? AND user_id=? AND source_revision=? AND source_token_hash=? AND status='backfilled'`)
    .bind(subscription.id, userId, subscription.revision, subscription.tokenHash)
    .first<{ template_id: string; original_node_ids: string }>()
  if (!mapping) throw subscriptionNotFound()
  const { template_id: templateId, original_node_ids: originalNodes } = mapping
  const pinned = new Set<string>(JSON.parse(originalNodes))

  async function inputs() {
    const now = Date.now()
    if (now < startedAt || now >= deadline || subscriptionRowStatus(subscription, now)) throw subscriptionNotFound()
    await requireUnifiedSubscription(env.DB, true)
    const catalog = await readArtifactCatalog(env)
    const [scope, legacy, conversion] = await Promise.all([
      resolveUserSubscription(env.DB, userId, now, catalog, templateId),
      resolveEntitlement(env, subscription, new Date(now).toISOString(), { catalog }),
      client === 'mihomo' || client === 'singbox' ? getEffectiveTemplate(env.DB, subscription.id, client) : undefined,
    ])
    if (scope.status !== 'active' || scope.diagnostics.length || scope.unverifiedQuota
      || scope.speed !== legacy.speed || !scope.effectiveTemplateIds.includes(templateId)) throw subscriptionNotFound()
    const legacyIds = new Set(legacy.nodes.filter(node => node.enabled).map(node => node.id))
    const nodes = scope.nodes.filter(node => pinned.has(node.id) && legacyIds.has(node.id))
    if (!nodes.length) throw subscriptionNotFound()
    const fingerprint = await catalogRelevantRevision(nodes, scope.speed, client)
    const key = JSON.stringify([scope.access?.revision, scope.templateRevision, scope.nextTransitionAt,
      scope.effectiveTemplateIds, catalog.revision, fingerprint, conversion?.version_id])
    return { scope, nodes, conversion, key, now }
  }

  if (active >= 4) throw apiError(503, 'SUBSCRIPTION_COMPILE_BUSY', '订阅生成繁忙，请稍后重试')
  active++
  try {
    const initial = await inputs()
    const artifact = await renderResolvedSubscription(env, subscription, client,
      { ...initial.scope, nodes: initial.nodes }, new Date(initial.now).toISOString(), undefined, undefined, initial.conversion)
    enforceUnifiedOutputLimit(artifact.body)
    const current = await inputs()
    if (initial.key !== current.key || await readCutover(env.DB) !== cutover ||
      !await isPublicSubscriptionCurrent(env.DB, subscription) || Date.now() >= Math.min(
        deadline, initial.scope.nextTransitionAt ?? Infinity, subscription.expiresAt ?? Infinity,
      )) throw subscriptionNotFound()
    return artifact
  } finally {
    active--
  }
}
