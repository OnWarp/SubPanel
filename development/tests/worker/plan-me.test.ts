import { readCatalog } from '../../../worker/catalog/repository'
import { app } from '../../../worker/app'
import { toBase64Url } from '../../../worker/platform/crypto'
import { createDefinition, mutateInstance, assignPlan } from '../../../worker/plans/service'
import { generateRedeemCodes, generateRedeemInput } from '../../../worker/plans/redeem'
import { readPlanSummary, decodeCursor, encodeCursor, planName } from '../../../worker/plans/me'
import schema from '../../../migrations/0031_plan_schema.sql?raw'
import schemaDown from '../../../migrations/down/0031_plan_schema.down.sql?raw'
import groups from '../../../migrations/0032_group_metadata.sql?raw'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { splitSqlStatements } from './d1'
import { createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

const db = env.DB
const actor = 'usr_1'
const password = 'a synthetic test password'
const DAY = 86_400_000
let bindings: Env
let adminCookie: string
let member: { id: string; cookie: string }
let other: { id: string; cookie: string }
let groupIds: string[]
let nodeIds: string[]

const run = (sql: string) => db.batch(splitSqlStatements(sql).map(statement => db.prepare(statement)))
const call = (path: string, cookie: string, body?: object, method = 'POST') => {
  const init = body === undefined
    ? withCookie(cookie, { method, headers: { origin: TEST_ORIGIN } })
    : jsonRequest(body, withCookie(cookie, { method }))
  return app.fetch(new Request(TEST_ORIGIN + path, init), bindings)
}
const me = (path: string, cookie: string) => call(`/api/me${path}`, cookie, undefined, 'GET')

async function definition(name: string, durationSeconds: number | null = 30 * 86400, nodeGroupIds = [groupIds[0]]) {
  return createDefinition(db, { nodeGroupIds, name, description: '', enabled: true, remark: null, durationSeconds }, actor)
}

async function grant(userId: string, planId: string, expiresAt: number | null) {
  return assignPlan(bindings, userId, planId, expiresAt === null
    ? { durationMode: 'permanent', startsAt: Date.now() - 1000 }
    : { durationMode: 'custom', expiresAt, startsAt: Date.now() - 1000 }, actor)
}

beforeEach(async () => {
  await run(schemaDown)
  await setupContractedAdmin()
  await run(schema)
  const columns = await db.prepare('PRAGMA table_info(groups)').all<{ name: string }>()
  if (!columns.results.some(column => column.name === 'enabled')) await run(groups)
  bindings = { ...env, REDEMPTION_HMAC_KEYS: JSON.stringify({ active: 'v1', keys: { v1: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) } }) }
  const created = await (await createFixtureAccount('member', password)).json<{ user: { id: string } }>()
  const second = await (await createFixtureAccount('other', password)).json<{ user: { id: string } }>()
  adminCookie = await login()
  member = { id: created.user.id, cookie: await login('member', password) }
  other = { id: second.user.id, cookie: await login('other', password) }
  const admin = (path: string, body: unknown) => call(`/api/admin${path}`, adminCookie, body)
  const credentials = btoa('aes-128-gcm:fixture')
  const source = await admin('/catalog/sources', {
    name: 'Fixture source', type: 'manual',
    content: `ss://${credentials}@one.test:8388#Same\nss://${credentials}@two.test:8388#Second`,
  })
  expect(source.status).toBe(201)
  const catalog = await readCatalog(env)
  nodeIds = catalog.nodes.map(node => node.id)
  groupIds = []
  for (const nodeId of nodeIds) {
    const response = await admin('/catalog/groups', {
      name: nodeId, sourceIds: [], includedNodeIds: [nodeId], excludedNodeIds: [], nodeOrder: [],
    })
    expect(response.status).toBe(201)
    groupIds.push((await response.json<{ group: { id: string } }>()).group.id)
  }
})

it('reports an empty overview as "none" and never as an error', async () => {
  const response = await me('/overview', member.cookie)
  expect(response.status).toBe(200)
  const body = await response.json<{ user: { id: string }; plans: Record<string, unknown>; serverTime: string }>()
  expect(body.user.id).toBe(member.id)
  expect(body.plans).toMatchObject({
    total: 0, active: 0, expired: 0, pending: 0, disabled: 0, accessStatus: 'none',
    validUntil: null, hasPermanentActivePlan: false, nextExpiryAt: null, expiringSoonCount: 0,
  })
  expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false)
  const list = await me('/plans', member.cookie)
  expect(list.status).toBe(200)
  expect(await list.json()).toMatchObject({ items: [], nextCursor: null, summary: { total: 0, accessStatus: 'none' } })
})

it('takes the latest active expiry over, and reports permanent when any grant is permanent', async () => {
  const now = Date.now()
  const base = await definition('基础套餐')
  const first = await definition('高级套餐')
  const soon = await grant(member.id, base.id, now + 10 * DAY)
  const later = await grant(member.id, first.id, now + 40 * DAY)
  const summary = await readPlanSummary(db, member.id, now)
  expect(summary).toMatchObject({ total: 2, active: 2, accessStatus: 'active', expiringSoonCount: 0 })
  expect(summary.validUntil).toBe(later.instance.expires_at)
  expect(summary.nextExpiryAt).toBe(soon.instance.expires_at)

  const permanent = await definition('永久套餐', null)
  await grant(member.id, permanent.id, null)
  const withPermanent = await readPlanSummary(db, member.id, now)
  expect(withPermanent).toMatchObject({
    total: 3, active: 3, hasPermanentActivePlan: true, validUntil: null, accessStatus: 'active',
  })
  // nextExpiryAt still names the nearest finite expiry so the card can warn.
  expect(withPermanent.nextExpiryAt).toBe(soon.instance.expires_at)
})

it('does not count expiring grants from other buckets and marks an expired-only account expired', async () => {
  const now = Date.now()
  const plan = await definition('套餐')
  const soon = await grant(member.id, plan.id, now + 3 * DAY)
  expect((await readPlanSummary(db, member.id, now)).expiringSoonCount).toBe(1)
  const expired = await grant(member.id, plan.id, now + DAY)
  // Backdate into the past; assignPlan only accepts a future window.
  await db.prepare('UPDATE user_plans SET starts_at=?, expires_at=? WHERE id=?')
    .bind(now - 3 * DAY, now - DAY, expired.instance.id).run()
  const summary = await readPlanSummary(db, member.id, now)
  expect(summary).toMatchObject({ total: 2, active: 1, expired: 1, accessStatus: 'active', expiringSoonCount: 1 })

  await db.prepare('UPDATE user_plans SET starts_at=?, expires_at=? WHERE id=?')
    .bind(now - 3 * DAY, now - 2 * DAY, soon.instance.id).run()
  const allExpired = await readPlanSummary(db, member.id, now)
  expect(allExpired.accessStatus).toBe('expired')
  expect(allExpired.validUntil).toBeNull()
  expect(allExpired.lastExpiredAt).toBeGreaterThan(0)
})

it('treats the expiry instant as already expired and sorts a mixed list per the spec', async () => {
  const now = Date.now()
  const a = await definition('甲')
  const b = await definition('乙')
  const c = await definition('丙')
  const d = await definition('丁')
  const nowActive = await grant(member.id, a.id, now + 30 * DAY)
  const soonActive = await grant(member.id, b.id, now + 5 * DAY)
  const laterActive = await grant(member.id, c.id, now + 20 * DAY)
  const permanent = await definition('永久', null)
  const forever = await grant(member.id, permanent.id, null)
  const pending = await assignPlan(bindings, member.id, d.id, {
    durationMode: 'custom', startsAt: now + 5 * DAY, expiresAt: now + 35 * DAY,
  }, actor)
  const past = await grant(member.id, a.id, now + DAY)
  await db.prepare('UPDATE user_plans SET starts_at=?, expires_at=? WHERE id=?')
    .bind(now - 10 * DAY, now - 5 * DAY, past.instance.id).run()
  const paused = await grant(member.id, b.id, now + 15 * DAY)
  await mutateInstance(db, paused.instance.id, { action: 'pause' }, actor)

  const response = await me('/plans?limit=20', member.cookie)
  const body = await response.json<{ items: Array<{ instanceId: string; bucket: string; status: string }>; nextCursor: string | null }>()
  expect(body.items.map(row => row.instanceId)).toEqual([
    soonActive.instance.id, laterActive.instance.id, nowActive.instance.id, forever.instance.id,
    pending.instance.id, past.instance.id, paused.instance.id,
  ])
  expect(body.items.map(row => row.bucket)).toEqual([
    'active', 'active', 'active', 'active', 'pending', 'expired', 'disabled',
  ])
  expect(body.nextCursor).toBeNull()

  // expiresAt === now is the boundary: [startsAt, expiresAt), so it is expired.
  await db.prepare('UPDATE user_plans SET expires_at=? WHERE id=?').bind(now, laterActive.instance.id).run()
  const boundary = await readPlanSummary(db, member.id, now)
  expect(boundary.expired).toBe(2)
  expect(boundary.expiringSoonCount).toBe(1)
})

it('serves cursor pagination that matches the offset contract and rejects tampering', async () => {
  const now = Date.now()
  const plan = await definition('分页套餐')
  const created = []
  for (let index = 0; index < 5; index += 1) created.push(await grant(member.id, plan.id, now + (index + 1) * DAY))
  const first = await me('/plans?limit=2', member.cookie)
  const firstBody = await first.json<{ items: Array<{ instanceId: string }>; nextCursor: string }>()
  expect(firstBody.items).toHaveLength(2)
  const second = await me(`/plans?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`, member.cookie)
  const secondBody = await second.json<{ items: Array<{ instanceId: string }>; nextCursor: string }>()
  expect(secondBody.items).toHaveLength(2)
  const overlap = new Set([...firstBody.items, ...secondBody.items].map(row => row.instanceId))
  expect(overlap.size).toBe(4)
  const offset = await me('/plans?limit=2&offset=2', member.cookie)
  const offsetBody = await offset.json<{ items: Array<{ instanceId: string }> }>()
  expect(offsetBody.items.map(row => row.instanceId)).toEqual(secondBody.items.map(row => row.instanceId))

  const wrongSize = await me(`/plans?limit=3&cursor=${encodeURIComponent(firstBody.nextCursor)}`, member.cookie)
  expect(wrongSize.status).toBe(400)
  const wrongFilter = await me(`/plans?status=active&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`, member.cookie)
  expect(wrongFilter.status).toBe(400)
  expect((await me('/plans?limit=2&cursor=not-a-cursor', member.cookie)).status).toBe(400)
  expect(decodeCursor(encodeCursor(4, 2, 'all'))).toEqual({ offset: 4, limit: 2, status: 'all' })
  expect((await me('/plans?limit=0', member.cookie)).status).toBe(400)
})

it('filters server-side so a bucket never depends on the current page', async () => {
  const now = Date.now()
  const plan = await definition('筛选套餐')
  for (let index = 0; index < 3; index += 1) {
    const expired = await grant(member.id, plan.id, now + (index + 1) * DAY)
    await db.prepare('UPDATE user_plans SET starts_at=?, expires_at=? WHERE id=?')
      .bind(now - 10 * DAY, now - (index + 1) * DAY, expired.instance.id).run()
  }
  const fresh = await grant(member.id, plan.id, now + 3 * DAY)
  const active = await me('/plans?status=active&limit=1', member.cookie)
  const body = await active.json<{ items: Array<{ instanceId: string }>; summary: { total: number; active: number; expired: number } }>()
  expect(body.items.map(row => row.instanceId)).toEqual([fresh.instance.id])
  // The summary is always the full account set, independent of the filter.
  expect(body.summary).toMatchObject({ total: 4, active: 1, expired: 3 })
  const expired = await me('/plans?status=expired&limit=2', member.cookie)
  expect((await expired.json<{ items: unknown[] }>()).items).toHaveLength(2)
})

it('shows the detail for the owner only and never leaks a foreign instance', async () => {
  const now = Date.now()
  const plan = await definition('详情套餐')
  const own = await grant(member.id, plan.id, now + 10 * DAY)
  const foreign = await grant(other.id, plan.id, now + 10 * DAY)
  const response = await me(`/plans/${own.instance.id}`, member.cookie)
  expect(response.status).toBe(200)
  const body = await response.json<{ plan: Record<string, unknown> }>()
  expect(body.plan).toMatchObject({
    instanceId: own.instance.id, planId: plan.id, name: '详情套餐', status: 'active', source: 'admin',
    nodeGroupCount: 1, nodeGroups: [{ id: groupIds[0], name: nodeIds[0], enabled: true }],
  })
  expect(typeof body.plan.remainingSeconds).toBe('number')
  expect(body.plan.remainingSeconds as number).toBeGreaterThan(9 * 86400)

  const denied = await me(`/plans/${foreign.instance.id}`, member.cookie)
  const missing = await me('/plans/does-not-exist', member.cookie)
  expect(denied.status).toBe(404)
  expect(await denied.json()).toEqual(await missing.json())
  expect((await me(`/plans/${own.instance.id}`, '')).status).toBe(401)
})

it('falls back to a readable name when a definition is gone but keeps the instance visible', async () => {
  // Foreign keys and D1 delete triggers forbid removing a referenced
  // definition, so the missing-definition branch is exercised directly on the
  // mapping the LEFT JOIN produces (definition_id null, plan_name null).
  expect(planName({ definition_id: null, plan_name: null })).toBe('已移除套餐')
  expect(planName({ definition_id: 'p1', plan_name: null })).toBe('已移除套餐')
  expect(planName({ definition_id: 'p1', plan_name: '历史名称' })).toBe('历史名称')

  const now = Date.now()
  const plan = await definition('将被归档')
  const grantRow = await grant(member.id, plan.id, now + 10 * DAY)
  await db.prepare('UPDATE plan_definitions SET archived_at=? WHERE id=?')
    .bind(new Date(now).toISOString(), plan.id).run()
  // Archiving keeps the definition readable: the name and detail survive.
  const response = await me('/plans', member.cookie)
  const body = await response.json<{ items: Array<{ instanceId: string; name: string; status: string }> }>()
  expect(body.items[0]).toMatchObject({ instanceId: grantRow.instance.id, name: '将被归档', status: 'active' })
  const detail = await me(`/plans/${grantRow.instance.id}`, member.cookie)
  expect(detail.status).toBe(200)
  expect(await detail.json()).toMatchObject({ plan: { name: '将被归档' } })
})

it('treats a disabled definition as disabled without revoking the instance', async () => {
  const now = Date.now()
  const plan = await definition('停用套餐')
  const row = await grant(member.id, plan.id, now + 10 * DAY)
  await db.prepare('UPDATE plan_definitions SET enabled=0 WHERE id=?').bind(plan.id).run()
  const response = await me('/plans', member.cookie)
  const body = await response.json<{ items: Array<{ instanceId: string; status: string; bucket: string }>; summary: { total: number; active: number; disabled: number; accessStatus: string } }>()
  expect(body.items[0]).toMatchObject({ instanceId: row.instance.id, status: 'plan_disabled', bucket: 'disabled' })
  expect(body.summary).toMatchObject({ total: 1, active: 0, disabled: 1, accessStatus: 'disabled' })
})

it('reports pending only when nothing is active yet', async () => {
  const now = Date.now()
  const plan = await definition('待生效套餐')
  await assignPlan(bindings, member.id, plan.id, {
    durationMode: 'custom', startsAt: now + 2 * DAY, expiresAt: now + 12 * DAY,
  }, actor)
  const overview = await me('/overview', member.cookie)
  expect(await overview.json()).toMatchObject({ plans: { pending: 1, active: 0, accessStatus: 'pending', validUntil: null } })
})

it('exposes redeem through both endpoints with identical idempotency', async () => {
  const plan = await definition('兑换套餐')
  const code = (await generateRedeemCodes(bindings, actor, generateRedeemInput.parse({ planId: plan.id }))).codes[0]
  const key = crypto.randomUUID()
  const created = await call('/api/me/plans/redeem', member.cookie, { code: code.code, idempotencyKey: key })
  expect(created.status).toBe(201)
  const body = await created.json<{ replayed: boolean; instance: { id: string; name: string; expiresAt: number } }>()
  expect(body).toMatchObject({ replayed: false, instance: { name: '兑换套餐' } })
  expect(body.instance.expiresAt).toBeGreaterThan(Date.now())
  const replay = await call('/api/me/plans/redeem', member.cookie, { code: code.code, idempotencyKey: key })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ replayed: true, instance: { id: body.instance.id } })
  const legacyReplay = await call('/api/me/redeem', member.cookie, { code: code.code, idempotencyKey: key })
  expect(legacyReplay.status).toBe(200)
  expect(await legacyReplay.json()).toMatchObject({ instance: { id: body.instance.id } })
  expect((await call('/api/me/plans/redeem', member.cookie, { code: code.code })).status).toBe(400)
  expect((await call('/api/me/plans/redeem', '', { code: code.code, idempotencyKey: crypto.randomUUID() })).status).toBe(401)
  expect((await call('/api/me/plans/redeem', member.cookie, {
    code: code.code, idempotencyKey: crypto.randomUUID(), userId: other.id,
  })).status).toBe(403)
})

it('renders an invalid code as one indistinguishable 422 body', async () => {
  const plan = await definition('兑换套餐')
  const valid = (await generateRedeemCodes(bindings, actor, generateRedeemInput.parse({ planId: plan.id, quantity: 1 }))).codes[0]
  await db.prepare('UPDATE redeem_codes SET enabled=0 WHERE id=?').bind(valid.id).run()
  const results = await Promise.all(['not-a-code', valid.code].map(value =>
    call('/api/me/plans/redeem', member.cookie, { code: value, idempotencyKey: crypto.randomUUID() })))
  expect(results.map(row => row.status)).toEqual([422, 422])
  const bodies = await Promise.all(results.map(row => row.json()))
  expect(bodies[0]).toEqual(bodies[1])
  expect(JSON.stringify(bodies)).not.toContain(valid.code)
})

it('never exposes other users, credentials or code plaintext', async () => {
  const plan = await definition('私密套餐')
  await grant(other.id, plan.id, Date.now() + 10 * DAY)
  const code = (await generateRedeemCodes(bindings, actor, generateRedeemInput.parse({ planId: plan.id }))).codes[0]
  const overview = await (await me('/overview', member.cookie)).text()
  const list = await (await me('/plans', member.cookie)).text()
  const before = overview + list
  expect(before).not.toContain(other.id)
  expect(before).not.toContain(code.code)
  expect(before).not.toContain('token')
  const own = await grant(member.id, plan.id, Date.now() + 10 * DAY)
  const detail = await (await me(`/plans/${own.instance.id}`, member.cookie)).text()
  expect(detail).not.toContain(other.id)
  expect(detail).not.toContain(code.code)
  expect(detail).not.toContain(own.token!)
})

it('does not report instances of another user through the summary', async () => {
  const plan = await definition('只读套餐')
  await grant(other.id, plan.id, Date.now() + 10 * DAY)
  const response = await me('/overview', member.cookie)
  expect(await response.json()).toMatchObject({ plans: { total: 0, accessStatus: 'none' } })
  expect((await me('/plans', member.cookie)).status).toBe(200)
})

it('switches the unified subscription summary to the plan model once the user owns an instance', async () => {
  const plan = await definition('订阅套餐')
  const row = await grant(member.id, plan.id, Date.now() + 20 * DAY)
  const { markModuleReady } = await import('../../../worker/db/module-switch')
  await Promise.all([markModuleReady(db, 'unified_subscription_ready'), markModuleReady(db, 'unified_subscription_public_ready')])
  const response = await call('/api/user/subscription', member.cookie, undefined, 'GET')
  expect(response.status).toBe(200)
  const body = await response.json<{
    source: string; status: string; expiresAt: string; permanent: boolean; nodeCount: number
    hasAvailableNodes: boolean; packages: Array<{ instanceId: string; name: string; bucket: string; nodeCount: number }>
  }>()
  expect(body).toMatchObject({
    source: 'plans', status: 'active', permanent: false, nodeCount: 1, hasAvailableNodes: true,
    packages: [{ instanceId: row.instance.id, name: '订阅套餐', bucket: 'active', nodeCount: 1 }],
  })
  expect(Date.parse(body.expiresAt)).toBe(row.instance.expires_at)
  // The nodes endpoint follows the same source selection.
  const nodes = await call('/api/user/subscription/nodes', member.cookie, undefined, 'GET')
  expect(nodes.status).toBe(200)
  expect((await nodes.json<{ nodes: unknown[] }>()).nodes).toHaveLength(1)
})
