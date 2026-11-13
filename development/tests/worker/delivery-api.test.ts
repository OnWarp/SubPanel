import { env, exports } from 'cloudflare:workers'
import { parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const ssLine = (name: string, host = 'ss.example.com') =>
  `ss://${btoa('aes-128-gcm:password')}@${host}:8388#${encodeURIComponent(name)}`

async function createCatalogGroup(cookie: string, content = ssLine('Delivery node')): Promise<string> {
  const sourceResponse = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/sources`,
    jsonRequest({ type: 'manual', name: 'Delivery source', content }, withCookie(cookie)),
  )
  const sourceId = (await sourceResponse.json() as { source: { id: string } }).source.id
  const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ id: string }> }
  const groupResponse = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/groups`,
    jsonRequest({ name: 'Delivery group', sourceIds: [sourceId], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [catalog.nodes[0].id] }, withCookie(cookie)),
  )
  return (await groupResponse.json() as { group: { id: string } }).group.id
}

async function createUserCookie(adminCookie: string): Promise<string> {
  const inviteResponse = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/invites`,
    jsonRequest({ username: 'delivery-user' }, withCookie(adminCookie)),
  )
  const link = (await inviteResponse.json() as { invite: { link: string } }).invite.link
  const token = new URL(link).pathname.split('/').at(-1)!
  await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`, jsonRequest({ password: 'delivery user password' }))
  return login('delivery-user', 'delivery user password')
}

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

afterEach(() => vi.unstubAllGlobals())

describe('Delivery APIs and public subscriptions', () => {
  it('creates a subscription, precompiles artifacts, and serves conditional responses', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: '主要订阅', groupIds: [groupId], defaultClient: 'mihomo' }, withCookie(admin)),
    )
    expect(created.status).toBe(201)
    const body = await created.json() as {
      subscription: {
        id: string
        tokenPrefix: string
        links: Record<string, string>
        diagnostics: Record<string, { outputNodes: number; skippedNodes: number; available: boolean }>
      }
      token: string
    }
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(body.subscription.links.mihomo).toContain(`/sub/${body.token}/mihomo`)
    expect(body.subscription.links.clash).toContain(`/sub/${body.token}/clash`)
    expect(body.subscription.links['clash-meta']).toContain(`/sub/${body.token}/clash-meta`)
    expect(body.subscription.links.stash).toContain(`/sub/${body.token}/stash`)
    expect(body.subscription.links.karing).toContain(`/sub/${body.token}/karing`)
    expect(JSON.stringify(body)).not.toContain('encryptedToken')
    expect(body.subscription.diagnostics.mihomo).toMatchObject({ outputNodes: 1, skippedNodes: 0, available: true })
    expect((await env.DATA.list({ prefix: 'compiled:' })).keys.length).toBeGreaterThanOrEqual(9)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/admin/delivery`, withCookie(admin))).status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/admin/delivery/subscriptions`, withCookie(admin))).status).toBe(200)

    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/mihomo`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('yaml')
    expect(response.headers.get('profile-title')).toBe(encodeURIComponent('主要订阅'))
    const downloadNames = {
      mihomo: '主要订阅.yaml', clash: '主要订阅.yaml', 'clash-meta': '主要订阅.yaml', stash: '主要订阅.yaml',
      singbox: '主要订阅.json', karing: '主要订阅.json', 'sing-box': '主要订阅.json',
      surge: '主要订阅.conf', loon: '主要订阅.conf', quantumultx: '主要订阅.conf', 'quantumult-x': '主要订阅.conf',
      v2rayn: '主要订阅.txt', v2rayng: '主要订阅.txt', nekobox: '主要订阅.txt', 'neko-box': '主要订阅.txt',
      shadowrocket: '主要订阅.txt', generic: '主要订阅.txt',
    }
    for (const [client, fileName] of Object.entries(downloadNames)) {
      const clientResponse = await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/${client}`)
      expect(clientResponse.status, client).toBe(200)
      expect(clientResponse.headers.get('content-disposition'), client).toContain(`filename*=UTF-8''${encodeURIComponent(fileName)}`)
    }
    const etag = response.headers.get('etag')
    expect(etag).toBeTruthy()
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/mihomo`, { headers: { 'If-None-Match': etag! } })).status).toBe(304)
    for (const alias of ['clash', 'clash-meta', 'stash']) {
      const aliasResponse = await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/${alias}`)
      expect(aliasResponse.status).toBe(200)
      expect(aliasResponse.headers.get('content-type')).toContain('yaml')
      expect(await aliasResponse.text()).toContain('proxies:')
    }
    const karing = await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/karing`)
    expect(karing.status).toBe(200)
    expect(karing.headers.get('content-type')).toContain('application/json')
    expect(await karing.text()).toContain('"outbounds"')

    const stashAuto = await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}`, { headers: { 'User-Agent': 'Stash/2.7' } })
    expect(stashAuto.headers.get('content-type')).toContain('yaml')
    const karingAuto = await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}`, { headers: { 'User-Agent': 'Karing/1.2' } })
    expect(karingAuto.headers.get('content-type')).toContain('application/json')
  })

  it('converts an imported PEM certificate to a Mihomo certificate fingerprint', async () => {
    const admin = await login()
    const certificate = '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----'
    const groupId = await createCatalogGroup(admin, `hysteria2://password@hy2.example.com:443?cert=${encodeURIComponent(certificate)}#HY2`)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'HY2', groupIds: [groupId], defaultClient: 'mihomo' }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    const proxy = (parseYaml(await response.text()) as { proxies: Array<Record<string, unknown>> }).proxies[0]
    expect(proxy).toMatchObject({
      type: 'hysteria2',
      fingerprint: '03:90:58:C6:F2:C0:CB:49:2C:53:3B:0A:4D:14:EF:77:CC:0F:78:AB:CC:CE:D5:28:7D:84:A1:A2:01:1C:FB:81',
    })
    expect(proxy).not.toHaveProperty('certificate')
  })

  it('routes unknown user agents to the generic URI artifact', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Auto', groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}`, { headers: { 'User-Agent': 'unknown-client/1.0' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(atob(await response.text())).toContain('ss://')
  })

  it('recompiles legacy subscription artifacts on first request', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Legacy', groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const artifactKey = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))!.name
    const artifact = JSON.parse((await env.DATA.get(artifactKey))!) as Record<string, unknown>
    artifact.schemaVersion = 1
    await env.DATA.put(artifactKey, JSON.stringify(artifact))

    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)).status).toBe(200)
    expect(JSON.parse((await env.DATA.get(artifactKey))!).schemaVersion).toBe(2)
  })

  it('fails closed for a corrupt compiled artifact', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Corrupt artifact', groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const artifact = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))
    await env.DATA.put(artifact!.name, '{}')

    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: { code: 'SUBSCRIPTION_NOT_FOUND', message: '订阅不存在' } })
  })

  it('rejects a compiled artifact when its current subscription is disabled or deleted', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Authoritative state', groupIds: [groupId] }, withCookie(admin)),
    )
    const body = await created.json() as { subscription: { id: string }; token: string }
    const artifactKey = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))!.name
    const artifact = JSON.parse((await env.DATA.get(artifactKey))!) as Record<string, unknown>

    const disabled = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${body.subscription.id}`,
      jsonRequest({ enabled: false }, { ...withCookie(admin), method: 'PATCH' }),
    )
    artifact.subscriptionRevision = (await disabled.json() as { subscription: { revision: number } }).subscription.revision
    await env.DATA.put(artifactKey, JSON.stringify(artifact))
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/mihomo`)).status).toBe(404)

    await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${body.subscription.id}`,
      jsonRequest({}, { ...withCookie(admin), method: 'DELETE' }),
    )
    await env.DATA.put(artifactKey, JSON.stringify(artifact))
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/mihomo`)).status).toBe(404)
  })

  it('rejects an artifact compiled for an older subscription revision', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Old subscription revision', groupIds: [groupId] }, withCookie(admin)),
    )
    const body = await created.json() as { subscription: { id: string }; token: string }
    const artifactKey = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))!.name
    const staleArtifact = (await env.DATA.get(artifactKey))!

    await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${body.subscription.id}`,
      jsonRequest({ name: 'New subscription revision' }, { ...withCookie(admin), method: 'PATCH' }),
    )
    await env.DATA.put(artifactKey, staleArtifact)

    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/mihomo`)).status).toBe(404)
    const listed = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))).json() as {
      subscriptions: Array<{ id: string; diagnostics: Record<string, unknown> }>
    }
    expect(listed.subscriptions.find(({ id }) => id === body.subscription.id)?.diagnostics).not.toHaveProperty('mihomo')
  })

  it('rejects an artifact compiled for an older Catalog revision', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Old Catalog revision', groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const artifactKey = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))!.name
    const staleArtifact = (await env.DATA.get(artifactKey))!
    const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(admin))).json() as { nodes: Array<{ id: string }> }

    await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/nodes/${catalog.nodes[0].id}`,
      jsonRequest({ displayName: 'New Catalog revision' }, { ...withCookie(admin), method: 'PATCH' }),
    )
    await env.DATA.put(artifactKey, staleArtifact)

    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)).status).toBe(404)
  })

  it('returns a warning instead of a false failure when initial compilation fails', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const originalPut = env.DATA.put.bind(env.DATA)
    const put = vi.spyOn(env.DATA, 'put').mockImplementation(async (key, value, options) => {
      if (key.startsWith('compiled:')) throw new Error('compile failed')
      return originalPut(key, value, options)
    })
    try {
      const response = await exports.default.fetch(
        `${TEST_ORIGIN}/api/admin/subscriptions`,
        jsonRequest({ userId: 'usr_1', name: 'Compile warning', groupIds: [groupId] }, withCookie(admin)),
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ warning: expect.stringContaining('编译') })
    } finally {
      put.mockRestore()
    }
  })

  it('does not report token reset as failed when stale artifact cleanup fails', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Cleanup warning', groupIds: [groupId] }, withCookie(admin)),
    )
    const body = await created.json() as { subscription: { id: string }; token: string }
    const originalDelete = env.DATA.delete.bind(env.DATA)
    const remove = vi.spyOn(env.DATA, 'delete').mockImplementation(async (key) => {
      if (key.startsWith('compiled:')) throw new Error('cleanup failed')
      return originalDelete(key)
    })
    try {
      const response = await exports.default.fetch(
        `${TEST_ORIGIN}/api/admin/subscriptions/${body.subscription.id}/token/reset`,
        jsonRequest({}, withCookie(admin)),
      )
      expect(response.status).toBe(200)
      const rotated = (await response.json() as { token: string }).token
      expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/mihomo`)).status).toBe(404)
      expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${rotated}/mihomo`)).status).toBe(200)
    } finally {
      remove.mockRestore()
    }
  })

  it('enforces ownership and removes old artifacts on reset or disable', async () => {
    const admin = await login()
    const user = await createUserCookie(admin)
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_2', name: 'User subscription', groupIds: [groupId] }, withCookie(admin)),
    )
    const original = await created.json() as { subscription: { id: string }; token: string }
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscriptions`, withCookie(user))).status).toBe(200)
    const reset = await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscriptions/${original.subscription.id}/token/reset`, jsonRequest({}, withCookie(user)))
    expect(reset.status).toBe(200)
    const rotatedToken = (await reset.json() as { token: string }).token
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${original.token}/mihomo`)).status).toBe(404)

    const updated = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${original.subscription.id}`,
      jsonRequest({ enabled: false }, { ...withCookie(admin), method: 'PATCH' }),
    )
    expect(updated.status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${rotatedToken}/mihomo`)).status).toBe(404)

    const deleted = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${original.subscription.id}`,
      jsonRequest({}, { ...withCookie(admin), method: 'DELETE' }),
    )
    expect(deleted.status).toBe(204)
    const subscriptions = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))).json() as { subscriptions: Array<{ id: string }> }
    expect(subscriptions.subscriptions).not.toContainEqual(expect.objectContaining({ id: original.subscription.id }))
  })

  it('recompiles an existing subscription after a Catalog node edit', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Refresh me', groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(admin))).json() as { nodes: Array<{ id: string }> }
    const patchResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/nodes/${catalog.nodes[0].id}`,
      jsonRequest({ displayName: 'Edited node' }, { ...withCookie(admin), method: 'PATCH' }),
    )
    expect(patchResponse.status).toBe(200)
    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    expect(await response.text()).toContain('Edited node')
  })

  it('enforces subscription start and expiry on public delivery and share export', async () => {
    const admin = await login()
    const userCookie = await createUserCookie(admin)
    const users = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(admin))).json() as { users: Array<{ id: string; username: string }> }
    const userId = users.users.find((user) => user.username === 'delivery-user')?.id
    expect(userId).toBeTruthy()
    const groupId = await createCatalogGroup(admin)
    const now = Date.now()
    const day = 86_400_000

    const inverted = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Inverted', groupIds: [groupId], startsAt: now + 10 * day, expiresAt: now + day }, withCookie(admin)),
    )
    expect(inverted.status).toBe(422)
    expect(await inverted.json()).toEqual({ error: { code: 'SUBSCRIPTION_WINDOW_INVALID', message: '到期时间必须晚于生效时间' } })

    const pendingResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Pending', groupIds: [groupId], startsAt: now + 2 * day, expiresAt: now + 10 * day }, withCookie(admin)),
    )
    expect(pendingResponse.status).toBe(201)
    const pending = await pendingResponse.json() as { subscription: { id: string; startsAt: number | null; expiresAt: number | null }; token: string }
    expect(pending.subscription).toMatchObject({ startsAt: now + 2 * day, expiresAt: now + 10 * day })
    const pendingFetch = await exports.default.fetch(`${TEST_ORIGIN}/sub/${pending.token}/mihomo`)
    expect(pendingFetch.status).toBe(403)
    expect(await pendingFetch.json()).toEqual({ error: { code: 'SUB_NOT_STARTED', message: '订阅尚未生效' } })

    const expiredResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Expired', groupIds: [groupId], expiresAt: now - day }, withCookie(admin)),
    )
    expect(expiredResponse.status).toBe(201)
    const expired = await expiredResponse.json() as { subscription: { id: string; expiresAt: number | null }; token: string }
    expect(expired.subscription.expiresAt).toBe(now - day)
    const expiredFetch = await exports.default.fetch(`${TEST_ORIGIN}/sub/${expired.token}/mihomo`)
    expect(expiredFetch.status).toBe(410)
    expect(await expiredFetch.json()).toEqual({ error: { code: 'SUB_EXPIRED', message: '订阅已过期' } })

    const foreverResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Forever', groupIds: [groupId] }, withCookie(admin)),
    )
    expect(foreverResponse.status).toBe(201)
    const forever = await foreverResponse.json() as { subscription: { id: string; startsAt: number | null; expiresAt: number | null }; token: string }
    expect(forever.subscription.startsAt).toBeNull()
    expect(forever.subscription.expiresAt).toBeNull()
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${forever.token}/mihomo`)).status).toBe(200)

    const mine = await (await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscriptions`, withCookie(userCookie))).json() as { subscriptions: Array<{ id: string; startsAt: number | null; expiresAt: number | null }> }
    expect(mine.subscriptions.find((item) => item.id === pending.subscription.id)).toMatchObject({ startsAt: now + 2 * day, expiresAt: now + 10 * day })
    expect(mine.subscriptions.find((item) => item.id === forever.subscription.id)).toMatchObject({ startsAt: null, expiresAt: null })

    async function shareExport(subscriptionId: string): Promise<Response> {
      const created = await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares`,
        jsonRequest({ subscriptionId }, withCookie(userCookie)),
      )
      expect(created.status).toBe(201)
      const token = (await created.json() as { token: string }).token
      return exports.default.fetch(`${TEST_ORIGIN}/api/shares/${token}/export?client=mihomo`)
    }

    const pendingShare = await shareExport(pending.subscription.id)
    expect(pendingShare.status).toBe(403)
    expect(await pendingShare.json()).toEqual({ error: { code: 'SUB_NOT_STARTED', message: '订阅尚未生效' } })
    const expiredShare = await shareExport(expired.subscription.id)
    expect(expiredShare.status).toBe(410)
    expect(await expiredShare.json()).toEqual({ error: { code: 'SUB_EXPIRED', message: '订阅已过期' } })
    expect((await shareExport(forever.subscription.id)).status).toBe(200)

    await env.DB.prepare('UPDATE subscriptions SET starts_at = NULL, expires_at = NULL').run()
    const listed = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))).json() as { subscriptions: Array<{ startsAt: number | null; expiresAt: number | null }> }
    expect(listed.subscriptions.every((subscription) => subscription.startsAt === null && subscription.expiresAt === null)).toBe(true)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${expired.token}/mihomo`)).status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${forever.token}/mihomo`)).status).toBe(200)
  }, 30_000)

  it('removes deleted group references from subscriptions', async () => {
    const admin = await login()
    const groupId = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Group lifecycle', groupIds: [groupId] }, withCookie(admin)),
    )
    const subscriptionId = (await created.json() as { subscription: { id: string } }).subscription.id
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog/groups/${groupId}`, jsonRequest({}, { ...withCookie(admin), method: 'DELETE' }))).status).toBe(204)
    const listed = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))).json() as { subscriptions: Array<{ id: string; groupIds: string[] }> }
    expect(listed.subscriptions.find((item) => item.id === subscriptionId)?.groupIds).toEqual([])
  })
})
