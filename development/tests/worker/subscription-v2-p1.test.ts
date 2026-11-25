import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { expiryFromDuration } from '../../../shared/subscription-duration'
import { createShare, exportShare, readShareMeta } from '../../../worker/shares/service'
import { bindFixtureTemplate, createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

beforeEach(setupContractedAdmin)

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

it('keeps the unified subscription private to its owner and administrators', async () => {
  const admin = await login()
  const alice = await owner('alice-p1')
  const bob = await owner('bob-p1')
  const groupId = await createGroup(admin)
  await bindFixtureTemplate(bob.id, { name: 'Bob binding', groupIds: [groupId] })
  const account = '/api/user/subscription'
  const bobAdmin = `/api/admin/users/${bob.id}/subscription/summary`
  expect((await fetchApi(account)).status).toBe(401)
  expect(await (await fetchApi(account, withCookie(bob.cookie))).json()).toMatchObject({ status: 'active', nodeCount: 1 })
  expect(await (await fetchApi(account, withCookie(alice.cookie))).json()).toMatchObject({ status: 'none', nodeCount: 0 })
  expect((await fetchApi(bobAdmin, withCookie(alice.cookie))).status).toBe(403)
  expect((await fetchApi(bobAdmin, withCookie(admin))).status).toBe(200)
})

it('uses UTC duration boundaries and rejects share exports at the exact subscription deadline', async () => {
  const leapDay = Date.parse('2028-02-29T22:15:00.000Z')
  expect(expiryFromDuration(leapDay, { value: 1, unit: 'year' })).toBe(Date.parse('2029-02-28T22:15:00.000Z'))
  expect(expiryFromDuration(Date.parse('2028-01-31T22:15:00.000Z'), { value: 1, unit: 'month' })).toBe(leapDay)
  expect(expiryFromDuration(Date.parse('2026-12-31T22:15:00.000Z'), { value: 1, unit: 'week' })).toBe(Date.parse('2027-01-07T22:15:00.000Z'))

  const admin = await login()
  const groupId = await createGroup(admin)
  const startsAt = Date.now()
  const deadline = startsAt + 86_400_000
  const template = await bindFixtureTemplate('usr_1', { name: 'Timed', groupIds: [groupId], startsAt, expiresAt: deadline })
  const { token } = await createShare(env, 'usr_1', { scope: { type: 'template', templateId: template.id } },
    new Date(startsAt), 'admin')
  await expect(exportShare(env, token, undefined, 'mihomo', null, null, TEST_ORIGIN, new Date(deadline - 1))).resolves.toMatchObject({ kind: 'client' })
  await expect(exportShare(env, token, undefined, 'mihomo', null, null, TEST_ORIGIN, new Date(deadline))).rejects.toMatchObject({ status: 404 })
  await expect(readShareMeta(env, token, null, null, new Date(deadline))).rejects.toMatchObject({ status: 404 })
})
