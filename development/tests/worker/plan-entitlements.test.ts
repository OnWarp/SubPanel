import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import schema from '../../../migrations/0031_plan_schema.sql?raw'
import schemaDown from '../../../migrations/down/0031_plan_schema.down.sql?raw'
import groups from '../../../migrations/0032_group_metadata.sql?raw'
import backfill from '../../../migrations/0033_plan_backfill.sql?raw'
import { readCatalog, writeCatalog } from '../../../worker/catalog/repository'
import { DomainService, putDomainRestrictionEnabled } from '../../../worker/domains/domain-service'
import { revealUserToken, readUserAccess } from '../../../worker/delivery/user-access'
import { hashToken } from '../../../worker/platform/crypto'
import { EntitlementResolver, readPlanUser } from '../../../worker/plans/entitlements'
import { assignPlan, changeToken, createDefinition, mutateInstance, updateDefinition } from '../../../worker/plans/service'
import { splitSqlStatements } from './d1'
import { bindFixtureTemplate, createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

const db = env.DB
const actor = 'usr_1'
const other = 'usr_2'
const now = Date.now() - 10_000
let cookie: string
let groupIds: string[]
let nodeIds: string[]

const run = (sql: string) => db.batch(splitSqlStatements(sql).map(statement => db.prepare(statement)))
const call = (path: string, init?: RequestInit, origin = TEST_ORIGIN) => exports.default.fetch(new URL(path, origin), init)
const admin = (path: string, body: unknown) => call(`/api/admin${path}`, withCookie(cookie, jsonRequest(body)))
const def = (nodeGroupIds: string[]) => createDefinition(db, {
  nodeGroupIds, name: 'Test plan', description: '', enabled: true, remark: null, durationSeconds: 30 * 86400,
}, actor)
const grant = (planId: string, user = actor, expiresAt = now + 120_000) =>
  assignPlan(env, user, planId, { durationMode: 'custom', startsAt: now - 1000, expiresAt }, actor, now)
const publicLink = (token: string, format = 'clash') => call(`/s/${token}/${format}`)
const nodeNames = async (response: Response) => {
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  return (parse(await response.text()) as { proxies: { name: string }[] }).proxies.map(node => node.name)
}
async function resolve(userId = actor, instanceId: string | null = null, at = now) {
  const user = await readPlanUser(db, userId)
  const result = await new EntitlementResolver(db).resolve(user!, instanceId, at)
  return result.nodes.map(node => node.id)
}

beforeEach(async () => {
  await run(schemaDown)
  await setupContractedAdmin()
  await run(schema)
  await putDomainRestrictionEnabled(db, false)
  await db.prepare('DELETE FROM domain_bindings').run()
  await db.prepare('DELETE FROM domains').run()
  const columns = await db.prepare('PRAGMA table_info(groups)').all<{ name: string }>()
  if (!columns.results.some(column => column.name === 'enabled')) await run(groups)
  await createFixtureAccount('member', 'a synthetic test password')
  cookie = await login()
  const credentials = btoa('aes-128-gcm:fixture')
  const response = await admin('/catalog/sources', {
    name: 'Fixture source', type: 'manual',
    content: `ss://${credentials}@one.test:8388#Same\nss://${credentials}@two.test:8388#Second\nss://${credentials}@three.test:8388#Third`,
  })
  expect(response.status).toBe(201)
  const catalog = await readCatalog(env)
  nodeIds = catalog.nodes.map(node => node.id)
  groupIds = []
  for (const nodeId of nodeIds) {
    const res = await admin('/catalog/groups', {
      name: nodeId, sourceIds: [], includedNodeIds: [nodeId], excludedNodeIds: [], nodeOrder: [],
    })
    expect(res.status).toBe(201)
    groupIds.push((await res.json<{ group: { id: string } }>()).group.id)
  }
  const refreshed = await readCatalog(env)
  await writeCatalog(env, { ...refreshed, nodes: refreshed.nodes.map((node, index) =>
    index === 1 ? { ...node, displayName: 'Same' } : node) })
})

it('deduplicates shared paths by ID, applies exact windows and observes live group and definition changes', async () => {
  const [first, second] = await Promise.all([def(groupIds.slice(0, 2)), def(groupIds.slice(1))])
  const a = await grant(first.id, actor, now + 1)
  const b = await grant(second.id)
  expect(await resolve()).toEqual([...nodeIds].sort())
  expect(await resolve(actor, a.instance.id)).toEqual(nodeIds.slice(0, 2).sort())
  expect(await resolve(actor, null, now + 1)).toEqual(nodeIds.slice(1).sort())
  expect(await resolve(actor, a.instance.id, now + 1)).toEqual([])
  const disabled = await updateDefinition(db, second.id, 1, { enabled: false }, actor)
  expect(await resolve(actor, null, now + 1)).toEqual([])
  await expect(updateDefinition(db, second.id, 1, { nodeGroupIds: [] }, actor)).rejects.toMatchObject({ status: 409 })
  await updateDefinition(db, second.id, disabled.version, { enabled: true }, actor, true)
  expect(await resolve(actor, null, now + 1)).toEqual(nodeIds.slice(1).sort())
  await expect(grant(second.id)).rejects.toMatchObject({ code: 'PLAN_NOT_ASSIGNABLE' })
  await db.prepare('UPDATE groups SET enabled=0 WHERE id=?').bind(groupIds[1]).run()
  expect(await resolve()).toEqual([nodeIds[0], nodeIds[2]].sort())
  await expect(resolve(other, b.instance.id)).rejects.toThrow()
  await db.prepare('UPDATE plan_definitions SET owner_user_id=? WHERE id=?').bind(other, second.id).run()
  await expect(resolve(actor, b.instance.id)).rejects.toThrow()
  await expect(grant(second.id)).rejects.toMatchObject({ status: 404 })
  await db.prepare('UPDATE users SET enabled=0 WHERE id=?').bind(actor).run()
  await expect(resolve()).rejects.toThrow()
})

it('preserves lifecycle invariants and serializes versioned edits', async () => {
  const plan = await def([groupIds[0]])
  const { instance: row } = await grant(plan.id, actor, now + 1000)
  await expect(mutateInstance(db, row.id, { action: 'patch', expiresAt: row.starts_at }, actor))
    .rejects.toMatchObject({ code: 'INVALID_DURATION' })
  const paused = await mutateInstance(db, row.id, { action: 'pause' }, actor, 1, now)
  expect(paused).toMatchObject({ expires_at: row.expires_at, status: 'paused' })
  const extended = await mutateInstance(db, row.id, { action: 'renew', durationSeconds: 2 }, actor, 2, now)
  expect(extended).toMatchObject({ expires_at: now + 3000, status: 'paused' })
  const renewed = await mutateInstance(db, row.id, { action: 'renew', durationSeconds: 2 }, actor, 3, now + 5000)
  expect(renewed).toMatchObject({ expires_at: now + 7000, status: 'paused' })
  expect((await mutateInstance(db, row.id, { action: 'resume' }, actor, 4, now)).status).toBe('active')
  const edits = await Promise.allSettled(['one', 'two'].map(remark =>
    mutateInstance(db, row.id, { action: 'patch', remark }, actor, 5, now)))
  expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  await mutateInstance(db, row.id, { action: 'revoke' }, actor, undefined, now)
  await expect(mutateInstance(db, row.id, { action: 'resume' }, actor)).rejects.toMatchObject({ code: 'PLAN_INSTANCE_REVOKED' })
  await expect(mutateInstance(db, row.id, { action: 'renew', durationSeconds: 60 }, actor)).rejects.toMatchObject({ code: 'PLAN_INSTANCE_REVOKED' })
  const permanent = await assignPlan(env, actor, plan.id, { durationMode: 'permanent' }, actor, now)
  await expect(mutateInstance(db, permanent.instance.id, { action: 'renew', durationSeconds: 60 }, actor))
    .rejects.toMatchObject({ code: 'INVALID_DURATION' })
})

it('isolates public scopes and resets, keeps aliases exact and returns parseable empty formats', async () => {
  const one = await def(groupIds.slice(0, 1))
  const two = await def(groupIds.slice(1))
  const a = await grant(one.id)
  const b = await grant(two.id)
  await grant(one.id, other)
  const { raw: aggregate } = await changeToken(env, actor, null, actor, 'copy')
  expect(await nodeNames(await publicLink(a.token))).toEqual(['Same'])
  expect(await nodeNames(await publicLink(b.token))).toEqual(['Same', 'Third'])
  expect(await nodeNames(await publicLink(aggregate))).toEqual(['Same', 'Same (2)', 'Third'])
  expect((await call(`/s/p/${aggregate}`)).status).toBe(404)
  const oldPackage = 'oldPackageAlias1'
  const oldAggregate = 'oldAggregatAlias'
  await db.batch([
    db.prepare("INSERT INTO legacy_subscription_routes VALUES (?,'package',?,NULL)").bind(await hashToken(oldPackage), a.instance.id),
    db.prepare("INSERT INTO legacy_subscription_routes VALUES (?,'aggregate',?,NULL)").bind(await hashToken(oldAggregate), actor),
  ])
  expect(await nodeNames(await call(`/sub/${oldPackage}/clash`))).toEqual(['Same'])
  expect(await nodeNames(await call(`/sub/${oldAggregate}/clash`))).toEqual(['Same', 'Same (2)', 'Third'])
  expect((await call(`/sub/${a.token}`)).status).toBe(404)
  const replaced = await admin(`/user-plans/${a.instance.id}/reset-token`, {})
  expect(replaced.status).toBe(200)
  const { token: packageToken } = await replaced.json<{ token: string }>()
  expect((await publicLink(a.token)).status).toBe(404)
  expect((await call(`/sub/${oldPackage}`)).status).toBe(404)
  expect(await nodeNames(await publicLink(aggregate))).toHaveLength(3)
  const reset = await admin(`/users/${actor}/reset-aggregate-token`, {})
  expect(reset.status).toBe(200)
  const { token: aggregateToken } = await reset.json<{ token: string }>()
  expect((await publicLink(aggregate)).status).toBe(404)
  expect((await call(`/sub/${oldAggregate}`)).status).toBe(404)
  expect(await nodeNames(await publicLink(packageToken))).toHaveLength(1)
  await mutateInstance(db, a.instance.id, { action: 'patch', expiresAt: now }, actor)
  expect(await nodeNames(await publicLink(packageToken))).toEqual([])
  await mutateInstance(db, b.instance.id, { action: 'revoke' }, actor)
  expect((await publicLink(b.token)).status).toBe(404)
  expect(await nodeNames(await publicLink(aggregateToken))).toEqual([])
  const generic = await publicLink(aggregateToken, 'generic')
  expect(generic.status).toBe(200)
  expect(atob(await generic.text())).toBe('')
  await db.prepare('UPDATE users SET enabled=0 WHERE id=?').bind(actor).run()
  const denied = await publicLink(aggregateToken)
  const unknown = await publicLink('z'.repeat(43))
  expect(denied.status).toBe(404)
  expect(await denied.json()).toEqual(await unknown.json())
})

it('preserves the original migrated aggregate URL and direct nodes without a group grant', async () => {
  const template = await bindFixtureTemplate(actor, { name: 'Direct only', nodeIds: [nodeIds[2]], startsAt: now })
  const old = await readUserAccess(db, { userId: actor })
  const raw = (await revealUserToken(env, old))!
  expect((await nodeNames(await publicLink(raw)))).toEqual(['Third'])
  await run(backfill)
  const planId = `migration:template:${template.id}`
  const instanceId = `migration:binding:${JSON.stringify([actor, template.id])}`
  const { raw: independent } = await changeToken(env, actor, instanceId, actor, 'copy')
  expect(await nodeNames(await publicLink(independent))).toEqual(['Third'])
  expect(await nodeNames(await publicLink(raw))).toEqual(['Third'])
  await updateDefinition(db, planId, 1, { remark: 'Edited migration note' }, actor)
  expect(await nodeNames(await publicLink(independent))).toEqual(['Third'])
  const reconciliation = (column: string) => db.prepare(backfill.split('\n')
    .find(line => line.startsWith('-- SELECT') && line.includes(`AS ${column}`))!.slice(3)).all()
  expect((await reconciliation('missing_direct_node')).results).toEqual([])
  expect((await reconciliation('extra_direct_node')).results).toEqual([])
  const changeDirectNodes = (ids: string[]) => db.prepare('UPDATE plan_definitions SET remark=json_set(remark, ?, json(?)) WHERE id=?')
    .bind('$.direct_node_ids', JSON.stringify(ids), planId).run()
  await changeDirectNodes([])
  expect((await reconciliation('missing_direct_node')).results).toEqual([{ id: planId, missing_direct_node: nodeIds[2] }])
  await changeDirectNodes([nodeIds[2], 'missing-node'])
  expect((await reconciliation('extra_direct_node')).results).toEqual([{ id: planId, extra_direct_node: 'missing-node' }])
  expect((await reconciliation('direct_nodes_missing')).results).toEqual([{ direct_nodes_missing: 1 }])
  expect(await nodeNames(await publicLink(raw))).toEqual(['Third'])
  const reset = await call('/api/user/subscription/reset-token', withCookie(cookie, jsonRequest({})))
  expect(reset.status).toBe(200)
  expect((await publicLink(raw)).status).toBe(404)
  const newAccess = await readUserAccess(db, { userId: actor })
  expect(await nodeNames(await publicLink((await revealUserToken(env, newAccess))!))).toEqual(['Third'])
  expect(await nodeNames(await publicLink(independent))).toEqual(['Third'])
})

it('uses only the verified primary for copy and enforces the independent subscription allowlist', async () => {
  const stamp = new Date(now).toISOString()
  await db.prepare('DELETE FROM domains').run()
  for (const [key, host, purpose, enabled, primary] of [
    ['panel', new URL(TEST_ORIGIN).hostname, 'panel', 1, 1],
    ['first', 'primary.test', 'subscription', 1, 1],
    ['second', 'secondary.test', 'subscription', 1, 0],
    ['off', 'disabled.test', 'subscription', 0, 0],
  ] as const) {
    await db.batch([
      db.prepare(`INSERT INTO domains (id,hostname,verification_status,verified_at,created_at,updated_at)
        VALUES (?,?,'verified',?,?,?)`).bind(key, host, stamp, stamp, stamp),
      db.prepare(`INSERT INTO domain_bindings(id,domain_id,purpose,enabled,is_primary,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind(key, key, purpose, enabled, primary, stamp, stamp),
    ])
  }
  await putDomainRestrictionEnabled(db, true)
  const copy = () => call('/api/me/subscriptions/copy', withCookie(cookie, jsonRequest({}, {
    headers: { host: 'forged.test', 'x-forwarded-host': 'forged.test' },
  })))
  const response = await copy()
  expect(response.status).toBe(200)
  const first = new URL((await response.json<{ subscriptionUrl: string }>()).subscriptionUrl)
  expect(first.hostname).toBe('primary.test')
  expect((await call(first.pathname, undefined, 'https://primary.test')).status).toBe(200)
  expect((await call(first.pathname, undefined, 'https://secondary.test')).status).toBe(200)
  const denied = await call(first.pathname, undefined, 'https://disabled.test')
  expect(denied.status).toBe(404)
  expect(denied.headers.get('cache-control')).toBe('private, no-store')
  expect((await call('/api/me/plans', withCookie(cookie), 'https://secondary.test')).status).toBe(404)
  await new DomainService(db).setPrimary('subscription', 'second')
  const second = new URL((await (await copy()).json<{ subscriptionUrl: string }>()).subscriptionUrl)
  expect(second.hostname).toBe('secondary.test')
  expect(second.pathname).toBe(first.pathname)
  const list = await call('/api/me/subscriptions', withCookie(cookie))
  expect(list.status).toBe(200)
  expect(await list.text()).not.toContain(first.pathname)
})

it('serves the new admin and user contracts with session-based permissions', async () => {
  const userCookie = await login('member', 'a synthetic test password')
  const adminCall = (path: string, method = 'GET', body?: unknown) =>
    call(`/api/admin${path}`, withCookie(cookie, body === undefined ? { method } : jsonRequest(body, { method })))
  expect((await call('/api/me/plans')).status).toBe(401)
  expect((await call('/api/admin/plan-definitions', withCookie(userCookie))).status).toBe(403)
  const created = await admin('/plan-definitions', {
    name: 'Managed fixture', nodeGroupIds: [groupIds[0]], durationSeconds: 30 * 86400,
  })
  expect(created.status).toBe(201)
  const { plan } = await created.json<{ plan: { id: string } }>()
  const path = `/plan-definitions/${plan.id}`
  const duplicate = await admin(`${path}/duplicate`, {})
  expect(duplicate.status).toBe(201)
  expect(await duplicate.json()).toMatchObject({ plan: { nodeGroupIds: [groupIds[0]], version: 1 } })
  expect((await adminCall('/plans')).status).toBe(200)
  const assigned = await admin(`/users/${other}/plans`, { planId: plan.id, durationMode: 'inherit' })
  expect(assigned.status).toBe(201)
  const { instance: row, token } = await assigned.json<{ instance: { id: string; starts_at: number; expires_at: number }; token: string }>()
  expect(row.expires_at - row.starts_at).toBe(30 * 86400 * 1000)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const wrongOwner = await call('/api/me/subscriptions/copy', withCookie(cookie, jsonRequest({ instanceId: row.id })))
  const missing = await call('/api/me/subscriptions/copy', withCookie(cookie, jsonRequest({ instanceId: 'missing' })))
  expect(wrongOwner.status).toBe(404)
  expect(await wrongOwner.json()).toEqual(await missing.json())
  const userPlans = await call('/api/me/plans?status=active&search=Managed', withCookie(userCookie))
  expect(await userPlans.json()).toMatchObject({ plans: [{ id: row.id, source: 'admin', nodeCount: 1, status: 'active' }] })
  const adminList = await adminCall(`${path}/users?status=active`)
  expect(await adminList.json()).toMatchObject({ instances: [{ id: row.id }] })
  const archived = await adminCall(path, 'DELETE', { version: 1 })
  expect(archived.status).toBe(204)
  expect(await nodeNames(await publicLink(token))).toEqual(['Same'])
  expect((await admin(`/users/${other}/plans`, { planId: plan.id, durationMode: 'inherit' })).status).toBe(409)
  const audit = await db.prepare("SELECT action, detail FROM audit_logs WHERE target_type IN ('user_plan','plan_definition')").all()
  expect(JSON.stringify(audit.results)).not.toContain(token)
})

it('honors group source eligibility, dynamic rules, exclusions and node disablement in D1', async () => {
  const catalog = await readCatalog(env)
  const [source] = catalog.sources
  const [group] = catalog.groups
  const updatedGroup = {
    ...group, sourceIds: [source.id], includedNodeIds: [nodeIds[0]], excludedNodeIds: [nodeIds[1]],
    rules: { namePattern: '^Third$' },
  }
  await writeCatalog(env, { ...catalog, groups: catalog.groups.map(item => item.id === group.id ? updatedGroup : item) })
  const plan = await def([group.id])
  await grant(plan.id)
  expect(await resolve()).toEqual([nodeIds[0], nodeIds[2]].sort())
  const node = catalog.nodes.find(item => item.id === nodeIds[2])!
  await db.prepare('UPDATE sources SET enabled=0 WHERE id=?').bind(source.id).run()
  expect(await resolve()).toEqual([nodeIds[0]])
  await db.prepare('UPDATE nodes SET retained=1 WHERE id=?').bind(node.id).run()
  expect(await resolve()).toEqual([nodeIds[0], nodeIds[2]].sort())
  await db.prepare('UPDATE nodes SET enabled=0 WHERE id=?').bind(node.id).run()
  expect(await resolve()).toEqual([nodeIds[0]])
})
