import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { catalogSnapshotSchema, type CatalogSnapshot, type Node } from '../../../worker/catalog/schema'
import { collectUserNodes, type UserNodeSubscription } from '../../../worker/delivery/user-nodes'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const NOW = '2026-06-01T00:00:00.000Z'
const NOW_MS = Date.parse(NOW)

type UserNode = {
  id: string
  name: string
  protocol: string | null
  groups: Array<{ id: string, name: string }>
  subscriptions: Array<{ id: string, name: string }>
}

const ssLine = (name: string, host: string) =>
  `ss://${btoa('aes-128-gcm:password')}@${host}:8388#${encodeURIComponent(name)}`

function names(nodes: UserNode[]): string[] {
  return nodes.map((node) => node.name)
}

function refNames(items: Array<{ name: string }>): string[] {
  return items.map((item) => item.name).sort()
}

function expectWhitelist(nodes: UserNode[]): void {
  for (const node of nodes) {
    expect(Object.keys(node).sort()).toEqual(['groups', 'id', 'name', 'protocol', 'subscriptions'])
    for (const ref of [...node.groups, ...node.subscriptions]) expect(Object.keys(ref).sort()).toEqual(['id', 'name'])
    expect(node).not.toHaveProperty('server')
    expect(node).not.toHaveProperty('port')
    expect(node).not.toHaveProperty('displayName')
    expect(node).not.toHaveProperty('credentials')
    expect(node).not.toHaveProperty('sourceIds')
    expect(node).not.toHaveProperty('links')
  }
}

async function provisionUser(adminCookie: string, username: string, password: string): Promise<{ id: string, cookie: string }> {
  const invite = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/invites`,
    jsonRequest({ username }, withCookie(adminCookie)),
  )
  expect(invite.status).toBe(201)
  const link = (await invite.json() as { invite: { link: string } }).invite.link
  const token = new URL(link).pathname.split('/').at(-1) ?? ''
  const redeemed = await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`, jsonRequest({ password }))
  expect(redeemed.status).toBe(201)
  const users = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(adminCookie))).json() as {
    users: Array<{ id: string, username: string }>
  }
  const user = users.users.find((item) => item.username === username)
  if (!user) throw new Error(`missing user ${username}`)
  return { id: user.id, cookie: await login(username, password) }
}

async function importSource(adminCookie: string, name: string, lines: string[]): Promise<{ sourceId: string, nodes: Array<{ id: string, displayName: string }> }> {
  const created = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/sources`,
    jsonRequest({ type: 'manual', name, content: lines.join('\n') }, withCookie(adminCookie)),
  )
  expect(created.status).toBe(201)
  const sourceId = (await created.json() as { source: { id: string } }).source.id
  const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(adminCookie))).json() as {
    nodes: Array<{ id: string, displayName: string, sourceIds: string[] }>
  }
  return { sourceId, nodes: catalog.nodes.filter((node) => node.sourceIds.includes(sourceId)) }
}

async function createGroup(adminCookie: string, name: string, sourceIds: string[], includedNodeIds: string[], nodeOrder: string[]): Promise<string> {
  const created = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/groups`,
    jsonRequest({ name, sourceIds, includedNodeIds, excludedNodeIds: [], nodeOrder }, withCookie(adminCookie)),
  )
  expect(created.status).toBe(201)
  return (await created.json() as { group: { id: string } }).group.id
}

async function createSubscription(adminCookie: string, userId: string, name: string, groupIds: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const created = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/subscriptions`,
    jsonRequest({ userId, name, groupIds, defaultClient: 'mihomo', ...extra }, withCookie(adminCookie)),
  )
  expect(created.status).toBe(201)
  return (await created.json() as { subscription: { id: string } }).subscription.id
}

async function listNodes(cookie: string): Promise<UserNode[]> {
  const response = await exports.default.fetch(`${TEST_ORIGIN}/api/user/nodes`, withCookie(cookie))
  expect(response.status).toBe(200)
  const body = await response.json() as { nodes: UserNode[] }
  expect(Object.keys(body)).toEqual(['nodes'])
  expectWhitelist(body.nodes)
  return body.nodes
}

function fixtureNode(id: `node_${number}`, sourceId: `src_${number}`, order: number): Node {
  return {
    id,
    protocol: 'shadowsocks',
    displayName: id === 'node_1' ? '公开节点' : '关闭分组节点',
    server: `${id}.example.com`,
    port: 8388,
    credentials: { method: 'aes-128-gcm', password: 'secret-password' },
    extensions: {},
    fingerprint: `fp-${id}`,
    sourceIds: [sourceId],
    rawVariants: [{ sourceId, format: 'uri-list', raw: id, extensions: {} }],
    enabled: true,
    retained: false,
    order,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function fixtureCatalog(): CatalogSnapshot {
  return catalogSnapshotSchema.parse({
    schemaVersion: 2,
    revision: 1,
    updatedAt: NOW,
    nextSourceId: 3,
    nextNodeId: 3,
    nextGroupId: 3,
    sources: [
      { id: 'src_1', name: 'Open source', type: 'manual', enabled: true, warnings: [], createdAt: NOW, updatedAt: NOW },
      { id: 'src_2', name: 'Closed source', type: 'manual', enabled: true, warnings: [], createdAt: NOW, updatedAt: NOW },
    ],
    nodes: [fixtureNode('node_1', 'src_1', 1), fixtureNode('node_2', 'src_2', 2)],
    groups: [
      { id: 'grp_1', name: '启用分组', sourceIds: ['src_1'], includedNodeIds: [], excludedNodeIds: [], nodeOrder: ['node_1'], createdAt: NOW, updatedAt: NOW },
      { id: 'grp_2', name: '停用分组', sourceIds: ['src_2'], includedNodeIds: [], excludedNodeIds: [], nodeOrder: ['node_2'], createdAt: NOW, updatedAt: NOW },
    ],
  })
}

function subscription(overrides: Partial<UserNodeSubscription> = {}): UserNodeSubscription {
  return {
    id: 'sub_1',
    userId: 'usr_2',
    name: '自己的订阅',
    groupIds: ['grp_1', 'grp_2', 'grp_404'],
    enabled: true,
    startsAt: null,
    expiresAt: null,
    createdAt: NOW,
    ...overrides,
  }
}

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

describe('GET /api/user/nodes', () => {
  it('requires a signed-in user', async () => {
    const response = await exports.default.fetch(`${TEST_ORIGIN}/api/user/nodes`)
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message.endsWith('。')).toBe(false)
    expect(body.error.message.endsWith('.')).toBe(false)
  })

  it('returns only the signed-in user subscription nodes', async () => {
    const admin = await login()
    const alice = await provisionUser(admin, 'alice', 'alice user password')
    const bob = await provisionUser(admin, 'bob', 'bob user password')
    const shared = await importSource(admin, 'Shared source', [ssLine('共用节点', 'shared.example')])
    const privateSource = await importSource(admin, 'Bob source', [ssLine('鲍勃专属', 'bob.example')])
    const sharedGroup = await createGroup(admin, '共用分组', [shared.sourceId], [], shared.nodes.map((node) => node.id))
    const privateGroup = await createGroup(admin, '鲍勃分组', [privateSource.sourceId], [], privateSource.nodes.map((node) => node.id))
    await createSubscription(admin, alice.id, '爱丽丝订阅', [sharedGroup])
    await createSubscription(admin, bob.id, '鲍勃订阅', [sharedGroup, privateGroup])

    const aliceNodes = await listNodes(alice.cookie)
    const bobNodes = await listNodes(bob.cookie)
    const adminNodes = await listNodes(admin)

    expect(names(aliceNodes)).toEqual(['共用节点'])
    expect(aliceNodes[0]?.protocol).toBe('shadowsocks')
    expect(refNames(aliceNodes[0]?.subscriptions ?? [])).toEqual(['爱丽丝订阅'])
    expect(refNames(aliceNodes[0]?.groups ?? [])).toEqual(['共用分组'])
    expect(JSON.stringify(aliceNodes)).not.toContain('鲍勃订阅')
    expect(JSON.stringify(aliceNodes)).not.toContain('鲍勃专属')
    expect(JSON.stringify(aliceNodes)).not.toContain('bob.example')
    expect(JSON.stringify(aliceNodes)).not.toContain('shared.example')
    expect(JSON.stringify(aliceNodes)).not.toContain('password')
    expect(names(bobNodes).sort()).toEqual(['鲍勃专属', '共用节点'].sort())
    expect(adminNodes).toEqual([])
  })

  it('excludes disabled subscriptions, disabled nodes, and a group whose source is disabled', async () => {
    const admin = await login()
    const user = await provisionUser(admin, 'node-user', 'node user password')
    const live = await importSource(admin, 'Live source', [ssLine('保留节点', 'keep.example'), ssLine('停用节点', 'hide.example')])
    const off = await importSource(admin, 'Off source', [ssLine('停用订阅节点', 'off.example')])
    const quiet = await importSource(admin, 'Quiet source', [ssLine('停用来源节点', 'quiet.example')])
    const liveGroup = await createGroup(admin, '启用分组', [live.sourceId], [], live.nodes.map((node) => node.id))
    const offGroup = await createGroup(admin, '停用订阅分组', [off.sourceId], [], off.nodes.map((node) => node.id))
    const quietGroup = await createGroup(admin, '停用来源分组', [quiet.sourceId], [], quiet.nodes.map((node) => node.id))
    await createSubscription(admin, user.id, '有效订阅', [liveGroup])
    await createSubscription(admin, user.id, '停用订阅', [offGroup], { enabled: false })
    await createSubscription(admin, user.id, '来源停用订阅', [quietGroup])
    const hidden = live.nodes.find((node) => node.displayName === '停用节点')
    expect(hidden).toBeTruthy()
    const disabledNode = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/nodes/${hidden!.id}`,
      jsonRequest({ enabled: false }, withCookie(admin, { method: 'PATCH' })),
    )
    expect(disabledNode.status).toBe(200)
    const disabledSource = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${quiet.sourceId}`,
      jsonRequest({ enabled: false }, withCookie(admin, { method: 'PUT' })),
    )
    expect(disabledSource.status).toBe(200)

    const nodes = await listNodes(user.cookie)
    expect(names(nodes)).toEqual(['保留节点'])
    expect(JSON.stringify(nodes)).not.toContain('停用节点')
    expect(JSON.stringify(nodes)).not.toContain('停用订阅节点')
    expect(JSON.stringify(nodes)).not.toContain('停用来源节点')
    expect(JSON.stringify(nodes)).not.toContain('hide.example')
    expect(JSON.stringify(nodes)).not.toContain('quiet.example')
  })

  it('excludes expired and not-yet-started subscriptions', async () => {
    const admin = await login()
    const user = await provisionUser(admin, 'expiry-user', 'expiry user password')
    const live = await importSource(admin, 'Live source', [ssLine('留存节点', 'stay.example')])
    const expired = await importSource(admin, 'Expired source', [ssLine('过期节点', 'expired.example')])
    const pending = await importSource(admin, 'Pending source', [ssLine('未生效节点', 'pending.example')])
    const liveGroup = await createGroup(admin, '有效分组', [live.sourceId], [], live.nodes.map((node) => node.id))
    const expiredGroup = await createGroup(admin, '过期分组', [expired.sourceId], [], expired.nodes.map((node) => node.id))
    const pendingGroup = await createGroup(admin, '未生效分组', [pending.sourceId], [], pending.nodes.map((node) => node.id))
    await createSubscription(admin, user.id, '有效订阅', [liveGroup])
    await createSubscription(admin, user.id, '过期订阅', [expiredGroup, liveGroup], { expiresAt: Date.now() - 120_000 })
    await createSubscription(admin, user.id, '未生效订阅', [pendingGroup], { startsAt: Date.now() + 3_600_000 })

    const nodes = await listNodes(user.cookie)
    expect(names(nodes)).toEqual(['留存节点'])
    expect(refNames(nodes[0]?.subscriptions ?? [])).toEqual(['有效订阅'])
    expect(JSON.stringify(nodes)).not.toContain('过期订阅')
    expect(JSON.stringify(nodes)).not.toContain('未生效订阅')
    expect(JSON.stringify(nodes)).not.toContain('过期节点')
    expect(JSON.stringify(nodes)).not.toContain('expired.example')
  })

  it('deduplicates a node shared by subscriptions and merges every affiliation', async () => {
    const admin = await login()
    const user = await provisionUser(admin, 'merge-user', 'merge user password')
    const east = await importSource(admin, 'East source', [ssLine('共用节点', 'shared-a.example'), ssLine('东部节点', 'east.example')])
    const shared = east.nodes.find((node) => node.displayName === '共用节点')
    const eastOnly = east.nodes.find((node) => node.displayName === '东部节点')
    expect(shared && eastOnly).toBeTruthy()
    const eastGroup = await createGroup(admin, '东部分组', [east.sourceId], [], [eastOnly!.id, shared!.id])
    const bothGroup = await createGroup(admin, '汇合分组', [], [shared!.id], [shared!.id])
    await createSubscription(admin, user.id, '东线订阅', [eastGroup, bothGroup])
    await createSubscription(admin, user.id, '汇合订阅', [bothGroup])

    const nodes = await listNodes(user.cookie)
    expect(names(nodes)).toEqual(['东部节点', '共用节点'])
    const eastNode = nodes.find((node) => node.name === '东部节点')
    const sharedNode = nodes.find((node) => node.name === '共用节点')
    expect(nodes.filter((node) => node.id === shared!.id)).toHaveLength(1)
    expect(refNames(eastNode?.groups ?? [])).toEqual(['东部分组'])
    expect(refNames(eastNode?.subscriptions ?? [])).toEqual(['东线订阅'])
    expect(refNames(sharedNode?.groups ?? [])).toEqual(['东部分组', '汇合分组'])
    expect(refNames(sharedNode?.subscriptions ?? [])).toEqual(['东线订阅', '汇合订阅'])
    expect(JSON.stringify(nodes)).not.toContain('shared-a.example')
    expect(JSON.stringify(nodes)).not.toContain('east.example')
  })

  it('skips a group with enabled false and a missing group id', () => {
    const catalog = fixtureCatalog()
    const closed = catalog.groups.find((group) => group.id === 'grp_2')
    expect(closed).toBeTruthy()
    Object.assign(closed!, { enabled: false })
    const nodes = collectUserNodes([
      subscription(),
      subscription({ id: 'sub_2', userId: 'usr_9', name: '别人的订阅', groupIds: ['grp_1'] }),
      subscription({ id: 'sub_3', name: '过期订阅', groupIds: ['grp_2'], expiresAt: NOW_MS - 1000 }),
    ], catalog, 'usr_2', NOW_MS)

    expect(names(nodes)).toEqual(['公开节点'])
    expect(refNames(nodes[0]?.groups ?? [])).toEqual(['启用分组'])
    expect(refNames(nodes[0]?.subscriptions ?? [])).toEqual(['自己的订阅'])
    expect(JSON.stringify(nodes)).not.toContain('关闭分组节点')
    expect(JSON.stringify(nodes)).not.toContain('停用分组')
    expect(JSON.stringify(nodes)).not.toContain('别人的订阅')
    expect(JSON.stringify(nodes)).not.toContain('过期订阅')
    expect(JSON.stringify(nodes)).not.toContain('secret-password')
    expect(JSON.stringify(nodes)).not.toContain('node_1.example.com')
  })
})
