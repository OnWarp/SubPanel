import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCatalog } from '../../../worker/catalog/repository'
import { decryptText, readCryptoMaterial } from '../../../worker/platform/crypto'
import {
  jsonRequest,
  login,
  resetData,
  setupAdmin,
  TEST_ORIGIN,
  withCookie,
} from './helpers'

const ssLine = (name: string, password = 'password', host = 'ss.example.com') =>
  `ss://${btoa(`aes-128-gcm:${password}`)}@${host}:8388#${encodeURIComponent(name)}`

async function createUserCookie(adminCookie: string): Promise<string> {
  const inviteResponse = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/invites`,
    jsonRequest({ username: 'catalog-user' }, withCookie(adminCookie)),
  )
  const link = (await inviteResponse.json() as { invite: { link: string } }).invite.link
  const token = new URL(link).pathname.split('/').at(-1)!
  await exports.default.fetch(
    `${TEST_ORIGIN}/api/invites/${token}`,
    jsonRequest({ password: 'catalog user password' }),
  )
  return login('catalog-user', 'catalog user password')
}

beforeEach(async () => {
  await resetData()
  await setupAdmin()
})

afterEach(() => vi.unstubAllGlobals())

describe('administrator Catalog APIs', () => {
  it('requires an administrator for every Catalog endpoint', async () => {
    const cases = [
      ['GET', '/api/admin/catalog'],
      ['POST', '/api/admin/catalog/preview'],
      ['POST', '/api/admin/catalog/sources'],
      ['PUT', '/api/admin/catalog/sources/src_1'],
      ['DELETE', '/api/admin/catalog/sources/src_1'],
      ['POST', '/api/admin/catalog/sources/src_1/refresh'],
      ['PATCH', '/api/admin/catalog/nodes/node_1'],
      ['POST', '/api/admin/catalog/groups'],
      ['PUT', '/api/admin/catalog/groups/grp_1'],
      ['DELETE', '/api/admin/catalog/groups/grp_1'],
    ] as const
    for (const [method, path] of cases) {
      const init = method === 'GET' ? { method } : jsonRequest({}, { method })
      expect((await exports.default.fetch(`${TEST_ORIGIN}${path}`, init)).status).toBe(401)
    }

    const adminCookie = await login()
    const userCookie = await createUserCookie(adminCookie)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(userCookie))).status).toBe(403)
  })

  it('previews content without writing KV', async () => {
    const cookie = await login()
    const content = `ss://${btoa('aes-128-gcm:password')}@ss.example.com:8388/?plugin=obfs-local%3Bobfs-password%3Dplugin-secret#Preview`
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/preview`,
      jsonRequest({ content }, withCookie(cookie)),
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { format: string; nodes: Array<Record<string, unknown>> }
    expect(JSON.stringify(body)).not.toContain('plugin-secret')
    expect(body.format).toBe('uri-list')
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]).not.toHaveProperty('credentials')
    expect(body.nodes[0]).not.toHaveProperty('raw')
    expect(body.nodes[0]).not.toHaveProperty('plugin')
    expect(await env.DATA.get('state:catalog')).toBeNull()
  })

  it('creates manual and remote sources without returning secrets', async () => {
    const cookie = await login()
    const manual = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'Manual', content: ssLine('Manual') }, withCookie(cookie)),
    )
    expect(manual.status).toBe(201)

    vi.stubGlobal('fetch', async () => new Response(ssLine('Remote')))
    const remoteUrl = 'https://feed.example.com/source?token=url-secret'
    const remote = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({
        type: 'remote',
        name: 'Remote',
        url: remoteUrl,
        headers: { Authorization: 'header-secret' },
        refreshIntervalMinutes: 15,
      }, withCookie(cookie)),
    )
    expect(remote.status).toBe(201)
    const responseText = await remote.text()
    expect(responseText).not.toContain(remoteUrl)
    expect(responseText).not.toContain('url-secret')
    expect(responseText).not.toContain('header-secret')
    expect(responseText).not.toContain('encryptedUrl')

    const catalog = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))
    const catalogText = await catalog.text()
    expect(catalogText).not.toContain('password')
    expect(catalogText).not.toContain('rawVariants')
    expect(JSON.parse(catalogText).sources).toHaveLength(2)
  })

  it('updates remote URL, headers, and refresh interval without exposing secrets', async () => {
    const cookie = await login()
    vi.stubGlobal('fetch', async () => new Response(ssLine('Remote')))
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({
        type: 'remote',
        name: 'Remote',
        url: 'https://old-feed.example.com/source',
        headers: { Authorization: 'old-secret' },
        refreshIntervalMinutes: 15,
      }, withCookie(cookie)),
    )
    const sourceId = (await created.json() as { source: { id: string } }).source.id
    const url = 'https://new-feed.example.net/source?token=url-secret'
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${sourceId}`,
      jsonRequest({ url, headers: { Authorization: 'header-secret' }, refreshIntervalMinutes: 30 }, { ...withCookie(cookie), method: 'PUT' }),
    )
    expect(response.status).toBe(200)
    const responseText = await response.text()
    expect(responseText).not.toContain(url)
    expect(responseText).not.toContain('url-secret')
    expect(responseText).not.toContain('header-secret')
    expect(JSON.parse(responseText).source.refreshIntervalMinutes).toBe(30)

    const source = (await readCatalog(env.DATA)).sources.find(({ id }) => id === sourceId)!
    const material = await readCryptoMaterial(env.DATA)
    await expect(decryptText(source.encryptedUrl!, material.encryptionKey)).resolves.toBe(url)
    await expect(decryptText(source.encryptedHeaders!, material.encryptionKey)).resolves.toBe(JSON.stringify({ Authorization: 'header-secret' }))
  })

  it('refreshes and deletes a source with deterministic associations', async () => {
    const cookie = await login()
    const shared = ssLine('Shared')
    const orphan = ssLine('Orphan', 'orphan-password', 'orphan.example.com')
    const first = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'First', content: `${shared}\n${orphan}` }, withCookie(cookie)),
    )
    const firstId = (await first.json() as { source: { id: string } }).source.id
    const second = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'file', name: 'Second', content: shared }, withCookie(cookie)),
    )
    const secondId = (await second.json() as { source: { id: string } }).source.id

    const replaced = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${firstId}`,
      jsonRequest({ content: shared }, { ...withCookie(cookie), method: 'PUT' }),
    )
    expect(replaced.status).toBe(200)
    let catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ sourceIds: string[] }> }
    expect(catalog.nodes).toHaveLength(1)
    expect(catalog.nodes[0].sourceIds).toEqual([firstId, secondId])

    expect((await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${firstId}`,
      jsonRequest({}, { ...withCookie(cookie), method: 'DELETE' }),
    )).status).toBe(204)
    catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ sourceIds: string[] }> }
    expect(catalog.nodes[0].sourceIds).toEqual([secondId])

    expect((await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${secondId}`,
      jsonRequest({}, { ...withCookie(cookie), method: 'DELETE' }),
    )).status).toBe(204)
    catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ sourceIds: string[] }> }
    expect(catalog.nodes).toEqual([])
  })

  it('updates node name, enabled, retained, and order fields', async () => {
    const cookie = await login()
    await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'Nodes', content: ssLine('Before') }, withCookie(cookie)),
    )
    const before = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ id: string }> }
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/nodes/${before.nodes[0].id}`,
      jsonRequest({ displayName: 'After', enabled: false, retained: true, order: 9 }, { ...withCookie(cookie), method: 'PATCH' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ node: { displayName: 'After', enabled: false, retained: true, order: 9 } })
  })

  it('keeps a successful Catalog mutation when derived subscription compilation fails', async () => {
    const cookie = await login()
    await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'Broken delivery', content: ssLine('Before') }, withCookie(cookie)),
    )
    const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ id: string }> }

    // A corrupt delivery snapshot makes recompilation fail after the Catalog write.
    await env.DATA.put('state:delivery', '{}')
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/nodes/${catalog.nodes[0].id}`,
      jsonRequest({ displayName: 'After compile failure' }, { ...withCookie(cookie), method: 'PATCH' }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      node: { displayName: 'After compile failure' },
      warning: expect.stringContaining('订阅'),
    })
    const latest = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ displayName: string }> }
    expect(latest.nodes[0].displayName).toBe('After compile failure')
  })

  it('reports source recompile failures without rolling back saved mutations', async () => {
    const cookie = await login()
    await env.DATA.put('state:delivery', '{}')

    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'Compile warning', content: ssLine('Warning') }, withCookie(cookie)),
    )
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { source: { id: string }; warning?: string }
    expect(createdBody.warning).toContain('订阅')

    const updated = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${createdBody.source.id}`,
      jsonRequest({ name: 'Updated with warning' }, { ...withCookie(cookie), method: 'PUT' }),
    )
    expect(updated.status).toBe(200)
    expect((await updated.json() as { warning?: string }).warning).toContain('订阅')

    const deleted = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${createdBody.source.id}`,
      jsonRequest({}, { ...withCookie(cookie), method: 'DELETE' }),
    )
    expect(deleted.status).toBe(204)
    expect(deleted.headers.get('x-catalog-recompile')).toBe('failed')

    vi.stubGlobal('fetch', async () => new Response(ssLine('Remote warning')))
    const remote = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({
        type: 'remote',
        name: 'Remote warning',
        url: 'https://feed.example.com/source',
        headers: {},
        refreshIntervalMinutes: 15,
      }, withCookie(cookie)),
    )
    const remoteBody = await remote.json() as { source: { id: string }; warning?: string }
    expect(remoteBody.warning).toContain('订阅')
    const refreshed = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources/${remoteBody.source.id}/refresh`,
      jsonRequest({}, withCookie(cookie)),
    )
    expect((await refreshed.json() as { warning?: string }).warning).toContain('订阅')
  })

  it('creates, updates, and deletes groups with reference validation', async () => {
    const cookie = await login()
    const createdSource = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'Groups', content: ssLine('Group node') }, withCookie(cookie)),
    )
    const sourceId = (await createdSource.json() as { source: { id: string } }).source.id
    const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ id: string }> }
    const nodeId = catalog.nodes[0].id

    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups`,
      jsonRequest({ name: 'Group', sourceIds: [sourceId], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [nodeId] }, withCookie(cookie)),
    )
    expect(created.status).toBe(201)
    const groupId = (await created.json() as { group: { id: string } }).group.id

    const updated = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups/${groupId}`,
      jsonRequest({ name: 'Updated', sourceIds: [sourceId], includedNodeIds: [nodeId], excludedNodeIds: [], nodeOrder: [nodeId] }, { ...withCookie(cookie), method: 'PUT' }),
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ group: { id: groupId, name: 'Updated' } })

    const invalid = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups`,
      jsonRequest({ name: 'Invalid', sourceIds: ['src_999'], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [] }, withCookie(cookie)),
    )
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({ error: { code: 'CATALOG_REFERENCE_INVALID' } })

    expect((await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups/${groupId}`,
      jsonRequest({}, { ...withCookie(cookie), method: 'DELETE' }),
    )).status).toBe(204)
  })

  it('does not delete a group when subscription state cannot be updated', async () => {
    const cookie = await login()
    const createdSource = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'Protected group', content: ssLine('Protected node') }, withCookie(cookie)),
    )
    const sourceId = (await createdSource.json() as { source: { id: string } }).source.id
    const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ id: string }> }
    const createdGroup = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups`,
      jsonRequest({ name: 'Protected', sourceIds: [sourceId], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [catalog.nodes[0].id] }, withCookie(cookie)),
    )
    const groupId = (await createdGroup.json() as { group: { id: string } }).group.id

    await env.DATA.put('state:delivery', '{}')
    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups/${groupId}`,
      jsonRequest({}, { ...withCookie(cookie), method: 'DELETE' }),
    )
    expect(response.status).toBe(500)
    const latest = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { groups: Array<{ id: string }> }
    expect(latest.groups.map(({ id }) => id)).toContain(groupId)
  })

  it('returns stable validation and remote error envelopes', async () => {
    const cookie = await login()
    const invalid = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/preview`,
      jsonRequest({ content: '' }, withCookie(cookie)),
    )
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })

    const remoteUrl = 'http://127.0.0.1/private?token=secret'
    const blocked = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'remote', name: 'Blocked', url: remoteUrl, headers: {}, refreshIntervalMinutes: 15 }, withCookie(cookie)),
    )
    expect(blocked.status).toBe(422)
    const text = await blocked.text()
    expect(text).toContain('REMOTE_URL_INVALID')
    expect(text).not.toContain(remoteUrl)
    expect(text).not.toContain('secret')
  })
})
