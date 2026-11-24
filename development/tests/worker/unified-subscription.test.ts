import { executeBackfill, previewBackfill, reconcileBackfill } from '../../../worker/delivery/backfill'
import { cutoverSetting } from '../../../worker/delivery/legacy-compatibility'
import { createShare, readShareMeta } from '../../../worker/shares/service'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { markModuleReady, ACCOUNTS_D1_READY_KEY } from '../../../worker/db/module-switch'
import { readCatalog, writeCatalog } from '../../../worker/catalog/repository'
import { createEntitlementTemplate, updateEntitlementTemplate } from '../../../worker/delivery/entitlement-templates'
import { mutateBinding, mutateBindingsByUser, readBindings } from '../../../worker/delivery/bindings'
import { aggregateBindings, resolveUserSubscription, uniqueConnections } from '../../../worker/delivery/aggregate'
import { createSubscription, resetSubscriptionToken } from '../../../worker/delivery/service'
import { savePlan } from '../../../worker/delivery/plans'
import { readUserAccess, userSubscriptionPublicReady, userSubscriptionReady } from '../../../worker/delivery/user-access'
import { enforceUnifiedOutputLimit, loadUnifiedArtifact } from '../../../worker/delivery/unified-artifacts'
import { verifyShadowUser } from '../../../worker/delivery/shadow'
import { applyBackfillMigration, applyMigrations, applyUnifiedMigration } from './d1'
import { createFixtureAccount, enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const userId = 'usr_1'
const instant = Date.parse('2027-01-31T13:00:00.000Z')
const invoke = (path: string, init?: RequestInit) => exports.default.fetch(new URL(path, TEST_ORIGIN), init)
let cookie: string
let templateId: string
let nodeId: string
let otherNodeId: string
let groupId: string

const config = (nodeIds: string[], quotaBytes: number | null = null) => ({
  groupIds: [], nodeIds, duration: { unit: 'month' as const, value: 1 }, quotaBytes,
  resetPolicy: 'none' as const, limits: { speedLimitMbps: 0 },
})
const makeTemplate = (nodes: string[], quota?: number, owner?: string) => createEntitlementTemplate(env.DB, {
  name: 'Unified test fixture', description: '', allowRedemption: false, config: config(nodes, quota),
}, userId, 'enabled', owner)
const assign = (expectedRevision: number, startsAt: number, expiresAt: number | null) => ({
  mode: 'assign' as const, requestId: crypto.randomUUID(), expectedRevision, startsAt,
  expiry: expiresAt === null ? { type: 'permanent' as const } : { type: 'absolute' as const, expiresAt },
})
const resolve = async (now: number, id = userId) => resolveUserSubscription(env.DB, id, now, await readCatalog(env))

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await applyUnifiedMigration()
  await applyBackfillMigration()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM unified_subscription_mappings'),
    env.DB.prepare('DELETE FROM unified_subscription_checkpoints'),
    env.DB.prepare('DELETE FROM system_settings WHERE key=?').bind(cutoverSetting),
  ])
  await env.DB.batch(['user_binding_requests', 'user_template_bindings', 'user_subscription_access'].map(table =>
    env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare("UPDATE entitlement_templates SET status='archived' WHERE status<>'archived'").run()
  await enableD1Modules()
  await env.DB.prepare('DELETE FROM system_settings WHERE key=?').bind(userSubscriptionPublicReady).run()
  await markModuleReady(env.DB, ACCOUNTS_D1_READY_KEY)
  await markModuleReady(env.DB, userSubscriptionReady)
  await setupAdmin()
  cookie = await login()
  const create = async (path: string, body: unknown) => {
    const response = await invoke(path, withCookie(cookie, jsonRequest(body)))
    expect(response.status).toBe(201)
    return response.json() as Promise<Record<string, { id: string }>>
  }
  const userInfo = btoa(`aes-128-gcm:${crypto.randomUUID()}`)
  const { source } = await create('/api/admin/catalog/sources', {
    name: 'Unified test source', type: 'manual',
    content: `ss://${userInfo}@one.example:8388#One\nss://${userInfo}@two.example:8388#Two`,
  })
  const { group } = await create('/api/admin/catalog/groups', { name: 'Unified group', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [] })
  groupId = group.id
  ;[nodeId, otherNodeId] = (await readCatalog(env)).nodes.map(({ id }) => id)
  templateId = (await makeTemplate([nodeId])).id
})

it('replays the same request, upserts a single binding, and leaves its token stable', async () => {
  const first = { mode: 'assign', requestId: crypto.randomUUID(), expectedRevision: 0, expiry: { type: 'default' }, startsAt: instant } as const
  const [result, duplicate] = await Promise.all([
    mutateBinding(env, userId, templateId, first, userId, instant),
    mutateBinding(env, userId, templateId, first, userId, instant),
  ])
  expect(result).toEqual(duplicate)
  expect(result.changes[0].after.expires_at).toBe(Date.parse('2027-02-28T13:00:00.000Z'))
  const tokenBefore = (await readUserAccess(env.DB, { userId }))!.token_hash
  const reassigned = await mutateBinding(env, userId, templateId, assign(result.revision, instant + 1, null), userId, instant + 1)
  const renewed = await mutateBinding(env, userId, templateId, {
    mode: 'renew', expectedRevision: reassigned.revision, requestId: crypto.randomUUID(), expiry: { type: 'default' },
  }, userId, instant)
  expect(renewed.changes[0].after.expires_at).toBeNull()
  await applyUnifiedMigration()
  expect(await readBindings(env.DB, userId)).toHaveLength(1)
  expect((await readUserAccess(env.DB, { userId }))!.token_hash).toBe(tokenBefore)
  expect(await env.DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] })
})

it('enforces private scope in SQL and resolves concurrent replacement without partial writes', async () => {
  await createFixtureAccount('other', crypto.randomUUID())
  const privateTemplate = await makeTemplate([otherNodeId], undefined, userId)
  const base = await mutateBinding(env, userId, templateId, assign(0, instant, null), userId, instant)
  await expect(env.DB.prepare(`INSERT INTO user_template_bindings
    (user_id,template_id,starts_at,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)`)
    .bind('usr_2', privateTemplate.id, instant, new Date(instant).toISOString(), new Date(instant).toISOString()).run())
    .rejects.toThrow('ENTITLEMENT_OWNER_MISMATCH')
  const next = await makeTemplate([otherNodeId])
  const [a, b] = await Promise.allSettled([
    mutateBinding(env, userId, next.id, {
      ...assign(base.revision, instant, null), mode: 'replaceAll', confirm: true, newTemplateId: next.id,
    }, userId, instant),
    mutateBinding(env, userId, templateId, {
      mode: 'pause', requestId: crypto.randomUUID(), expectedRevision: base.revision,
    }, userId, instant),
  ])
  expect([a, b].filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rows = (await readBindings(env.DB, userId)).map(row => [row.template_id, row.status])
  expect(rows).toEqual(a.status === 'fulfilled'
    ? [[templateId, 'revoked'], [next.id, 'active']].sort()
    : [[templateId, 'paused']])
})

it('resolves the union across future, permanent, disabled and exact expiry boundaries', async () => {
  const other = await makeTemplate([nodeId, otherNodeId])
  const first = await mutateBinding(env, userId, templateId, assign(0, instant, null), userId, instant)
  await mutateBinding(env, userId, other.id, assign(first.revision, instant + 10, instant + 20), userId, instant)
  expect((await resolve(instant - 1)).status).toBe('pending')
  expect(await resolve(instant)).toMatchObject({ permanent: true, nextTransitionAt: instant + 10, nodes: [{ id: nodeId }] })
  expect((await resolve(instant + 10)).nodes.map(node => node.id).sort()).toEqual([nodeId, otherNodeId].sort())
  const disabled = await updateEntitlementTemplate(env.DB, other.id, { status: 'disabled', expectedRevision: other.revision }, userId)
  expect((await resolve(instant + 10)).nodes.map(node => node.id)).toEqual([nodeId])
  await updateEntitlementTemplate(env.DB, other.id, { status: 'enabled', expectedRevision: disabled.revision }, userId)
  expect((await resolve(instant + 19)).nodes).toHaveLength(2)
  expect((await resolve(instant + 20)).nodes.map(node => node.id)).toEqual([nodeId])
  const [node] = (await readCatalog(env)).nodes
  expect(uniqueConnections([node, { ...node, id: 'node_777', displayName: 'Alias' },
    { ...node, id: 'node_778', credentials: { ...node.credentials, password: crypto.randomUUID() } },
    { ...node, id: 'node_779', tls: { enabled: true } },
    { ...node, id: 'node_780', transport: { type: 'ws' } }])).toHaveLength(4)
})

it('validates conditional GET against account and token changes, and invalidates published templates and catalog content', async () => {
  const now = Date.now()
  const binding = await mutateBinding(env, userId, templateId, assign(0, now - 100, null), userId, now)
  expect((await invoke('/api/user/subscription', withCookie(cookie))).status).toBe(404)
  await markModuleReady(env.DB, userSubscriptionPublicReady)
  const summary = await invoke('/api/user/subscription', withCookie(cookie))
  expect(summary.status).toBe(200)
  const url = new URL((await summary.json() as { subscriptionUrl: string }).subscriptionUrl)
  const response = await invoke(url.pathname)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const tag = response.headers.get('etag')!
  const conditional = { headers: { 'If-None-Match': tag } }
  expect((await invoke(url.pathname, conditional)).status).toBe(304)
  await updateEntitlementTemplate(env.DB, templateId, { config: config([otherNodeId]), expectedRevision: 1 }, userId)
  const changed = await invoke(url.pathname, conditional)
  expect(changed.status).toBe(200)
  expect(changed.headers.get('etag')).not.toBe(tag)
  expect((await readBindings(env.DB, userId))[0].starts_at).toBe(now - 100)
  const catalog = await readCatalog(env)
  await writeCatalog(env, { ...catalog, nodes: catalog.nodes.map(node => ({ ...node, displayName: 'Changed node' })) })
  const access = (await readUserAccess(env.DB, { userId }))!
  const artifact = await loadUnifiedArtifact(env, userId, access.token_hash!, 'generic')
  expect(artifact.schemaVersion).toBe(3)
  expect(artifact.userRevision).toBe(binding.revision)
  expect(artifact.etag).not.toBe(changed.headers.get('etag'))
  expect((await invoke('/api/user/subscription/reset-token', withCookie(cookie, jsonRequest({})))).status).toBe(200)
  expect((await invoke(url.pathname, conditional)).status).toBe(404)
  const current = new URL((await (await invoke('/api/user/subscription', withCookie(cookie))).json() as { subscriptionUrl: string }).subscriptionUrl)
  expect((await invoke(current.pathname)).status).toBe(200)
  await env.DB.prepare('UPDATE users SET enabled=0 WHERE id=?').bind(userId).run()
  expect((await invoke(current.pathname, conditional)).status).toBe(404)
})

it('reports an equivalent fixture and rejects a legacy limit conflict without fabricating traffic', async () => {
  const startsAt = instant - 1000
  await createSubscription(env, { userId, name: 'Shadow baseline', groupIds: [groupId], startsAt, expiresAt: null })
  const unlimited = await createEntitlementTemplate(env.DB, {
    name: 'Shadow baseline', description: '', allowRedemption: false,
    config: { ...config([]), groupIds: [groupId] },
  }, userId)
  const base = await mutateBinding(env, userId, unlimited.id, assign(0, startsAt, null), userId, instant)
  const catalog = await readCatalog(env)
  expect(await verifyShadowUser(env, userId, instant, catalog)).toMatchObject({
    matches: true, reasons: [], oldNodes: 2, newNodes: 2, measuredTraffic: null,
  })
  await createFixtureAccount('other', crypto.randomUUID())
  const plan = await savePlan(env.DB, { name: 'Limited fixture', groupIds: [groupId], durationDays: 30, trafficGb: 1, speedLimitMbps: 10, deviceLimit: 2 })
  await createSubscription(env, { userId: 'usr_2', name: 'Limited baseline', planId: plan.id, groupIds: [groupId], startsAt, expiresAt: null })
  const limited = await makeTemplate([nodeId], 1)
  await mutateBinding(env, 'usr_2', limited.id, assign(0, startsAt, null), userId, instant)
  await mutateBinding(env, userId, limited.id, assign(base.revision, startsAt, null), userId, instant)
  expect(await verifyShadowUser(env, 'usr_2', instant, catalog)).toMatchObject({
    matches: false, reasons: expect.arrayContaining(['PLAN_POLICY_UNVERIFIED', 'NODES_DIFFER']), newNodes: 0, measuredTraffic: null,
  })
  expect(await resolve(instant)).toMatchObject({ diagnostics: [], unverifiedQuota: true, nodes: [{ id: nodeId }, { id: otherNodeId }] })
})

it('uses a single current system conversion and keeps user artifacts isolated', async () => {
  const now = Date.now()
  const other = await makeTemplate([otherNodeId])
  await createFixtureAccount('other', crypto.randomUUID())
  await mutateBinding(env, userId, templateId, assign(0, now - 100, null), userId, now)
  await mutateBinding(env, 'usr_2', other.id, assign(0, now - 100, null), userId, now)
  await markModuleReady(env.DB, userSubscriptionPublicReady)
  const [one, two] = await Promise.all([userId, 'usr_2'].map(async id => (await readUserAccess(env.DB, { userId: id }))!))
  const a = await loadUnifiedArtifact(env, userId, one.token_hash!, 'mihomo')
  const b = await loadUnifiedArtifact(env, 'usr_2', two.token_hash!, 'mihomo')
  expect(a.body).toContain('one.example')
  expect(a.body).not.toContain('two.example')
  expect(b.body).toContain('two.example')
  expect(b.body).not.toContain('one.example')
  await expect(loadUnifiedArtifact(env, 'usr_2', one.token_hash!, 'mihomo')).rejects.toMatchObject({ status: 404 })

  const root = '/api/admin/system/subscription-templates'
  const admin = (path: string, body: unknown, method = 'POST') => invoke(path, withCookie(cookie, jsonRequest(body, { method })))
  const created = await admin(root, { name: 'Unified conversion fixture', yaml: `proxy-groups:
  - name: UnifiedPolicy
    type: select
    proxies: ["$SUBPANEL_NODES"]
rules:
  - MATCH,UnifiedPolicy
` })
  expect(created.status).toBe(201)
  const { id, revision, draftHash } = await created.json() as { id: string; revision: number; draftHash: string }
  const published = await admin(`${root}/${id}/publish`, { expectedRevision: revision, draftHash })
  expect(published.status).toBe(200)
  const { versionId } = await published.json() as { versionId: string }
  expect((await admin(`${root}/default`, { templateId: id, expectedRevision: 1 }, 'PUT')).status).toBe(200)
  const updated = await loadUnifiedArtifact(env, userId, one.token_hash!, 'mihomo')
  expect(updated.conversionVersion).toBe(versionId)
  expect(updated.etag).not.toBe(a.etag)
  expect(updated.body).toContain('UnifiedPolicy')
})

it('uses per-user batch transactions and limits artifact lifetime to the next authorization transition', async () => {
  const now = Date.now()
  const other = await makeTemplate([otherNodeId])
  await createFixtureAccount('other', crypto.randomUUID())
  const input = assign(0, now - 100, now + 50_000)
  const batch = [
    { userId, templateId, input },
    { userId: 'usr_2', templateId: other.id, input: { ...input, expectedRevision: 3 } },
  ]
  const results = await mutateBindingsByUser(env, batch, userId)
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(await mutateBindingsByUser(env, [batch[0]], userId)).toEqual([results[0]])
  expect(await readBindings(env.DB, 'usr_2')).toHaveLength(0)

  const access = (await readUserAccess(env.DB, { userId }))!
  await mutateBinding(env, userId, other.id, assign(access.revision!, now + 20_000, null), userId, now)
  await markModuleReady(env.DB, userSubscriptionPublicReady)
  const artifact = await loadUnifiedArtifact(env, userId, access.token_hash!, 'generic')
  expect(artifact.validUntil).toBe(now + 20_000)
})

it('holds legacy shares for scope review when unified public operations are enabled', async () => {
  const now = Date.now()
  const { subscription } = await createSubscription(env, {
    userId, name: 'Legacy scope', groupIds: [groupId], startsAt: now - 100, expiresAt: null,
  })
  const { token } = await createShare(env, userId, { subscriptionId: subscription.id })
  expect(await readShareMeta(env, token, null, null)).toMatchObject({ nodeCount: 2 })
  await markModuleReady(env.DB, userSubscriptionPublicReady)
  await expect(readShareMeta(env, token, null, null)).rejects.toMatchObject({ code: 'SHARE_LEGACY_SCOPE_REVIEW' })
  expect(await verifyShadowUser(env, userId, now, await readCatalog(env))).toMatchObject({
    matches: false, reasons: expect.arrayContaining(['LEGACY_SHARE_SCOPE_REVIEW_REQUIRED']),
  })
})

it('keeps an account link before the first binding and exposes only display nodes', async () => {
  await markModuleReady(env.DB, userSubscriptionPublicReady)
  const path = '/api/user/subscription'
  const summary = async () => (await invoke(path, withCookie(cookie))).json<{
    subscriptionUrl: string; status: string; nodeCount: number; hasAvailableNodes: boolean
  }>()
  const empty = await summary()
  expect(empty).toMatchObject({ status: 'none', nodeCount: 0, hasAvailableNodes: false })
  expect(new URL(empty.subscriptionUrl).pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/u)
  expect((await summary()).subscriptionUrl).toBe(empty.subscriptionUrl)
  const access = await readUserAccess(env.DB, { userId })
  const now = Date.now()
  await mutateBinding(env, userId, templateId, assign(access!.revision!, now - 100, null), userId, now)
  expect(await summary()).toMatchObject({
    status: 'active', nodeCount: 1, hasAvailableNodes: true, subscriptionUrl: empty.subscriptionUrl,
  })
  const nodes = await invoke(`${path}/nodes`, withCookie(cookie))
  expect(nodes.status).toBe(200)
  expect(nodes.headers.get('cache-control')).toContain('no-store')
  expect(await nodes.json()).toEqual({ nodes: [{ name: expect.any(String), protocol: expect.any(String) }] })
})

it('returns a binding conflict when a reviewed revision is stale', async () => {
  const path = `/api/admin/users/${userId}/template-bindings/${templateId}`
  const now = Date.now()
  const input = assign(0, now - 100, null)
  const preview = await invoke(`${path}/preview?expectedRevision=0&expiry=permanent`, withCookie(cookie))
  expect(preview.status).toBe(200)
  await mutateBinding(env, userId, templateId, input, userId, now)
  const stale = await invoke(path, withCookie(cookie, jsonRequest({ ...input, requestId: crypto.randomUUID() }, { method: 'PUT' })))
  expect(stale.status).toBe(409)
})

it('backfills private templates atomically and keeps old tokens scoped through the grace period', async () => {
  await applyBackfillMigration()
  const startsAt = Date.now() - 1_000
  const first = await createSubscription(env, {
    userId, name: 'Legacy scoped test', groupIds: [], nodeIds: [nodeId], startsAt, expiresAt: null, enabled: true,
  })
  const second = await createSubscription(env, {
    userId, name: 'Other legacy scope', groupIds: [], nodeIds: [otherNodeId], startsAt, expiresAt: null, enabled: true,
  })
  const preview = await previewBackfill(env, userId, userId)
  expect(preview.blockers).toEqual([])
  expect(await readBindings(env.DB, userId)).toHaveLength(0)
  expect(JSON.stringify(preview)).not.toContain(first.token)
  await expect(executeBackfill(env, userId, userId, 'stale')).rejects.toMatchObject({ status: 409 })
  const attempts = await Promise.allSettled([
    executeBackfill(env, userId, userId, preview.digest), executeBackfill(env, userId, userId, preview.digest),
  ])
  expect(attempts.some(result => result.status === 'fulfilled')).toBe(true)
  for (const attempt of attempts) if (attempt.status === 'rejected') expect(attempt.reason).toMatchObject({ status: 409 })
  const before = await readUserAccess(env.DB, { userId })
  await executeBackfill(env, userId, userId, preview.digest)
  expect(await readUserAccess(env.DB, { userId })).toEqual(before)
  expect(await readBindings(env.DB, userId)).toHaveLength(2)
  expect(await reconcileBackfill(env, userId)).toMatchObject({ matches: true, oldNodes: 2, newNodes: 2 })
  expect((await invoke(`/sub/${first.token}`)).status).toBe(200)
  await markModuleReady(env.DB, userSubscriptionPublicReady)
  const setCutover = (instant: number) => env.DB.prepare('INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)')
    .bind(cutoverSetting, String(instant), new Date().toISOString()).run()
  await setCutover(Date.now() - 100)
  const response = await invoke(`/sub/${first.token}`, { headers: { 'If-None-Match': '*' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const contents = atob(await response.text())
  expect(contents).toContain('one.example')
  expect(contents).not.toContain('two.example')
  const mapping = (await reconcileBackfill(env, userId)).mappings.find(item => item.legacyId === first.subscription.id)!
  await mutateBinding(env, userId, mapping.templateId, { mode: 'pause', expectedRevision: before!.revision!, requestId: crypto.randomUUID() }, userId)
  expect((await invoke(`/sub/${first.token}`)).status).toBe(404)
  expect((await invoke(`/sub/${second.token}`)).status).toBe(200)
  await setCutover(Date.now() - 90 * 86_400_000)
  expect((await invoke(`/sub/${second.token}`)).status).toBe(404)
  await setCutover(Date.now() - 100)
  const rotated = await resetSubscriptionToken(env, second.subscription.id, { actorUserId: userId, actorRole: 'admin' })
  expect((await invoke(`/sub/${second.token}`, { headers: { 'If-None-Match': '*' } })).status).toBe(404)
  expect((await invoke(`/sub/${rotated.token}`)).status).toBe(404)
  expect(await reconcileBackfill(env, userId)).toMatchObject({ matches: false, reasons: expect.arrayContaining(['SOURCE_CHANGED']) })
})

it('reports legacy plan limits and blocks shadow writes', async () => {
  await applyBackfillMigration()
  await createSubscription(env, {
    userId, name: 'Limited test', groupIds: [], nodeIds: [nodeId], expiresAt: null, enabled: true, deviceLimit: 1,
  })
  const preview = await previewBackfill(env, userId, userId)
  expect(preview.blockers).toContain('PLAN_POLICY_UNVERIFIED')
  await expect(executeBackfill(env, userId, userId, preview.digest)).rejects.toMatchObject({ status: 409 })
  expect(await readBindings(env.DB, userId)).toHaveLength(0)
})

it('bounds a synthetic 32-binding aggregate, rejects the next binding and node, and rejects oversized output', async () => {
  const current = await readCatalog(env)
  const template = await createEntitlementTemplate(env.DB, {
    name: 'Load fixture', description: '', allowRedemption: false,
    config: { ...config([]), groupIds: [groupId] },
  }, userId)
  const now = Date.now()
  await mutateBinding(env, userId, template.id, assign(0, now - 1000, null), userId, now)
  const [base] = await readBindings(env.DB, userId)
  const access = await readUserAccess(env.DB, { userId })
  const bindings = Array.from({ length: 32 }, (_, index) => ({ ...base, template_id: `synthetic-${index}` }))
  const nodes = Array.from({ length: 2001 }, (_, index) => ({
    ...current.nodes[0], id: `node_${index + 1}`, server: `node-${index + 1}.example.test`, order: index,
  }))
  const start = performance.now()
  const result = aggregateBindings(access, bindings, now, { ...current, nodes: nodes.slice(0, 2000) })
  const duration = performance.now() - start
  expect(result.nodes).toHaveLength(2000)
  console.info(JSON.stringify({ event: 'pr5_aggregate_load', bindings: bindings.length, nodes: result.nodes.length, wallMs: duration }))
  expect(() => aggregateBindings(access, [...bindings, base], now, { ...current, nodes }))
    .toThrow('授权资源数量超出限制')
  expect(() => aggregateBindings(access, bindings, now, { ...current, nodes }))
    .toThrow('授权资源数量超出限制')
  expect(() => enforceUnifiedOutputLimit('x'.repeat(2 * 1024 * 1024))).not.toThrow()
  expect(() => enforceUnifiedOutputLimit('x'.repeat(2 * 1024 * 1024) + '界')).toThrow('订阅输出过大')
})
