import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { readCatalog, writeCatalog } from '../../../worker/catalog/repository'
import { readDelivery } from '../../../worker/delivery/repository'
import { applyMigrations } from './d1'
import { enableD1Modules, createFixtureAccount, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const ROOT = '/api/admin/subscription-templates'
const SUBS = '/api/admin/subscriptions'
const CATALOG = '/api/admin/catalog'
const GIB = 1024 ** 3
const config = {
  duration: { value: 1, unit: 'month' },
  quotaBytes: 15 * GIB,
  resetPolicy: 'none',
  limits: { speedLimitMbps: 0 },
  groupIds: [] as string[],
  nodeIds: [] as string[],
}

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await env.DB.prepare("UPDATE entitlement_templates SET status = 'archived'").run()
  await enableD1Modules()
  await setupAdmin()
})

async function setup() {
  const admin = await login()
  const password = crypto.randomUUID()
  const userResponse = await createFixtureAccount('template-holder', password)
  expect(userResponse.status).toBe(201)
  const { user } = await userResponse.json<{ user: { id: string } }>()
  const cookie = await login('template-holder', password)
  const get = (path: string, session = admin) => exports.default.fetch(TEST_ORIGIN + path, withCookie(session))
  const mutate = (path: string, body: object, method = 'POST', key?: string) =>
    exports.default.fetch(TEST_ORIGIN + path, jsonRequest(body, withCookie(admin, {
      method, headers: key ? { 'Idempotency-Key': key } : undefined,
    })))
  const ss = (name: string) => `ss://${btoa(`aes-128-gcm:${crypto.randomUUID()}`)}@${name}.example.test:8388#${name}`
  const source = await mutate(`${CATALOG}/sources`, { type: 'manual', name: 'Catalog fixture', content: [ss('Alpha'), ss('Beta'), ss('Gamma')].join('\n') })
  expect(source.status).toBe(201)
  const snapshot = await readCatalog(env)
  const nodes = ['Alpha', 'Beta', 'Gamma'].map((name) => snapshot.nodes.find((node) => node.displayName === name)!)
  const groupInput = (includedNodeIds: string[]) => ({ name: 'Dynamic group', sourceIds: [], includedNodeIds, excludedNodeIds: [], nodeOrder: includedNodeIds })
  const group = await mutate(`${CATALOG}/groups`, groupInput([nodes[0].id]))
  expect(group.status).toBe(201)
  const { group: { id: groupId } } = await group.json<{ group: { id: string } }>()
  return { get, mutate, userId: user.id, cookie, groupId, groupInput, nodes }
}

type Template = { id: string; description: string; allowRedemption: boolean; revision: number; subscriptionCount: number; currentVersion: { id: string; number: number; config: typeof config } }
type Created = { token: string; subscription: { id: string; expiresAt: number; groupIds: string[]; nodeIds: string[]; trafficGb: number; templateVersionId: string; revision: number } }
const templateData = (response: Response) => response.json<{ template: Template }>().then((value) => value.template)
const failStatus = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
}

it('versions issuance configurations, keeps original subscription snapshots and preserves replay across status changes', async () => {
  const { get, mutate, userId, cookie, groupId } = await setup()
  expect((await get(ROOT, cookie)).status).toBe(403)
  const created = await mutate(ROOT, { name: 'Standard', description: 'Initial', allowRedemption: true, config: { ...config, groupIds: [groupId] } })
  expect(created.status).toBe(201)
  const template = await templateData(created)
  const path = `${ROOT}/${template.id}`
  const request = { mode: 'template', userId, templateVersionId: template.currentVersion.id, trafficGb: 12.5 }
  const key = crypto.randomUUID()
  const responses = await Promise.all([mutate(SUBS, request, 'POST', key), mutate(SUBS, request, 'POST', key)])
  expect(responses.map((response) => response.status)).toEqual([201, 201])
  const [first, replay] = await Promise.all(responses.map((response) => response.json<Created>()))
  expect(first.subscription.id).toBe(replay.subscription.id)
  expect(first.subscription).toMatchObject({ sourceType: 'template', trafficGb: 12.5, templateVersionId: template.currentVersion.id })
  expect(replay.token).toEqual(first.token)
  const [notes, stale] = await Promise.all([
    mutate(path, { expectedRevision: template.revision, description: 'Updated' }, 'PATCH'),
    mutate(path, { expectedRevision: template.revision, description: 'Concurrent' }, 'PATCH'),
  ])
  expect([notes.status, stale.status].sort()).toEqual([200, 409])
  const changedMetadata = await templateData(notes.ok ? notes : stale)
  expect(changedMetadata).toMatchObject({ allowRedemption: true, currentVersion: { id: template.currentVersion.id, number: 1 } })
  const change = await mutate(path, { expectedRevision: changedMetadata.revision, config: {
    ...config, groupIds: [groupId], duration: { value: 2, unit: 'week' }, quotaBytes: 22 * GIB,
  } }, 'PATCH')
  expect(change.status).toBe(200)
  const latest = await templateData(change)
  expect(latest.currentVersion.number).toBe(2)
  await failStatus(await mutate(SUBS, request), 409, 'ENTITLEMENT_VERSION_UNAVAILABLE')
  const secondResponse = await mutate(SUBS, { mode: 'template', userId, templateVersionId: latest.currentVersion.id })
  expect(secondResponse.status).toBe(201)
  const { subscription: second } = await secondResponse.json<Created>()
  expect(second).toMatchObject({ trafficGb: 22, templateVersionId: latest.currentVersion.id })
  const { subscription: firstAgain } = await (await get(`${SUBS}/${first.subscription.id}`)).json<Created>()
  expect(firstAgain).toMatchObject({ trafficGb: 12.5, expiresAt: first.subscription.expiresAt, groupIds: [groupId], templateVersionId: template.currentVersion.id })
  const { versions } = await (await get(`${path}/versions`)).json<{ versions: { number: number; subscriptionCount: number }[] }>()
  expect(versions).toMatchObject([{ number: 2, subscriptionCount: 1 }, { number: 1, subscriptionCount: 1 }])
  expect((await templateData(await get(path))).subscriptionCount).toBe(2)
  await expect(env.DB.prepare('UPDATE entitlement_template_versions SET version_no = 9 WHERE id = ?').bind(latest.currentVersion.id).run())
    .rejects.toThrow('ENTITLEMENT_VERSION_IMMUTABLE')
  const disabled = await templateData(await mutate(path, { expectedRevision: latest.revision, status: 'disabled' }, 'PATCH'))
  await failStatus(await mutate(SUBS, { ...request, templateVersionId: latest.currentVersion.id }), 409, 'ENTITLEMENT_VERSION_UNAVAILABLE')
  const archived = await mutate(path, { expectedRevision: disabled.revision }, 'DELETE')
  expect(await templateData(archived)).toMatchObject({ status: 'archived', subscriptionCount: 2 })
  const copied = await mutate(`${path}/copy`, {})
  expect(copied.status).toBe(201)
  expect(await templateData(copied)).toMatchObject({ status: 'disabled', currentVersion: { number: 1, config: latest.currentVersion.config } })
  expect((await mutate(SUBS, request, 'POST', key)).status).toBe(201)
  expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${first.token}/mihomo`)).status).toBe(200)
})

it('updates mixed group output while retaining ordered explicit assignments and rejects unsafe group deletion', async () => {
  const { get, mutate, userId, cookie, groupId, groupInput, nodes: [alpha, beta, gamma] } = await setup()
  const template = await templateData(await mutate(ROOT, { name: 'Mixed', config: {
    ...config, groupIds: [groupId], nodeIds: [alpha.id, beta.id],
  } }))
  const issued = await mutate(SUBS, { mode: 'template', userId, templateVersionId: template.currentVersion.id })
  expect(issued.status).toBe(201)
  const mixed = await issued.json<Created>()
  const snapshotResponse = await mutate(SUBS, { mode: 'manual', userId, name: 'Snapshot', groupIds: [], nodeIds: [alpha.id, beta.id] })
  expect(snapshotResponse.status).toBe(201)
  const direct = await snapshotResponse.json<Created>()
  const output = async (token: string) => {
    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    expect(response.status).toBe(200)
    const body = await response.text()
    return [...body.matchAll(/^  - name: (Alpha|Beta|Gamma)$/gm)].map((match) => match[1])
  }
  expect(await output(mixed.token)).toEqual(['Alpha', 'Beta'])
  expect(await output(direct.token)).toEqual(['Alpha', 'Beta'])
  expect((await mutate(`${CATALOG}/groups/${groupId}`, groupInput([gamma.id, beta.id]), 'PUT')).status).toBe(200)
  expect(await output(mixed.token)).toEqual(['Gamma', 'Beta', 'Alpha'])
  expect(await output(direct.token)).toEqual(['Alpha', 'Beta'])
  const { nodes: visible } = await (await get('/api/user/nodes', cookie)).json<{ nodes: { id: string; subscriptions: { id: string }[] }[] }>()
  expect(visible.find((node) => node.id === alpha.id)?.subscriptions.map((ref) => ref.id)).toEqual(expect.arrayContaining([mixed.subscription.id, direct.subscription.id]))

  for (const module of ['delivery', 'catalog']) {
    await failStatus(await mutate('/api/admin/migration/run', { module }), 409, 'MIGRATION_VERIFY_FAILED')
  }
  const state = (await readDelivery(env)).subscriptions.find(({ id }) => id === mixed.subscription.id)
  expect(state).toMatchObject({ revision: mixed.subscription.revision, expiresAt: mixed.subscription.expiresAt, trafficGb: 15 })
  const removeGroup = () => mutate(`${CATALOG}/groups/${groupId}`, {}, 'DELETE')
  const groupError = await removeGroup()
  expect(groupError.status).toBe(409)
  expect(await groupError.json()).toMatchObject({ error: { code: 'GROUP_IN_USE', details: { subscriptions: 1, templates: 1 } } })
  expect((await mutate(`${SUBS}/${mixed.subscription.id}`, { groupIds: [], enabled: false }, 'PATCH')).status).toBe(200)
  expect((await removeGroup()).status).toBe(409)
  expect((await mutate(`${ROOT}/${template.id}`, { expectedRevision: template.revision }, 'DELETE')).status).toBe(200)
  expect((await removeGroup()).status).toBe(204)
  expect((await mutate(`${CATALOG}/nodes/${beta.id}`, { enabled: false }, 'PATCH')).status).toBe(200)
  await failStatus(await mutate(SUBS, { mode: 'manual', userId, name: 'Rejected node', groupIds: [], nodeIds: [beta.id] }), 422, 'SUBSCRIPTION_NODE_UNAVAILABLE')
  expect(await output(direct.token)).toEqual(['Alpha'])
  const patched = await mutate(`${SUBS}/${direct.subscription.id}`, { nodeIds: [beta.id, alpha.id] }, 'PATCH')
  expect(patched.status).toBe(200)
  const catalog = await readCatalog(env)
  await writeCatalog(env, { ...catalog, nodes: catalog.nodes.filter((node) => node.id !== alpha.id) })
  expect((await readDelivery(env)).subscriptions.find(({ id }) => id === direct.subscription.id)?.nodeIds).toEqual([beta.id])
  expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${direct.token}/mihomo`)).status).toBe(422)
})
