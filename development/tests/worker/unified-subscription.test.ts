import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { markModuleReady } from '../../../worker/db/module-switch'
import { readCatalog, writeCatalog } from '../../../worker/catalog/repository'
import { createEntitlementTemplate, updateEntitlementTemplate } from '../../../worker/delivery/entitlement-templates'
import { mutateBinding, mutateBindingsByUser, readBindings } from '../../../worker/delivery/bindings'
import { aggregateBindings, resolveUserSubscription, uniqueConnections } from '../../../worker/delivery/aggregate'
import { readUserAccess, userSubscriptionPublicReady } from '../../../worker/delivery/user-access'
import { enforceUnifiedOutputLimit, loadUnifiedArtifact } from '../../../worker/delivery/unified-artifacts'
import { createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

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
  await setupContractedAdmin()
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
  await env.DB.prepare('DELETE FROM system_settings WHERE key=?').bind(userSubscriptionPublicReady).run()
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

it('flags unverified quotas across unified bindings', async () => {
  const limited = await makeTemplate([nodeId], 1)
  const first = await mutateBinding(env, userId, templateId, assign(0, instant - 1000, null), userId, instant)
  await mutateBinding(env, userId, limited.id, assign(first.revision, instant - 1000, null), userId, instant)
  expect(await resolve(instant)).toMatchObject({
    diagnostics: [], unverifiedQuota: true, nodes: [{ id: nodeId }],
  })
})

it('uses built-in conversion and keeps user artifacts isolated', async () => {
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

  expect(a.conversionVersion).toBe(b.conversionVersion)
  expect((await invoke('/api/admin/system/subscription-templates', withCookie(cookie))).status).toBe(404)
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
