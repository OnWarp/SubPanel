import { readCatalog } from '../../../worker/catalog/repository'
import { app } from '../../../worker/app'
import schema from '../../../migrations/0031_plan_schema.sql?raw'
import schemaDown from '../../../migrations/down/0031_plan_schema.down.sql?raw'
import groups from '../../../migrations/0032_group_metadata.sql?raw'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { splitSqlStatements } from './d1'
import { createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

const db = env.DB
const password = 'a synthetic test password'
let adminCookie: string
let member: { id: string; cookie: string }
let groupId: string

const run = (sql: string) => db.batch(splitSqlStatements(sql).map((statement) => db.prepare(statement)))
const call = (path: string, cookie?: string, body?: unknown, method = 'POST') => {
  const init = body === undefined
    ? withCookie(cookie ?? '', { method, headers: { origin: TEST_ORIGIN } })
    : jsonRequest(body, withCookie(cookie ?? '', { method }))
  return app.fetch(new Request(TEST_ORIGIN + path, cookie ? init : { method, headers: { origin: TEST_ORIGIN } }), env)
}
const errorOf = async (response: Response) => {
  const body = await response.json<{ error: { code: string; message: string; details?: { plans?: Array<{ id: string; name: string; status: string }> } } }>()
  return { status: response.status, ...body.error }
}

beforeEach(async () => {
  await run(schemaDown)
  await setupContractedAdmin()
  await run(schema)
  const columns = await db.prepare('PRAGMA table_info(groups)').all<{ name: string }>()
  if (!columns.results.some((column) => column.name === 'enabled')) await run(groups)
  const created = await (await createFixtureAccount('member', password)).json<{ user: { id: string } }>()
  adminCookie = await login()
  member = { id: created.user.id, cookie: await login('member', password) }
  const credentials = btoa('aes-128-gcm:fixture')
  const source = await call('/api/admin/catalog/sources', adminCookie, {
    name: 'Fixture source', type: 'manual', content: `ss://${credentials}@one.test:8388#Same`,
  })
  expect(source.status).toBe(201)
  const catalog = await readCatalog(env)
  const nodeId = catalog.nodes[0]?.id
  const group = await call('/api/admin/catalog/groups', adminCookie, {
    name: '管理员节点组', sourceIds: [], includedNodeIds: nodeId ? [nodeId] : [], excludedNodeIds: [], nodeOrder: [],
  })
  expect(group.status).toBe(201)
  groupId = (await group.json<{ group: { id: string } }>()).group.id
})

it('rejects non-admins and keeps the legacy plan collection beside the definition contract', async () => {
  expect((await errorOf(await call('/api/admin/plans?limit=1', member.cookie, undefined, 'GET'))).code).toBe('ADMIN_REQUIRED')
  expect((await errorOf(await call('/api/admin/plans', member.cookie, {
    name: '拒绝', nodeGroupIds: [groupId], durationSeconds: 86400,
  }))).code).toBe('ADMIN_REQUIRED')
  expect((await errorOf(await call('/api/admin/redeem-codes', member.cookie, undefined, 'GET'))).code).toBe('ADMIN_REQUIRED')

  const legacy = await call('/api/admin/plans', adminCookie, { name: '旧计划', durationDays: 30, groupIds: [] })
  expect(legacy.status).toBe(201)
  const legacyPlan = (await legacy.json<{ plan: { id: string; durationDays: number } }>()).plan
  expect(legacyPlan.durationDays).toBe(30)

  const created = await call('/api/admin/plans', adminCookie, {
    name: '标准套餐', description: '说明', remark: '内部备注', nodeGroupIds: [groupId], durationSeconds: 7 * 86400, enabled: true,
  })
  expect(created.status).toBe(201)
  const plan = (await created.json<{ plan: { id: string; nodeCount: number; status: string; note: string; userCount: number; version: number } }>()).plan
  expect(plan).toMatchObject({ status: 'enabled', note: '内部备注', userCount: 0, version: 1 })
  expect(plan.nodeCount).toBeGreaterThanOrEqual(1)

  const unfiltered = await call('/api/admin/plans', adminCookie, undefined, 'GET')
  expect(unfiltered.status).toBe(200)
  const legacyList = await unfiltered.json<{ plans: Array<{ id: string; nodeGroupIds?: string[] }> }>()
  expect(legacyList.plans.map((item) => item.id)).toContain(legacyPlan.id)
  expect(legacyList.plans.map((item) => item.id)).not.toContain(plan.id)
  expect(legacyList.plans.every((item) => item.nodeGroupIds === undefined)).toBe(true)

  const listed = await call('/api/admin/plans?limit=20&search=内部备注', adminCookie, undefined, 'GET')
  expect(await listed.json()).toMatchObject({ plans: [{ id: plan.id, status: 'enabled', userCount: 0 }] })
  const hidden = await call('/api/admin/plans?limit=20&status=disabled', adminCookie, undefined, 'GET')
  expect((await hidden.json<{ plans: Array<{ id: string }> }>()).plans.map((item) => item.id)).not.toContain(plan.id)

  const preview = await call('/api/admin/plans/preview', adminCookie, { nodeGroupIds: [groupId] })
  expect(preview.status).toBe(200)
  expect(await preview.json()).toMatchObject({ nodeGroups: [{ id: groupId }], emptyGroupIds: [] })

  const missingGroup = await errorOf(await call('/api/admin/plans', adminCookie, {
    name: '缺组', nodeGroupIds: ['missing-group'], durationSeconds: 86400,
  }))
  expect(missingGroup).toMatchObject({ status: 400, code: 'GROUP_NOT_FOUND' })

  const untouched = await call(`/api/admin/plans/${plan.id}`, adminCookie, {}, 'DELETE')
  expect(untouched.status).toBe(404)
  expect((await call(`/api/admin/plans/${plan.id}`, adminCookie, undefined, 'GET')).status).toBe(200)

  const key = crypto.randomUUID()
  const assign = await call(`/api/admin/users/${member.id}/plans`, adminCookie, {
    planId: plan.id, durationMode: 'inherit', idempotencyKey: key,
  })
  expect(assign.status).toBe(201)
  const replay = await call(`/api/admin/users/${member.id}/plans`, adminCookie, {
    planId: plan.id, durationMode: 'inherit', idempotencyKey: key,
  })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ replayed: true, token: null })
  expect(await db.prepare('SELECT count(*) AS count FROM user_plans WHERE user_id=?').bind(member.id).first<number>('count')).toBe(1)

  const detail = await call(`/api/admin/plans/${plan.id}`, adminCookie, undefined, 'GET')
  expect(await detail.json()).toMatchObject({ plan: { userCount: 1, instanceCount: 1 } })
  const references = await call(`/api/admin/catalog/groups/${groupId}/plans`, adminCookie, undefined, 'GET')
  expect(await references.json()).toEqual({ plans: [{ id: plan.id, name: '标准套餐', status: 'enabled' }] })
  const blocked = await errorOf(await call(`/api/admin/catalog/groups/${groupId}`, adminCookie, undefined, 'DELETE'))
  expect(blocked.status).toBe(409)
  expect(blocked.code).toBe('GROUP_IN_USE')
  expect(blocked.message).toContain('标准套餐')
  expect(blocked.details?.plans).toEqual([{ id: plan.id, name: '标准套餐', status: 'enabled' }])
  expect((await call(`/api/admin/catalog/groups/${groupId}`, adminCookie, undefined, 'GET')).status).not.toBe(404)

  const archived = await call(`/api/admin/plans/${plan.id}`, adminCookie, { version: plan.version }, 'DELETE')
  expect(archived.status).toBe(204)
  const after = await call(`/api/admin/plans/${plan.id}`, adminCookie, undefined, 'GET')
  expect(await after.json()).toMatchObject({ plan: { status: 'archived' } })
})
