import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../../../worker/index'
import { createFixtureAccount } from './helpers'
import { createShare, exportShare } from '../../../worker/shares/service'
import { compiledKey } from '../../../worker/delivery/repository'
import { hashToken } from '../../../worker/platform/crypto'
import { runCron } from '../../../worker/operations/cron'
import { env, exports } from 'cloudflare:workers'
import { parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryFixturePlan, enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const ssLine = (name: string, host = 'ss.example.com') =>
  `ss://${btoa('aes-128-gcm:password')}@${host}:8388#${encodeURIComponent(name)}`

async function createCatalogGroup(cookie: string, content = ssLine('Delivery node')) {
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
  const id = (await groupResponse.json() as { group: { id: string } }).group.id
  const plan = await createDeliveryFixturePlan([id])
  return { groupId: id, planId: plan.id }
}

async function createUserCookie(_adminCookie: string): Promise<string> {
  await createFixtureAccount('delivery-user', 'delivery user password')
  return login('delivery-user', 'delivery user password')
}

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

afterEach(() => vi.unstubAllGlobals())

describe('Delivery APIs and public subscriptions', () => {
  it('allocates from the pool, transfers with token rotation, and recycles with the same plan and expiry', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    await createUserCookie(admin)
    const listedUsers = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(admin))).json() as { users: Array<{ id: string; username: string }> }
    const target = listedUsers.users.find((user) => user.username === 'delivery-user')
    const expiresAt = Date.now() + 86400000
    const created = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, jsonRequest({ name: 'Pool', planId, groupIds: [groupId], expiresAt }, withCookie(admin)))
    expect(created.status).toBe(201)
    type Result = { subscription: { id: string; userId: string | null; expiresAt: number; groupIds: string[] }; token: string }
    const pool = await created.json() as Result
    expect(pool.subscription.userId).toBeNull()
    const pull = (token: string) => exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    expect((await pull(pool.token)).status).toBe(200)
    const transfer = async (userId: string | null) => {
      const response = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions/${pool.subscription.id}/transfer`, jsonRequest({ userId }, withCookie(admin)))
      expect(response.status).toBe(200)
      const result = await response.json() as Result
      expect(result.subscription).toMatchObject({ userId, expiresAt, planId, groupIds: [groupId] })
      return result
    }
    const assigned = await transfer('usr_1')
    expect((await pull(pool.token)).status).toBe(404)
    expect((await pull(assigned.token)).status).toBe(200)
    const moved = await transfer(target!.id)
    expect((await pull(assigned.token)).status).toBe(404)
    expect((await pull(moved.token)).status).toBe(200)
    const recycled = await transfer(null)
    expect((await pull(moved.token)).status).toBe(404)
    expect((await pull(recycled.token)).status).toBe(200)
    const audits = await env.DB.prepare("SELECT detail FROM audit_logs WHERE action = 'post.subscriptions.transfer'").all<{ detail: string }>()
    expect(audits.results).toHaveLength(3)
    expect(JSON.stringify(audits.results)).not.toContain(moved.token)
  })

  it('creates temporary admin shares through the shared mechanism and rejects them at expiry', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const response = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, jsonRequest({ userId: 'usr_1', name: 'Share', planId, groupIds: [groupId] }, withCookie(admin)))
    const { subscription } = await response.json() as { subscription: { id: string } }
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600000).toISOString()
    const created = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/shares`, jsonRequest({ subscriptionId: subscription.id, expiresAt }, withCookie(admin)))
    expect(created.status).toBe(201)
    const result = await created.json() as { token: string; share: { expiresAt: string } }
    expect(result.share.expiresAt).toBe(expiresAt)
    expect((await exportShare(env, result.token, undefined, 'mihomo', null, null, TEST_ORIGIN, now)).kind).toBe('client')
    await expect(exportShare(env, result.token, undefined, 'mihomo', null, null, TEST_ORIGIN, new Date(expiresAt))).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' })
    const other = await createShare(env, 'usr_1', { subscriptionId: subscription.id }, now)
    expect(other.share.status).toBe('active')
  })

  it('cron disables expired subscriptions without deleting them and admin extension restores delivery', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const now = Date.now()
    const created = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, jsonRequest({ userId: 'usr_1', name: 'Retained', planId, groupIds: [groupId], expiresAt: now + 10000 }, withCookie(admin)))
    const { subscription, token } = await created.json() as { subscription: { id: string }; token: string }
    await runCron(env, { now: new Date(now + 10001).toISOString() })
    expect(await env.DB.prepare('SELECT enabled FROM subscriptions WHERE id = ?').bind(subscription.id).first()).toEqual({ enabled: 0 })
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)).status).toBe(404)
    const mine = await (await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscriptions`, withCookie(admin))).json() as { subscriptions: Array<{ id: string; enabled: boolean }> }
    expect(mine.subscriptions).toContainEqual(expect.objectContaining({ id: subscription.id, enabled: false }))
    const updated = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions/${subscription.id}`, jsonRequest({ expiresAt: now + 86400000, enabled: true }, withCookie(admin, { method: 'PATCH' })))
    expect(updated.status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)).status).toBe(200)
  })

  it('creates a subscription, precompiles artifacts, and serves conditional responses', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: '主要订阅', planId, groupIds: [groupId], defaultClient: 'mihomo' }, withCookie(admin)),
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
      const clientEtag = clientResponse.headers.get('etag')
      expect(clientEtag, client).toBeTruthy()
      const unchanged = await exports.default.fetch(`${TEST_ORIGIN}/sub/${body.token}/${client}`, { headers: { 'If-None-Match': clientEtag! } })
      expect(unchanged.status, client).toBe(304)
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
    const { groupId, planId } = await createCatalogGroup(admin, `hysteria2://password@hy2.example.com:443?cert=${encodeURIComponent(certificate)}#HY2`)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'HY2', planId, groupIds: [groupId], defaultClient: 'mihomo' }, withCookie(admin)),
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
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Auto', planId, groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}`, { headers: { 'User-Agent': 'unknown-client/1.0' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(atob(await response.text())).toContain('ss://')
  })

  it('recompiles legacy subscription artifacts on first request', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Legacy', planId, groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const artifactKey = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))!.name
    const artifact = JSON.parse((await env.DATA.get(artifactKey))!) as Record<string, unknown>
    artifact.schemaVersion = 1
    await env.DATA.put(artifactKey, JSON.stringify(artifact))

    const ctx = createExecutionContext()
    expect((await worker.fetch(new Request(`${TEST_ORIGIN}/sub/${token}/mihomo`), env, ctx)).status).toBe(200)
    await waitOnExecutionContext(ctx)
    expect(JSON.parse((await env.DATA.get(artifactKey))!).schemaVersion).toBe(2)
  })

  it('rebuilds a corrupt compiled artifact', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Corrupt artifact', planId, groupIds: [groupId] }, withCookie(admin)),
    )
    const token = (await created.json() as { token: string }).token
    const artifact = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))
    await env.DATA.put(artifact!.name, '{}')

    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toContain('Delivery node')
  })

  it('rejects a compiled artifact when its current subscription is disabled or deleted', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Authoritative state', planId, groupIds: [groupId] }, withCookie(admin)),
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

  it('rebuilds an artifact compiled for an older subscription revision', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Old subscription revision', planId, groupIds: [groupId] }, withCookie(admin)),
    )
    const body = await created.json() as { subscription: { id: string }; token: string }
    const artifactKey = (await env.DATA.list({ prefix: 'compiled:' })).keys.find(({ name }) => name.endsWith(':mihomo'))!.name
    const staleArtifact = (await env.DATA.get(artifactKey))!

    await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${body.subscription.id}`,
      jsonRequest({ name: 'New subscription revision' }, { ...withCookie(admin), method: 'PATCH' }),
    )
    await env.DATA.put(artifactKey, staleArtifact)

    const ctx = createExecutionContext()
    const response = await worker.fetch(new Request(`${TEST_ORIGIN}/sub/${body.token}/mihomo`), env, ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('profile-title')).toBe(encodeURIComponent('New subscription revision'))
    await waitOnExecutionContext(ctx)
    const listed = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))).json() as {
      subscriptions: Array<{ id: string; diagnostics: Record<string, unknown> }>
    }
    expect(listed.subscriptions.find(({ id }) => id === body.subscription.id)?.diagnostics).toHaveProperty('mihomo')
  })

  it('rebuilds an artifact compiled for an older Catalog revision', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Old Catalog revision', planId, groupIds: [groupId] }, withCookie(admin)),
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

    const response = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('New Catalog revision')
  })

  it('returns a warning instead of a false failure when initial compilation fails', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const originalPut = env.DATA.put.bind(env.DATA)
    const put = vi.spyOn(env.DATA, 'put').mockImplementation(async (key, value, options) => {
      if (key.startsWith('compiled:')) throw new Error('compile failed')
      return originalPut(key, value, options)
    })
    try {
      const response = await exports.default.fetch(
        `${TEST_ORIGIN}/api/admin/subscriptions`,
        jsonRequest({ userId: 'usr_1', name: 'Compile warning', planId, groupIds: [groupId] }, withCookie(admin)),
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ warning: expect.stringContaining('编译') })
    } finally {
      put.mockRestore()
    }
  })

  it('does not report token reset as failed when stale artifact cleanup fails', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Cleanup warning', planId, groupIds: [groupId] }, withCookie(admin)),
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
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_2', name: 'User subscription', planId, groupIds: [groupId] }, withCookie(admin)),
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
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Refresh me', planId, groupIds: [groupId] }, withCookie(admin)),
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
    const { groupId, planId } = await createCatalogGroup(admin)
    const now = Date.now()
    const day = 86_400_000

    const inverted = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Inverted', planId, groupIds: [groupId], startsAt: now + 10 * day, expiresAt: now + day }, withCookie(admin)),
    )
    expect(inverted.status).toBe(422)
    expect(await inverted.json()).toEqual({ error: { code: 'SUBSCRIPTION_WINDOW_INVALID', message: '到期时间必须晚于生效时间' } })

    const pendingResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Pending', planId, groupIds: [groupId], startsAt: now + 2 * day, expiresAt: now + 10 * day }, withCookie(admin)),
    )
    expect(pendingResponse.status).toBe(201)
    const pending = await pendingResponse.json() as { subscription: { id: string; startsAt: number | null; expiresAt: number | null }; token: string }
    expect(pending.subscription).toMatchObject({ startsAt: now + 2 * day, expiresAt: now + 10 * day })
    const pendingFetch = await exports.default.fetch(`${TEST_ORIGIN}/sub/${pending.token}/mihomo`)
    expect(pendingFetch.status).toBe(403)
    expect(await pendingFetch.json()).toEqual({ error: { code: 'SUB_NOT_STARTED', message: '订阅尚未生效' } })

    const expiredResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Expired', planId, groupIds: [groupId], expiresAt: now - day }, withCookie(admin)),
    )
    expect(expiredResponse.status).toBe(201)
    const expired = await expiredResponse.json() as { subscription: { id: string; expiresAt: number | null }; token: string }
    expect(expired.subscription.expiresAt).toBe(now - day)
    const expiredFetch = await exports.default.fetch(`${TEST_ORIGIN}/sub/${expired.token}/mihomo`)
    expect(expiredFetch.status).toBe(410)
    expect(await expiredFetch.json()).toEqual({ error: { code: 'SUB_EXPIRED', message: '订阅已过期' } })

    const foreverResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId, name: 'Forever', planId, groupIds: [groupId] }, withCookie(admin)),
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
    const expiredShare = await exports.default.fetch(`${TEST_ORIGIN}/api/shares`, jsonRequest({ subscriptionId: expired.subscription.id }, withCookie(userCookie)))
    expect(expiredShare.status).toBe(409)
    expect((await shareExport(forever.subscription.id)).status).toBe(200)

    for (const item of [pending, expired, forever]) {
      const cleared = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions/${item.subscription.id}`, jsonRequest({ startsAt: null, expiresAt: null, enabled: true }, withCookie(admin, { method: 'PATCH' })))
      expect(cleared.status).toBe(200)
    }
    const listed = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))).json() as { subscriptions: Array<{ startsAt: number | null; expiresAt: number | null }> }
    expect(listed.subscriptions.every((subscription) => subscription.startsAt === null && subscription.expiresAt === null)).toBe(true)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${expired.token}/mihomo`)).status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${forever.token}/mihomo`)).status).toBe(200)
  }, 30_000)

  it('previews the plan intersection and uses the latest catalog without rewriting per-subscription caches', async () => {
    const admin = await login()
    const affected = await createCatalogGroup(admin, ssLine('Changed', 'changed.example.com'))
    const unaffected = await createCatalogGroup(admin, ssLine('Unchanged', 'unchanged.example.com'))
    async function create(name: string, { planId, groupId }: typeof affected) {
      const response = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`,
        jsonRequest({ userId: 'usr_1', name, planId, groupIds: [groupId] }, withCookie(admin)))
      expect(response.status).toBe(201)
      return response.json<{ subscription: { id: string }; token: string }>()
    }
    const changed = await create('Changed', affected)
    const untouched = await create('Untouched', unaffected)
    const changeKey = compiledKey(await hashToken(changed.token), 'mihomo')
    const untouchedKey = compiledKey(await hashToken(untouched.token), 'mihomo')
    const cached = await env.DATA.get(untouchedKey)
    const previous = await env.DATA.get(changeKey)
    expect(previous).not.toBeNull()
    expect(cached).not.toBeNull()

    const input = { name: 'Changed', sourceIds: [], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [] }
    const preview = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog/groups/preview`,
      jsonRequest({ input, groupId: affected.groupId, subscriptionId: changed.subscription.id, client: 'mihomo' }, withCookie(admin)))
    expect(await preview.json()).toMatchObject({ affectedSubscriptions: 1, entitlement: { authorizedNodeIds: [], outputNodes: 0 } })
    const saved = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog/groups/${affected.groupId}`,
      jsonRequest(input, { ...withCookie(admin), method: 'PUT' }))
    expect(saved.status).toBe(200)
    expect(await env.DATA.get(changeKey)).toBe(previous)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${changed.token}/mihomo`)).status).toBe(422)
    expect(await env.DATA.get(untouchedKey)).toBe(cached)
  })

  it('protects groups used by an enabled plan and subscription', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: 'Group lifecycle', planId, groupIds: [groupId] }, withCookie(admin)),
    )
    const subscriptionId = (await created.json() as { subscription: { id: string } }).subscription.id
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog/groups/${groupId}`, jsonRequest({}, { ...withCookie(admin), method: 'DELETE' }))).status).toBe(409)
    const listed = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))).json() as { subscriptions: Array<{ id: string; groupIds: string[] }> }
    expect(listed.subscriptions.find((item) => item.id === subscriptionId)?.groupIds).toEqual([groupId])
  })
})

type AdminSubscriptionListBody = {
  subscriptions: Array<{ id: string, name: string, enabled: boolean }>
  total?: number
  page?: number
  pageSize?: number
}

async function createSubscriptionRecord(admin: string, name: string, groupId: string, planId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/subscriptions`,
    jsonRequest({ userId: 'usr_1', name, planId, groupIds: [groupId], defaultClient: 'mihomo', ...extra }, withCookie(admin)),
  )
  expect(created.status).toBe(201)
  return (await created.json() as { subscription: { id: string } }).subscription.id
}

async function listAdminSubscriptions(admin: string, queryString = ''): Promise<AdminSubscriptionListBody> {
  const response = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions${queryString}`, withCookie(admin))
  expect(response.status).toBe(200)
  return response.json() as Promise<AdminSubscriptionListBody>
}

describe('Admin subscriptions list pagination', () => {
  it('keeps the legacy full-list response when no parameters are passed', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    await createSubscriptionRecord(admin, 'Legacy A', groupId, planId)
    await createSubscriptionRecord(admin, 'Legacy B', groupId, planId)

    const body = await listAdminSubscriptions(admin)
    expect(body.subscriptions.map((subscription) => subscription.name)).toEqual(['Legacy A', 'Legacy B'])
    expect(body).not.toHaveProperty('total')
    expect(body).not.toHaveProperty('page')
    expect(body).not.toHaveProperty('pageSize')
  })

  it('pages through subscriptions and returns an empty page out of range', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    for (const name of ['Page A', 'Page B', 'Page C', 'Page D', 'Page E']) {
      await createSubscriptionRecord(admin, name, groupId, planId)
    }
    const legacy = await listAdminSubscriptions(admin)

    const first = await listAdminSubscriptions(admin, '?page=1&pageSize=2')
    expect(first.total).toBe(5)
    expect(first.page).toBe(1)
    expect(first.pageSize).toBe(2)
    expect(first.subscriptions).toHaveLength(2)

    const second = await listAdminSubscriptions(admin, '?page=2&pageSize=2')
    const third = await listAdminSubscriptions(admin, '?page=3&pageSize=2')
    expect(third.subscriptions).toHaveLength(1)
    const pagedIds = [...first.subscriptions, ...second.subscriptions, ...third.subscriptions].map((subscription) => subscription.id)
    expect(pagedIds).toEqual(legacy.subscriptions.map((subscription) => subscription.id))

    const beyond = await listAdminSubscriptions(admin, '?page=4&pageSize=2')
    expect(beyond.subscriptions).toEqual([])
    expect(beyond.total).toBe(5)
    expect(beyond.page).toBe(4)

    const clamped = await listAdminSubscriptions(admin, '?pageSize=500')
    expect(clamped.pageSize).toBe(100)
    expect(clamped.page).toBe(1)
    expect(clamped.subscriptions).toHaveLength(5)
  })

  it('filters by status, expiry and search text before paging', async () => {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const now = Date.now()
    await createSubscriptionRecord(admin, 'Alpha', groupId, planId)
    await createSubscriptionRecord(admin, 'Beta', groupId, planId, { enabled: false })
    await createSubscriptionRecord(admin, 'Gamma', groupId, planId, { expiresAt: now - 60_000 })
    await createSubscriptionRecord(admin, 'Delta', groupId, planId, { expiresAt: now + 20 * 86_400_000 })
    await createSubscriptionRecord(admin, 'Echo', groupId, planId, { expiresAt: now + 3 * 86_400_000 })

    const namesOf = (body: AdminSubscriptionListBody) => body.subscriptions.map((subscription) => subscription.name)

    const disabled = await listAdminSubscriptions(admin, '?status=disabled')
    expect(disabled.total).toBe(2)
    expect(namesOf(disabled)).toEqual(['Beta', 'Gamma'])

    expect(namesOf(await listAdminSubscriptions(admin, '?expiry=expired'))).toEqual(['Gamma'])
    expect(namesOf(await listAdminSubscriptions(admin, '?expiry=permanent'))).toEqual(['Alpha', 'Beta'])
    expect(namesOf(await listAdminSubscriptions(admin, '?enabled=1&expiry=permanent'))).toEqual(['Alpha'])
    expect(namesOf(await listAdminSubscriptions(admin, '?expiry=active'))).toEqual(['Delta'])
    expect(namesOf(await listAdminSubscriptions(admin, '?expiry=soon'))).toEqual(['Echo'])
    expect(namesOf(await listAdminSubscriptions(admin, '?expiry=7'))).toEqual(['Echo'])
    expect(namesOf(await listAdminSubscriptions(admin, '?expiry=30'))).toEqual(['Delta', 'Echo'])

    expect(namesOf(await listAdminSubscriptions(admin, '?q=alpha'))).toEqual(['Alpha'])
    expect(namesOf(await listAdminSubscriptions(admin, '?q=ADMIN'))).toHaveLength(5)
    expect(namesOf(await listAdminSubscriptions(admin, '?q=delivery group'))).toHaveLength(5)

    const enabledSecondPage = await listAdminSubscriptions(admin, '?status=enabled&pageSize=2&page=2')
    expect(enabledSecondPage.total).toBe(3)
    expect(namesOf(enabledSecondPage)).toEqual(['Echo'])

    const enabledOnlyExpired = await listAdminSubscriptions(admin, '?enabled=1&expiry=expired')
    expect(namesOf(enabledOnlyExpired)).toEqual([])
  })
})

describe('live Mihomo policy delivery', () => {
  const templateRoot = '/api/admin/system/subscription-templates'
  beforeEach(async () => {
    await env.DB.prepare('UPDATE subscription_template_default SET template_id=NULL, revision=1').run()
  })
  const yaml = `proxy-groups:
  - name: Policy
    type: select
    proxies: ["$SUBPANEL_NODES", DIRECT]
rules:
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - MATCH,Policy
`

  function mutation(path: string, cookie: string, body: unknown, method = 'POST') {
    return exports.default.fetch(TEST_ORIGIN + path, jsonRequest(body, withCookie(cookie, { method })))
  }

  async function fixture() {
    const admin = await login()
    const { groupId, planId } = await createCatalogGroup(admin)
    const created = await mutation('/api/admin/subscriptions', admin, { userId: 'usr_1', name: 'Policy pull', planId, groupIds: [groupId] })
    expect(created.status).toBe(201)
    const { subscription, token } = await created.json() as { subscription: { id: string }; token: string }
    return { admin, subscription, token, groupId }
  }

  async function createPolicy(admin: string) {
    const response = await mutation(templateRoot, admin, { name: 'Policy', yaml })
    expect(response.status).toBe(201)
    return await response.json() as { id: string; revision: number; draftHash: string }
  }

  it('rebuilds missing artifacts, serves changed template bytes and reuses the original ETag after rollback', async () => {
    const { admin, subscription, token } = await fixture()
    const template = await createPolicy(admin)
    const path = `${templateRoot}/${template.id}`
    const firstVersion = await mutation(path + '/publish', admin, { expectedRevision: 1, draftHash: template.draftHash })
    expect(firstVersion.status).toBe(200)
    const { versionId } = await firstVersion.json() as { versionId: string }
    expect((await mutation(templateRoot + '/default', admin, { templateId: template.id, expectedRevision: 1 }, 'PUT')).status).toBe(200)

    const { hashToken } = await import('../../../worker/platform/crypto')
    const key = `compiled:${await hashToken(token)}:mihomo`
    const pull = (etag?: string) => exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`, {
      headers: etag ? { 'If-None-Match': etag } : {},
    })
    await env.DATA.delete(key)
    const ctx = createExecutionContext()
    const first = await worker.fetch(new Request(`${TEST_ORIGIN}/sub/${token}/mihomo`), env, ctx)
    expect(first.status).toBe(200)
    expect(first.headers.get('last-modified')).toBeNull()
    const firstEtag = first.headers.get('etag')!
    const firstBody = await first.text()
    expect(firstBody).toContain('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve')
    await waitOnExecutionContext(ctx)
    expect(JSON.parse((await env.DATA.get(key))!)).toMatchObject({ templateVersionId: versionId, body: firstBody, etag: firstEtag })

    const { compileSubscriptionById } = await import('../../../worker/delivery/compiler')
    const compiled = await compileSubscriptionById(env, subscription.id)
    expect(compiled.find(value => value.client === 'mihomo')).toMatchObject({ templateVersionId: versionId, body: firstBody, etag: firstEtag })
    expect(compiled.find(value => value.client === 'singbox')?.templateVersionId).toBeUndefined()

    const share = await mutation('/api/shares', admin, { subscriptionId: subscription.id })
    expect(share.status).toBe(201)
    const { token: shareToken } = await share.json() as { token: string }
    const pullShare = () => exports.default.fetch(`${TEST_ORIGIN}/api/shares/${shareToken}/export?client=mihomo`)
    const firstShare = await pullShare()
    expect(firstShare.status).toBe(200)
    expect(await firstShare.text()).toBe(firstBody)

    const preview = await mutation(templateRoot + '/preview', admin, { subscriptionId: subscription.id })
    expect(preview.status).toBe(200)
    const previewData = await preview.text()
    expect(JSON.parse(previewData)).toMatchObject({
      outputNodes: 1, effectiveVersionId: versionId, zeroNodeReason: null,
      groups: [{ name: 'Policy', proxies: ['Delivery node', 'DIRECT'] }],
    })
    expect(previewData).not.toContain('ss.example.com')
    expect(previewData).not.toContain('password')
    expect((await pull(firstEtag)).status).toBe(304)

    const saved = await mutation(path, admin, {
      name: 'Policy', yaml: yaml.replace('10.0.0.0/8', '192.168.0.0/16'), expectedRevision: 2,
    }, 'PUT')
    expect(saved.status).toBe(200)
    const { draftHash } = await saved.json() as { draftHash: string }
    expect((await mutation(path + '/publish', admin, { expectedRevision: 3, draftHash })).status).toBe(200)
    const changed = await pull(firstEtag)
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(firstEtag)
    const changedBody = await changed.text()
    expect(changedBody).toContain('192.168.0.0/16')
    expect(await (await pullShare()).text()).toBe(changedBody)

    expect((await mutation(path + '/rollback', admin, { versionId, expectedRevision: 4 })).status).toBe(200)
    expect((await pull(firstEtag)).status).toBe(304)
    const audit = await env.DB.prepare("SELECT detail FROM audit_logs WHERE action='template.rollback' AND target_id=?").bind(template.id).first<{ detail: string }>()
    expect(JSON.parse(audit!.detail)).toMatchObject({ versionId })
  })

  it('publishes a four-layer profile, verifies the exact version and preserves the existing public link', async () => {
    const { admin, subscription, token } = await fixture()
    const draft = `subpanel:
  nodes:
    prefix: "灰度 "
    rename:
      - pattern: "^Delivery"
        replacement: "Tokyo"
    sort: name
    deduplicate: name
  client:
    dns: { enable: true, nameserver: [1.1.1.1] }
proxy-groups:
  - { name: Proxy, type: select, proxies: [Fast, Backup, Balance] }
  - { name: Fast, type: url-test, proxies: ["$SUBPANEL_NODES"], tolerance: 50 }
  - { name: Backup, type: fallback, proxies: ["$SUBPANEL_NODES"] }
  - { name: Balance, type: load-balance, proxies: ["$SUBPANEL_NODES"], strategy: round-robin }
rules:
  - DOMAIN-SUFFIX,example.org,DIRECT
  - MATCH,Proxy
`
    const create = await mutation(templateRoot, admin, { name: '灰度配置', yaml: draft })
    expect(create.status).toBe(201)
    const { id: profileId, revision, draftHash } = await create.json() as { id: string; revision: number; draftHash: string }
    const root = `${templateRoot}/${profileId}`
    const publish = await mutation(root + '/publish', admin, { expectedRevision: revision, draftHash })
    expect(publish.status, await publish.clone().text()).toBe(200)
    const { versionId } = await publish.json() as { versionId: string }
    const url = `${TEST_ORIGIN}/sub/${token}/mihomo`
    expect((await (await exports.default.fetch(url)).text())).not.toContain('Tokyo')
    expect((await mutation(`${templateRoot}/bindings/${subscription.id}`, admin, {
      mode: 'specific', templateId: profileId, expectedRevision: 1,
    }, 'PUT')).status).toBe(200)
    const pull = await exports.default.fetch(url)
    expect(pull.status).toBe(200)
    expect(parseYaml(await pull.text())).toMatchObject({
      mode: 'rule', dns: { enable: true },
      proxies: [{ name: '灰度 Tokyo node', type: 'ss' }],
      'proxy-groups': [
        { name: 'Proxy', type: 'select', proxies: ['Fast', 'Backup', 'Balance'] },
        { name: 'Fast', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 300, proxies: ['灰度 Tokyo node'] },
        { name: 'Backup', type: 'fallback' },
        { name: 'Balance', type: 'load-balance', strategy: 'round-robin' },
      ],
      rules: ['DOMAIN-SUFFIX,example.org,DIRECT', 'MATCH,Proxy'],
    })
    const preview = await mutation(templateRoot + '/preview', admin, { profileId, versionId, subscriptionId: subscription.id })
    expect(preview.status, await preview.clone().text()).toBe(200)
    expect(preview.headers.get('Cache-Control')).toBe('no-store')
    const result = await preview.text()
    expect(JSON.parse(result)).toMatchObject({ effectiveVersionId: versionId, inputNodes: 1, authorizedNodes: 1, outputNodes: 1, skippedNodes: 0, rendererVersion: '4', summary: { groups: 4, rules: 2 } })
    expect(result).not.toContain('ss.example.com')
    const singbox = await mutation(templateRoot + '/preview', admin, { profileId, versionId, platform: 'singbox', subscriptionId: subscription.id })
    expect(await singbox.json()).toMatchObject({ capability: 'full', effectiveVersionId: versionId })
    expect(await env.DB.prepare("SELECT profile_id FROM conversion_effective_bindings WHERE subscription_id=? AND platform='mihomo'")
      .bind(subscription.id).first()).toMatchObject({ profile_id: profileId })
    await env.DB.prepare('DELETE FROM subscription_template_bindings WHERE subscription_id=?').bind(subscription.id).run()
  })

  it('requires a verified remote rule source, uses conditional refresh and preserves the last successful version', async () => {
    const { admin } = await fixture()
    const url = 'https://raw.githubusercontent.com/example/rules/main/privacy.yaml'
    const source = { url, behavior: 'domain', format: 'yaml' }
    const draft = yaml.replace('  - MATCH,Policy', '  - RULE-SET,privacy,REJECT\n  - MATCH,Policy') +
      `rule-providers:\n  privacy: { type: http, behavior: domain, url: ${url} }\n`
    const saved = await mutation(templateRoot, admin, { name: 'Remote rules', yaml: draft })
    expect(saved.status).toBe(201)
    const { id, revision, draftHash } = await saved.json() as { id: string; revision: number; draftHash: string }
    const publish = () => mutation(`${templateRoot}/${id}/publish`, admin, { expectedRevision: revision, draftHash, singbox: true })
    expect(await (await publish()).json()).toMatchObject({
      error: { code: 'TEMPLATE_INVALID', details: { diagnostics: [{ code: 'RULE_SOURCE_UNVERIFIED', path: 'rule-providers.privacy' }] } },
    })
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => new Response('payload: ["+.example.org"]', { headers: { etag: '"one"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' } }))
      .mockImplementationOnce(async () => new Response(null, { status: 304 }))
      .mockImplementationOnce(async () => new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }))
    vi.stubGlobal('fetch', fetcher)
    const refresh = (input: typeof source) => mutation(templateRoot + '/rule-sources', admin, input)
    const record = () => env.DB.prepare('SELECT version,payload,last_success_at,error_code FROM conversion_rule_sources WHERE url=?').bind(url).first()
    expect((await refresh({ ...source, url: 'https://127.0.0.1/rules' })).status).toBe(422)
    expect(fetcher).not.toHaveBeenCalled()
    const firstRefresh = await refresh(source)
    expect(firstRefresh.status, await firstRefresh.clone().text()).toBe(200)
    const known = await record()
    expect((await refresh(source)).status).toBe(200)
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ 'If-None-Match': '"one"', 'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT' })
    const published = await publish()
    expect(published.status, await published.clone().text()).toBe(200)
    const version = await env.DB.prepare("SELECT target_version, compiled_json FROM conversion_profile_versions WHERE profile_id=? AND platform='singbox'")
      .bind(id).first<{ target_version: string; compiled_json: string }>()
    expect(version?.target_version).toBe('1.14')
    expect(JSON.parse(version!.compiled_json).route.rule_set).toEqual([
      { type: 'inline', tag: 'privacy', rules: [{ domain_suffix: ['example.org'] }] },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await refresh(source)).status).toBe(422)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await record()).toMatchObject({ version: known!.version, payload: known!.payload, error_code: 'REMOTE_TOO_MANY_REDIRECTS' })
  })

  it('publishes only verified pinned native sing-box rule sets', async () => {
    const { admin, token } = await fixture()
    const url = `https://raw.githubusercontent.com/example/rules/${'a'.repeat(40)}/sample.json`
    const draft = `subpanel:
  singbox:
    remoteRuleSets:
      - name: native
        outbound: DIRECT
        url: ${url}
` + yaml
    const saved = await mutation(templateRoot, admin, { name: 'Native rules', yaml: draft })
    expect(saved.status).toBe(201)
    const { id, revision, draftHash } = await saved.json() as { id: string; revision: number; draftHash: string }
    const publish = () => mutation(`${templateRoot}/${id}/publish`, admin, { expectedRevision: revision, draftHash, singbox: true })
    expect((await publish()).status).toBe(422)
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => Response.json({ version: 1, rules: [{ type: 'logical', rules: [{ domain: ['example.org'] }] }] }))
      .mockImplementationOnce(async () => Response.json({ version: 1, rules: [{ domain: ['example.org'] }] }))
    vi.stubGlobal('fetch', fetcher)
    const refresh = () => mutation(templateRoot + '/rule-sources', admin, { url, behavior: 'classical', format: 'text' })
    expect((await refresh()).status).toBe(422)
    const verified = await refresh()
    expect(verified.status, await verified.clone().text()).toBe(200)
    const published = await publish()
    expect(published.status, await published.clone().text()).toBe(200)
    expect((await mutation(templateRoot + '/default', admin, { templateId: id, expectedRevision: 1 }, 'PUT')).status).toBe(200)
    const publicConfig = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/singbox`)
    expect(publicConfig.status).toBe(200)
    expect(await publicConfig.json()).toMatchObject({
      route: { rule_set: [{ type: 'remote', tag: 'native', format: 'source', url }] },
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects a matching cached ETag after subscription expiry and explains zero nodes', async () => {
    const { admin, subscription, token } = await fixture()
    const url = `${TEST_ORIGIN}/sub/${token}/mihomo`
    const active = await exports.default.fetch(url)
    expect(active.status).toBe(200)
    const dates = await env.DB.prepare('SELECT id, starts_at, expires_at FROM subscriptions WHERE id=?')
      .bind(subscription.id).first<{ id: string; starts_at: number | null; expires_at: number | null }>()
    expect(dates).not.toBeNull()
    const setDates = (startsAt: number | null, expiresAt: number | null) => env.DB.prepare('UPDATE subscriptions SET starts_at=?, expires_at=?, enabled=1 WHERE id=?')
      .bind(startsAt, expiresAt, dates!.id).run()
    await setDates(Date.parse('2000-01-01'), Date.parse('2000-01-02'))
    try {
      const expired = await exports.default.fetch(url, { headers: { 'If-None-Match': active.headers.get('etag')! } })
      expect(expired.status).toBe(410)
      expect(await expired.json()).toMatchObject({ error: { code: 'SUB_EXPIRED' } })
      const preview = () => mutation(templateRoot + '/preview', admin, { subscriptionId: subscription.id, yaml })
      expect(await (await preview()).json()).toMatchObject({ outputNodes: 0, zeroNodeReason: 'expired', rules: expect.any(Array) })

      await setDates(dates!.starts_at, dates!.expires_at)
      const path = `/api/admin/subscriptions/${subscription.id}`
      expect((await mutation(path, admin, { enabled: false }, 'PATCH')).status).toBe(200)
      expect(await (await preview()).json()).toMatchObject({ outputNodes: 0, zeroNodeReason: 'disabled' })
      expect((await mutation(path, admin, { enabled: true, startsAt: Date.now() + 60_000 }, 'PATCH')).status).toBe(200)
      expect(await (await preview()).json()).toMatchObject({ outputNodes: 0, zeroNodeReason: 'pending' })
    } finally {
      await setDates(dates!.starts_at, dates!.expires_at)
    }
  })

  it('returns TEMPLATE_OUTPUT_INVALID when published policy storage is damaged', async () => {
    const { admin, token } = await fixture()
    const template = await createPolicy(admin)
    expect((await mutation(`${templateRoot}/${template.id}/publish`, admin, { expectedRevision: 1, draftHash: template.draftHash })).status).toBe(200)
    const current = await (await exports.default.fetch(TEST_ORIGIN + templateRoot, withCookie(admin))).json() as { defaultRevision: number }
    expect((await mutation(templateRoot + '/default', admin, { templateId: template.id, expectedRevision: current.defaultRevision }, 'PUT')).status).toBe(200)
    await env.DB.prepare('UPDATE subscription_template_versions SET yaml=? WHERE template_id=?').bind('malformed: true', template.id).run()
    const failed = await exports.default.fetch(`${TEST_ORIGIN}/sub/${token}/mihomo`)
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ error: { code: 'TEMPLATE_OUTPUT_INVALID' } })
    await mutation(templateRoot + '/default', admin, { templateId: null, expectedRevision: current.defaultRevision + 1 }, 'PUT')
  })

  it('returns conditional remote candidates and preserves the draft on failure', async () => {
    const admin = await login()
    const template = await createPolicy(admin)
    const path = `${templateRoot}/${template.id}`
    const url = 'https://policy.example/config.yaml?secret=private'
    const provider = yaml + `rule-providers:
  ads:
    type: http
    behavior: domain
    url: https://rules.example/ads.yaml
    path: ../client-chosen
`
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(provider, { headers: { ETag: '"v1"', 'Last-Modified': 'Sat, 01 Jan 2000 00:00:00 GMT' } }))
      .mockImplementationOnce(async () => new Response(null, { status: 304 }))
      .mockImplementationOnce(async () => new Response(null, { status: 302, headers: { Location: 'http://policy.example/plain' } }))
      .mockImplementationOnce(async () => new Response('x'.repeat(5 * 1024 * 1024 + 1)))
    vi.stubGlobal('fetch', fetcher)
    const runImport = (expectedRevision: number) => mutation(path + '/import', admin, { url, expectedRevision })

    const first = await runImport(1)
    expect(first.status, await first.clone().text()).toBe(200)
    const result = await first.json() as { source: object; candidate: { yaml: string } }
    expect(result).toMatchObject({
      source: { url, etag: '"v1"', lastModified: 'Sat, 01 Jan 2000 00:00:00 GMT' },
      candidate: { normalized: { 'rule-providers': { ads: { path: './rulesets/subpanel-616473.yaml' } } } },
    })
    const detail = () => exports.default.fetch(TEST_ORIGIN + path, withCookie(admin))
    expect(await (await detail()).json()).toMatchObject({ draft: yaml, revision: 1 })
    expect((await mutation(path, admin, { expectedRevision: 1, name: 'Policy', yaml: result.candidate.yaml, source: result.source }, 'PUT')).status).toBe(200)

    expect(await (await runImport(2)).json()).toMatchObject({ notModified: true })
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ 'If-None-Match': '"v1"', 'If-Modified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT' })
    expect((await runImport(2)).status).toBe(422)
    expect(await (await runImport(2)).json()).toMatchObject({ error: { code: 'REMOTE_BODY_TOO_LARGE' } })
    fetcher.mockImplementationOnce(async () => { throw new DOMException('timeout', 'TimeoutError') })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      expect(await (await runImport(2)).json()).toMatchObject({ error: { code: 'REMOTE_TIMEOUT' } })
      expect(timeout).toHaveBeenCalledWith(10_000)
    } finally {
      timeout.mockRestore()
    }
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(await (await detail()).json()).toMatchObject({ draft: provider, revision: 2, publishedVersionId: null })
    const audits = await env.DB.prepare('SELECT detail FROM audit_logs').all<{ detail: string }>()
    expect(JSON.stringify(audits.results)).not.toContain('secret=private')
  })

  it('fetches a new template URL once and persists it only on the following create', async () => {
    const admin = await login()
    const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM subscription_templates').first<{ count: number }>()
    const url = 'https://policy.example/once.yaml?secret=one-save'
    const fetcher = vi.fn<typeof fetch>(async () => new Response(yaml, { headers: { ETag: '"once"' } }))
    vi.stubGlobal('fetch', fetcher)

    const preview = await mutation(templateRoot + '/import', admin, { url })
    expect(preview.status, await preview.clone().text()).toBe(200)
    const result = await preview.json() as { candidate: { yaml: string }; source: { url: string; etag: string | null; fetchedAt: string } }
    expect(result.candidate.yaml).toBe(yaml)
    expect(result.source).toMatchObject({ url, etag: '"once"' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const during = await env.DB.prepare('SELECT COUNT(*) AS count FROM subscription_templates').first<{ count: number }>()
    expect(during?.count).toBe(before?.count)

    const created = await mutation(templateRoot, admin, { name: 'Imported once', yaml: result.candidate.yaml, source: result.source })
    expect(created.status, await created.clone().text()).toBe(201)
    const body = await created.json() as { id: string; revision: number }
    expect(body.revision).toBe(1)
    const detail = await exports.default.fetch(TEST_ORIGIN + `${templateRoot}/${body.id}`, withCookie(admin))
    expect(await detail.json()).toMatchObject({ draft: yaml, revision: 1, sourceUrl: url })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const calls = fetcher.mock.calls.length
    const rejected = await mutation(templateRoot + '/import', admin, { url: 'http://policy.example/plain.yaml' })
    expect(rejected.status).toBe(422)
    expect(fetcher).toHaveBeenCalledTimes(calls)
    const audits = await env.DB.prepare('SELECT detail FROM audit_logs').all<{ detail: string }>()
    expect(JSON.stringify(audits.results)).not.toContain('secret=one-save')
  })
})
