import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { readCatalog } from '../../../worker/catalog/repository'
import { bindFixtureTemplate, createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

const ROOT = '/api/admin/subscription-templates'
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

beforeEach(setupContractedAdmin)

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
const templateData = (response: Response) => response.json<{ template: Template }>().then((value) => value.template)
it('versions entitlement configurations and supports archive and copy', async () => {
  const { get, mutate, cookie, groupId } = await setup()
  expect((await get(ROOT, cookie)).status).toBe(403)
  const created = await mutate(ROOT, { name: 'Standard', description: 'Initial', allowRedemption: true, config: { ...config, groupIds: [groupId] } })
  expect(created.status).toBe(201)
  const template = await templateData(created)
  const path = `${ROOT}/${template.id}`
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
  const { versions } = await (await get(`${path}/versions`)).json<{ versions: { number: number }[] }>()
  expect(versions).toMatchObject([{ number: 2 }, { number: 1 }])
  await expect(env.DB.prepare('UPDATE entitlement_template_versions SET version_no = 9 WHERE id = ?').bind(latest.currentVersion.id).run())
    .rejects.toThrow('ENTITLEMENT_VERSION_IMMUTABLE')
  const disabled = await templateData(await mutate(path, { expectedRevision: latest.revision, status: 'disabled' }, 'PATCH'))
  const archived = await mutate(path, { expectedRevision: disabled.revision }, 'DELETE')
  expect(await templateData(archived)).toMatchObject({ status: 'archived' })
  const copied = await mutate(`${path}/copy`, {})
  expect(copied.status).toBe(201)
  expect(await templateData(copied)).toMatchObject({ status: 'disabled', currentVersion: { number: 1, config: latest.currentVersion.config } })
})

it('updates mixed group output while retaining ordered explicit assignments and rejects unsafe group deletion', async () => {
  const { get, mutate, userId, cookie, groupId, groupInput, nodes: [alpha, beta, gamma] } = await setup()
  const mixed = await bindFixtureTemplate(userId, { name: 'Mixed', groupIds: [groupId], nodeIds: [alpha.id, beta.id] })
  const direct = await bindFixtureTemplate(userId, { name: 'Explicit', nodeIds: [alpha.id, beta.id] })
  const output = async () => {
    const { nodes } = await (await get('/api/user/nodes', cookie)).json<{
      nodes: { id: string; subscriptions: { id: string }[] }[]
    }>()
    return nodes
  }
  expect((await output()).map(node => node.id)).toEqual([alpha.id, beta.id])
  expect((await mutate(`${CATALOG}/groups/${groupId}`, groupInput([gamma.id, beta.id]), 'PUT')).status).toBe(200)
  const visible = await output()
  expect(visible.map(node => node.id)).toEqual([alpha.id, beta.id, gamma.id])
  expect(visible.find(node => node.id === alpha.id)?.subscriptions.map(ref => ref.id)).toEqual(expect.arrayContaining([mixed.id, direct.id]))
  expect(visible.find(node => node.id === gamma.id)?.subscriptions.map(ref => ref.id)).toEqual([mixed.id])
  const removeGroup = () => mutate(`${CATALOG}/groups/${groupId}`, {}, 'DELETE')
  expect((await removeGroup()).status).toBe(409)
  const bindings = `/api/admin/users/${userId}/template-bindings`
  const { revision } = await (await get(bindings)).json<{ revision: number }>()
  const removed = await mutate(`${bindings}/${mixed.id}`, {
    requestId: crypto.randomUUID(), expectedRevision: revision,
  }, 'DELETE')
  expect(removed.status).toBe(200)
  expect((await mutate(`${ROOT}/${mixed.id}`, { expectedRevision: mixed.revision }, 'DELETE')).status).toBe(200)
  expect((await removeGroup()).status).toBe(204)
  expect((await mutate(`${CATALOG}/nodes/${beta.id}`, { enabled: false }, 'PATCH')).status).toBe(200)
  expect((await output()).map(node => node.id)).toEqual([alpha.id])
})
