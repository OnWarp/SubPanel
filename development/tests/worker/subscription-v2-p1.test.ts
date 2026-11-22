import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import migration from '../../../migrations/0021_subscription_v2_p1.sql?raw'
import { expiryFromDuration, subscriptionRowStatus } from '../../../worker/delivery/expiry'
import { getSubscription } from '../../../worker/delivery/service'
import { createShare, exportShare, readShareMeta } from '../../../worker/shares/service'
import { splitSqlStatements } from './d1'
import { createFixtureAccount, enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

const fetchApi = (path: string, init?: RequestInit) => exports.default.fetch(TEST_ORIGIN + path, init)

async function owner(name: string) {
  const password = crypto.randomUUID()
  const response = await createFixtureAccount(name, password)
  expect(response.status).toBe(201)
  const { user } = await response.json<{ user: { id: string } }>()
  return { id: user.id, cookie: await login(name, password) }
}

async function createGroup(admin: string) {
  const content = `ss://${btoa(`aes-128-gcm:${crypto.randomUUID()}`)}@compat.example.test:8388#Compat`
  const sourceResponse = await fetchApi('/api/admin/catalog/sources', jsonRequest({
    type: 'manual', name: 'Compatibility', content,
  }, withCookie(admin)))
  expect(sourceResponse.status).toBe(201)
  const { source } = await sourceResponse.json<{ source: { id: string } }>()
  const groupResponse = await fetchApi('/api/admin/catalog/groups', jsonRequest({
    name: 'Compatibility', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  }, withCookie(admin)))
  expect(groupResponse.status).toBe(201)
  return (await groupResponse.json<{ group: { id: string } }>()).group.id
}

type Creation = {
  subscription: { id: string; userId: string | null; expiresAt: number | null }
  token: string
}

it('deduplicates concurrent manual creates and scopes subscription detail and writes by owner', async () => {
  const admin = await login()
  const alice = await owner('alice-p1')
  const bob = await owner('bob-p1')
  const groupId = await createGroup(admin)
  const key = crypto.randomUUID()
  const input = { mode: 'manual', userId: bob.id, name: 'Independent', groupIds: [groupId], trafficGb: 12.5, speedLimitMbps: 25, deviceLimit: 3 }
  const create = (body: object, idempotencyKey: string) => fetchApi('/api/admin/subscriptions', jsonRequest(body,
    withCookie(admin, { headers: { 'Idempotency-Key': idempotencyKey } })))

  const responses = await Promise.all([create(input, key), create(input, key)])
  expect(responses.map(response => response.status)).toEqual([201, 201])
  const [first, second] = await Promise.all(responses.map(response => response.json<Creation>()))
  expect(second.subscription.id).toBe(first.subscription.id)
  expect(second.token).toBe(first.token)
  expect((await create({ ...input, trafficGb: 20 }, key)).status).toBe(409)
  expect((await create({ ...input, templateVersionId: 'unexpected' }, crypto.randomUUID())).status).toBe(422)
  expect((await create({ ...input, name: 'Another independent subscription' }, crypto.randomUUID())).status).toBe(201)

  const bobList = await (await fetchApi('/api/me/subscriptions', withCookie(bob.cookie))).json<{ subscriptions: unknown[] }>()
  expect(bobList.subscriptions).toHaveLength(2)
  const aliceList = await (await fetchApi('/api/me/subscriptions', withCookie(alice.cookie))).json<{ subscriptions: unknown[] }>()
  expect(aliceList.subscriptions).toHaveLength(0)
  const id = first.subscription.id
  const userPath = `/api/me/subscriptions/${id}`
  const adminPath = `/api/admin/subscriptions/${id}`
  expect((await fetchApi(userPath)).status).toBe(401)
  const other = await fetchApi(userPath, withCookie(alice.cookie))
  const missing = await fetchApi('/api/me/subscriptions/sub_999', withCookie(alice.cookie))
  expect(other.status).toBe(404)
  expect(await other.json()).toEqual(await missing.json())
  expect((await fetchApi(adminPath, withCookie(alice.cookie))).status).toBe(403)
  expect((await fetchApi(adminPath, jsonRequest({ enabled: false }, withCookie(alice.cookie, { method: 'PATCH' })))).status).toBe(403)
  expect((await fetchApi(`${userPath}/token/reset`, jsonRequest({}, withCookie(alice.cookie)))).status).toBe(403)
  for (const [path, session] of [[adminPath, admin], [userPath, bob.cookie]]) {
    const response = await fetchApi(path, withCookie(session))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ subscription: {
      id, userId: bob.id, planId: null, sourceType: 'manual', trafficGb: 12.5,
      speedLimitMbps: 25, deviceLimit: 3, authorizedGroupIds: [groupId], status: 'active',
    } })
  }
  const nodes = await (await fetchApi('/api/user/nodes', withCookie(bob.cookie))).json<{ nodes: Array<{ subscriptions: unknown[] }> }>()
  expect(nodes.nodes).toHaveLength(1)
  expect(nodes.nodes[0].subscriptions).toHaveLength(2)

  expect((await fetchApi(adminPath, withCookie(admin, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }))).status).toBe(204)
  expect((await create(input, key)).status).toBe(409)
})

it('keeps legacy links and all renderer variants stable when the migration is replayed', async () => {
  const admin = await login()
  const groupId = await createGroup(admin)
  const created = await fetchApi('/api/admin/subscriptions', jsonRequest({
    userId: 'usr_1', name: 'Historical configuration', groupIds: [groupId], trafficGb: 38,
    expiresAt: Date.now() + 86_400_000,
  }, withCookie(admin)))
  expect(created.status).toBe(201)
  const { subscription, token } = await created.json<Creation>()
  const id = subscription.id
  // No metadata row matches subscriptions created by the previous Worker.
  await env.DB.prepare('DELETE FROM subscription_creation WHERE subscription_id=?').bind(id).run()
  const baseline = await getSubscription(env, id)
  const variants = [
    '', '/mihomo', '/clash', '/clash-meta', '/stash', '/singbox', '/sing-box', '/karing', '/surge', '/loon',
    '/quantumultx', '/quantumult-x', '/v2rayn', '/v2rayng', '/nekobox', '/neko-box', '/shadowrocket', '/generic',
  ]
  const capture = () => Promise.all(variants.map(async variant => {
    const path = `/sub/${token}${variant}`
    const response = await fetchApi(path)
    const status = response.status
    expect(status).toBe(200)
    const etag = response.headers.get('etag')
    expect(etag).toBeTruthy()
    const conditional = await fetchApi(path, { headers: { 'If-None-Match': etag! } })
    expect(conditional.status).toBe(304)
    return [status, etag, response.headers.get('content-type'), response.headers.get('content-disposition'), await response.text()]
  }))
  const before = await capture()
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const sql of splitSqlStatements(migration)) await env.DB.prepare(sql).run()
    expect(await getSubscription(env, id)).toEqual(baseline)
    expect(await capture()).toEqual(before)
  }
  const detail = await fetchApi(`/api/admin/subscriptions/${id}`, withCookie(admin))
  expect(await detail.json()).toMatchObject({ subscription: { sourceType: 'legacy', trafficGb: 38, userId: 'usr_1' } })
})

it('uses UTC duration boundaries and rejects share exports at the exact subscription deadline', async () => {
  const leapDay = Date.parse('2028-02-29T22:15:00.000Z')
  expect(expiryFromDuration(leapDay, { value: 1, unit: 'year' })).toBe(Date.parse('2029-02-28T22:15:00.000Z'))
  expect(expiryFromDuration(Date.parse('2028-01-31T22:15:00.000Z'), { value: 1, unit: 'month' })).toBe(leapDay)
  expect(expiryFromDuration(Date.parse('2026-12-31T22:15:00.000Z'), { value: 1, unit: 'week' })).toBe(Date.parse('2027-01-07T22:15:00.000Z'))

  const admin = await login()
  const groupId = await createGroup(admin)
  const startsAt = Date.now()
  const created = await fetchApi('/api/admin/subscriptions', jsonRequest({
    userId: 'usr_1', name: 'Timed', groupIds: [groupId], startsAt, duration: { value: 1, unit: 'day' },
  }, withCookie(admin)))
  expect(created.status).toBe(201)
  const { subscription } = await created.json<Creation>()
  const deadline = startsAt + 86_400_000
  expect(subscription.expiresAt).toBe(deadline)
  const stored = await getSubscription(env, subscription.id)
  expect(subscriptionRowStatus(stored, deadline - 1)).toBeNull()
  expect(subscriptionRowStatus(stored, deadline)).toBe('expired')
  const { token } = await createShare(env, 'usr_1', { subscriptionId: stored.id, allowOriginalLink: true },
    new Date(startsAt), 'admin')
  await expect(exportShare(env, token, undefined, 'mihomo', null, null, TEST_ORIGIN, new Date(deadline - 1))).resolves.toMatchObject({ kind: 'client' })
  await expect(exportShare(env, token, undefined, 'mihomo', null, null, TEST_ORIGIN, new Date(deadline))).rejects.toMatchObject({ status: 410, code: 'SUB_EXPIRED' })
  await expect(exportShare(env, token, 'link', undefined, null, null, TEST_ORIGIN, new Date(deadline))).rejects.toMatchObject({ status: 410, code: 'SUB_EXPIRED' })
  await expect(readShareMeta(env, token, null, null, new Date(deadline))).rejects.toMatchObject({ status: 404 })
})
