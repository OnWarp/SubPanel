import { findAccountUserById } from '../accounts/repository.js'
import type { CatalogSnapshot } from '../catalog/schema.js'
import type { DataEnv } from '../db/module-switch.js'
import { getEffectiveTemplate } from '../templates/repository.js'
import { aggregateBindings, connectionIdentity, uniqueConnections } from './aggregate.js'
import { readBindings } from './bindings.js'
import { renderResolvedSubscription, resolveEntitlement } from './compiler.js'
import { readDeliveryFromD1 } from './d1-repository.js'
import { effectiveStartsAt } from './expiry.js'
import { listPlans } from './plans.js'
import { clientIdSchema } from './schema.js'
import { accountAvailable, readUserAccess, subscriptionNotFound } from './user-access.js'

export async function verifyShadowUser(env: DataEnv, userId: string, now: number, catalog: CatalogSnapshot) {
  const [delivery, plans, access, bindings, owner] = await Promise.all([
    readDeliveryFromD1(env.DB), listPlans(env.DB), readUserAccess(env.DB, { userId }), readBindings(env.DB, userId),
    findAccountUserById(env, userId),
  ])
  if (!access) throw subscriptionNotFound()
  const legacy = delivery.subscriptions.filter(subscription => subscription.userId === userId)
  const aggregate = aggregateBindings(access, bindings, now, catalog)
  const operations = await env.DB.prepare(`SELECT
    (SELECT count(*) FROM binding_redemption_records WHERE user_id=?) AS bindingRedemptions,
    (SELECT count(*) FROM user_binding_requests WHERE user_id=? AND request_id LIKE 'batch-%') AS batchBindingRequests,
    (SELECT count(*) FROM user_subscription_shares WHERE user_id=?
      AND json_extract(record_json,'$.status')='active' AND json_extract(record_json,'$.expiresAt')>?) AS activeScopedShares,
    (SELECT count(*) FROM shares WHERE owner_user_id=? AND status='active' AND expires_at>?) AS activeLegacyShares`)
    .bind(userId, userId, userId, new Date(now).toISOString(), userId, new Date(now).toISOString()).first<{
      bindingRedemptions: number; batchBindingRequests: number; activeScopedShares: number; activeLegacyShares: number
    }>()
  const reasons = new Set<string>()
  if (operations?.activeLegacyShares) reasons.add('LEGACY_SHARE_SCOPE_REVIEW_REQUIRED')
  const formatDifferences: string[] = []
  const nowIso = new Date(now).toISOString()
  const planById = new Map(plans.map(plan => [plan.id, plan]))
  const legacyWindows = accountAvailable(access) ? legacy.filter(row => {
    if (!row.enabled || row.planRevoked) return false
    return !row.planId || planById.get(row.planId)?.enabled
  }) : []
  const invalidWindow = legacyWindows.some(row => (row.startsAt === null && !Number.isFinite(Date.parse(row.createdAt)))
    || (row.expiresAt !== null && row.expiresAt <= effectiveStartsAt(row)))
  if (invalidWindow) reasons.add('LEGACY_WINDOW_INVALID')

  const active = legacyWindows.filter(row => effectiveStartsAt(row) <= now && (row.expiresAt === null || now < row.expiresAt))
  const legacyOutputs = new Map<string, Awaited<ReturnType<typeof resolveEntitlement>>>()
  for (const subscription of legacyWindows) {
    const start = Math.max(now, effectiveStartsAt(subscription))
    if (subscription.expiresAt !== null && subscription.expiresAt <= start) continue
    legacyOutputs.set(subscription.id, await resolveEntitlement(env, subscription, new Date(start).toISOString(), {
      catalog, plans, users: owner ? [owner] : [],
    }))
  }
  const nodesFor = (subscriptions: typeof legacy) => uniqueConnections(subscriptions.flatMap(row => legacyOutputs.get(row.id)?.nodes ?? []))
  const keys = (nodes: typeof catalog.nodes) => JSON.stringify(nodes.map(connectionIdentity).sort())
  const permanent = active.some(row => row.expiresAt === null)
  const last = Math.max(...active.flatMap(row => row.expiresAt === null ? [] : [row.expiresAt]))
  const next = Math.min(
    ...active.flatMap(row => row.expiresAt === null ? [] : [row.expiresAt]),
    ...legacyWindows.filter(row => now < effectiveStartsAt(row)).map(effectiveStartsAt),
  )
  const state = !accountAvailable(access) ? 'disabled' : active.length ? 'active'
    : legacyWindows.some(row => now < effectiveStartsAt(row)) ? 'pending'
      : legacyWindows.some(row => row.expiresAt !== null && row.expiresAt <= now) ? 'expired'
        : legacy.some(row => !row.planRevoked) ? 'disabled' : 'none'
  if (state !== aggregate.status) reasons.add('STATUS_DIFFERS')
  if (permanent !== aggregate.permanent || (permanent || !Number.isFinite(last) ? null : last) !== aggregate.expiresAt
    || (Number.isFinite(next) ? next : null) !== aggregate.nextTransitionAt) reasons.add('WINDOW_DIFFERS')
  // Compare upcoming state as well as the snapshot's nearest boundary.
  const boundaries = new Set([
    ...legacyWindows.flatMap(row => [effectiveStartsAt(row), row.expiresAt]),
    ...bindings.filter(row => row.status === 'active' && row.template_status === 'enabled')
      .flatMap(row => [row.starts_at, row.expires_at]),
  ].filter((time): time is number => time !== null && time > now))
  if (boundaries.size > 128) reasons.add('WINDOW_REVIEW_REQUIRED')
  else for (const time of boundaries) {
    const old = legacyWindows.filter(row => effectiveStartsAt(row) <= time && (row.expiresAt === null || time < row.expiresAt))
    const nextAggregate = aggregateBindings(access, bindings, time, catalog)
    const oldPermanent = old.some(row => row.expiresAt === null)
    const oldExpiry = Math.max(...old.flatMap(row => row.expiresAt === null ? [] : [row.expiresAt]))
    if (Boolean(old.length) !== (nextAggregate.status === 'active') || oldPermanent !== nextAggregate.permanent ||
      (oldPermanent || !Number.isFinite(oldExpiry) ? null : oldExpiry) !== nextAggregate.expiresAt) reasons.add('WINDOW_DIFFERS')
    if (keys(nodesFor(old)) !== keys(nextAggregate.nodes)) reasons.add('NODES_DIFFER')
    if (nextAggregate.diagnostics.length || nextAggregate.unverifiedQuota || nextAggregate.speed > 0) reasons.add('PLAN_POLICY_UNVERIFIED')
  }

  if (legacyWindows.some(row => {
    const plan = row.planId ? planById.get(row.planId) : undefined
    return [row.trafficGb, row.speedLimitMbps, row.deviceLimit, plan?.trafficGb, plan?.speedLimitMbps, plan?.deviceLimit]
      .some(value => (value ?? 0) > 0)
  }) || aggregate.diagnostics.length || aggregate.unverifiedQuota || aggregate.speed > 0) reasons.add('PLAN_POLICY_UNVERIFIED')

  const oldOutputs = active.flatMap(subscription => {
    const resolved = legacyOutputs.get(subscription.id)
    return resolved ? [{ subscription, resolved }] : []
  })
  const oldNodes = nodesFor(active)
  if (keys(oldNodes) !== keys(aggregate.nodes)) reasons.add('NODES_DIFFER')

  for (const client of clientIdSchema.options) {
    const convert = client === 'mihomo' || client === 'singbox'
    const conversion = convert ? await getEffectiveTemplate(env.DB, null, client) : undefined
    const current = await renderResolvedSubscription(env, { id: null, revision: 1 }, client,
      aggregate, nowIso, undefined, undefined, conversion)
    const diag = (artifact: typeof current) => artifact.diagnostics.map(({ code, outcome, nodeId }) =>
      JSON.stringify([code, outcome, nodeId]))
    const oldDiagnostics = new Set<string>()
    let incompatibleProfile = false
    for (const { subscription, resolved } of oldOutputs) {
      const legacyConversion = convert ? await getEffectiveTemplate(env.DB, subscription.id, client) : undefined
      if (legacyConversion?.version_id !== conversion?.version_id) incompatibleProfile = true
      const output = await renderResolvedSubscription(env, subscription, client, resolved, nowIso, undefined, undefined, legacyConversion)
      for (const item of diag(output)) oldDiagnostics.add(item)
    }
    const union = await renderResolvedSubscription(env, { id: null, revision: 1 }, client,
      { catalog, nodes: oldNodes, speed: oldOutputs[0]?.resolved.speed ?? 0, zeroNodeReason: null },
      nowIso, undefined, undefined, conversion)
    if (incompatibleProfile || current.outputNodes !== union.outputNodes || current.skippedNodes !== union.skippedNodes ||
      JSON.stringify([...new Set(diag(current))].sort()) !== JSON.stringify([...oldDiagnostics].sort())) {
      formatDifferences.push(client)
    }
  }
  if (formatDifferences.length) reasons.add('FORMAT_DIFFERS')
  const oldExpired = Math.max(...legacyWindows.flatMap(row =>
    row.expiresAt !== null && row.expiresAt <= now ? [row.expiresAt] : []))
  const oldLastExpiredAt = state === 'expired' && Number.isFinite(oldExpired) ? oldExpired : null
  const newLastExpiredAt = aggregate.status === 'expired' ? aggregate.lastExpiredAt : null
  if (oldLastExpiredAt !== newLastExpiredAt) reasons.add('WINDOW_DIFFERS')
  const displayNodes = (nodes: typeof catalog.nodes) =>
    JSON.stringify(nodes.map(node => JSON.stringify([node.displayName, node.protocol])).sort())
  if (displayNodes(oldNodes) !== displayNodes(aggregate.nodes)) reasons.add('NODE_DISPLAY_DIFFERS')

  return {
    userId, matches: reasons.size === 0, reasons: [...reasons], formatDifferences,
    oldNodes: oldNodes.length, newNodes: aggregate.nodes.length, measuredTraffic: null, operations,
  }
}
