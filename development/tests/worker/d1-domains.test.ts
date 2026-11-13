import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSetting } from '../../../worker/db/settings-repository'
import { invalidateGateCache } from '../../../worker/domains/service'
import { applyMigrations } from './d1'
import {
  enableD1Modules,
  jsonRequest,
  login,
  resetData,
  setupAdmin,
  TEST_ORIGIN,
  withCookie,
} from './helpers'

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)
const fetchHost = (host: string, path: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://${host}${path}`, init)

type DomainBody = {
  id: string
  hostname: string
  enabled: boolean
  verificationStatus: string
  verifiedAt: string | null
  lastCheckAt: string | null
  lastCheckError: string | null
  note: string
}

let adminCookie: string

async function resetRestriction() {
  await env.DB
    .prepare("UPDATE system_settings SET value = 'false' WHERE key = 'domain_restriction_enabled'")
    .run()
  invalidateGateCache(env.DB)
}

// applyMigrations is idempotent and never re-seeds, so restore the exact
// migration-0007 seed state explicitly: several tests mutate these tables.
const SEED_NOW = '2026-01-01T00:00:00.000Z'
async function reseedDomains() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM panel_domains'),
    env.DB.prepare('DELETE FROM subscription_domains'),
    env.DB.prepare('DELETE FROM subscription_platform_settings'),
    env.DB.prepare(
      `INSERT INTO panel_domains (id, hostname, enabled, verification_status, verified_at, last_check_at, last_check_error, note, created_at, updated_at)
       VALUES ('dom_panel_primary', 'sub.warp.dpdns.org', 1, 'verified', ?, ?, NULL, '现网域名（迁移预置）', ?, ?)`,
    ).bind(SEED_NOW, SEED_NOW, SEED_NOW, SEED_NOW),
    env.DB.prepare(
      `INSERT INTO subscription_domains (id, hostname, enabled, verification_status, verified_at, last_check_at, last_check_error, note, created_at, updated_at)
       VALUES ('dom_sub_primary', 'sub.warp.dpdns.org', 1, 'verified', ?, ?, NULL, '现网域名（迁移预置）', ?, ?)`,
    ).bind(SEED_NOW, SEED_NOW, SEED_NOW, SEED_NOW),
    env.DB.prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES
         ('primary_panel_domain_id', '"dom_panel_primary"', ?),
         ('primary_subscription_domain_id', '"dom_sub_primary"', ?),
         ('domain_restriction_enabled', 'false', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(SEED_NOW, SEED_NOW, SEED_NOW),
    ...([
      ['auto', '自动识别', 0], ['mihomo', 'Mihomo', 10], ['clash', 'Clash', 20],
      ['clash-meta', 'Clash Meta', 30], ['stash', 'Stash', 40], ['singbox', 'sing-box', 50],
      ['karing', 'Karing', 60], ['surge', 'Surge', 70], ['loon', 'Loon', 80],
      ['quantumultx', 'Quantumult X', 90], ['v2rayn', 'v2rayN', 100],
      ['nekobox', 'NekoBox', 110], ['shadowrocket', 'Shadowrocket', 120],
    ] as Array<[string, string, number]>).map(([platform, displayName, sortOrder]) =>
      env.DB.prepare(
        'INSERT INTO subscription_platform_settings (platform, display_name, enabled, sort_order, updated_at) VALUES (?, ?, 1, ?, ?)',
      ).bind(platform, displayName, sortOrder, SEED_NOW),
    ),
  ])
  invalidateGateCache(env.DB)
}

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await reseedDomains()
  await setupAdmin()
  adminCookie = await login()
})

afterEach(() => vi.unstubAllGlobals())

const adminJson = async (path: string, init: RequestInit = {}) => {
  const response = await fetchApi(path, withCookie(adminCookie, init))
  return { response, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

describe('domain stage seeds', () => {
  it('seeds the platform settings in page order, all enabled', async () => {
    const rows = await env.DB
      .prepare('SELECT platform, enabled FROM subscription_platform_settings ORDER BY sort_order')
      .all<{ platform: string; enabled: number }>()
    expect(rows.results.map((row) => row.platform)).toEqual([
      'auto', 'mihomo', 'clash', 'clash-meta', 'stash', 'singbox', 'karing',
      'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket',
    ])
    expect(rows.results.every((row) => row.enabled === 1)).toBe(true)
  })

  it('presets the live hostname as verified primary on both sides with restriction off', async () => {
    const { body } = await adminJson('/api/admin/system/domains')
    const panel = body.panel as DomainBody[]
    const subscription = body.subscription as DomainBody[]
    expect(panel).toHaveLength(1)
    expect(panel[0]).toMatchObject({
      id: 'dom_panel_primary',
      hostname: 'sub.warp.dpdns.org',
      enabled: true,
      verificationStatus: 'verified',
    })
    expect(subscription).toHaveLength(1)
    expect(subscription[0]).toMatchObject({
      id: 'dom_sub_primary',
      hostname: 'sub.warp.dpdns.org',
      enabled: true,
      verificationStatus: 'verified',
    })
    expect(body.primaryPanelDomainId).toBe('dom_panel_primary')
    expect(body.primarySubscriptionDomainId).toBe('dom_sub_primary')
    expect(body.restrictionEnabled).toBe(false)
    expect(await getSetting(env.DB, 'domain_restriction_enabled')).toBe('false')
  })

  it('requires an admin session for the domain list', async () => {
    const anonymous = await fetchApi('/api/admin/system/domains')
    expect(anonymous.status).toBe(401)
  })
})

describe('instance identity endpoint', () => {
  it('answers without auth and stays stable across calls', async () => {
    const first = await fetchApi('/api/system/instance')
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { instanceId: string }
    expect(firstBody.instanceId).toMatch(/^ins_[0-9a-f]{32}$/)
    const second = await fetchApi('/api/system/instance')
    expect(((await second.json()) as { instanceId: string }).instanceId).toBe(firstBody.instanceId)
  })
})

describe('subscription platform display settings', () => {
  it('round-trips order and visibility, and the user view only lists enabled platforms', async () => {
    const initial = await adminJson('/api/admin/system/subscription-platforms')
    const platforms = initial.body.platforms as Array<{ platform: string; displayName: string; enabled: boolean }>
    expect(platforms).toHaveLength(13)
    expect(platforms[0]).toMatchObject({ platform: 'auto', displayName: '自动识别', enabled: true })

    const reordered = [...platforms]
      .map((entry) => ({ platform: entry.platform, enabled: entry.platform !== 'surge' }))
      .sort((a, b) => (a.platform === 'shadowrocket' ? -1 : b.platform === 'shadowrocket' ? 1 : 0))
    const put = await fetchApi(
      '/api/admin/system/subscription-platforms',
      withCookie(adminCookie, jsonRequest({ platforms: reordered }, { method: 'PUT' })),
    )
    expect(put.status).toBe(200)

    const userView = await fetchApi('/api/account/subscription-platforms', withCookie(adminCookie))
    expect(userView.status).toBe(200)
    const userPlatforms = ((await userView.json()) as { platforms: Array<{ platform: string; displayName: string }> }).platforms
    expect(userPlatforms.map((entry) => entry.platform)).not.toContain('surge')
    expect(userPlatforms[0]).toEqual({ platform: 'shadowrocket', displayName: 'Shadowrocket' })
    expect(userPlatforms).toHaveLength(12)

    const anonymous = await fetchApi('/api/account/subscription-platforms')
    expect(anonymous.status).toBe(401)
  })

  it('rejects unknown, duplicated or incomplete platform lists', async () => {
    const initial = await adminJson('/api/admin/system/subscription-platforms')
    const platforms = (initial.body.platforms as Array<{ platform: string }>).map((entry) => ({
      platform: entry.platform,
      enabled: true,
    }))
    const putList = (list: Array<{ platform: string; enabled: boolean }>) =>
      fetchApi('/api/admin/system/subscription-platforms', withCookie(adminCookie, jsonRequest({ platforms: list }, { method: 'PUT' })))

    expect((await putList([...platforms.slice(1), { platform: 'unknown-client', enabled: true }])).status).toBe(422)
    expect((await putList([...platforms, { platform: 'auto', enabled: true }])).status).toBe(422)
    expect((await putList(platforms.slice(1))).status).toBe(422)
  })
})

describe('domain CRUD and verification rules', () => {
  const createDomain = (kind: string, hostname: string, note?: string) =>
    adminJson(`/api/admin/system/domains/${kind}`, jsonRequest({ hostname, note }))

  it('validates hostnames, normalizes case and rejects duplicates per table', async () => {
    for (const bad of ['https://example.com', 'localhost', 'exa mple.com', 'example.com:8080', 'example.com/path', '-bad.com', 'bad-.com']) {
      const { response } = await createDomain('panel', bad)
      expect(response.status, bad).toBe(422)
    }
    const created = await createDomain('panel', '  Example.COM ', '主站')
    expect(created.response.status).toBe(201)
    const domain = created.body.domain as DomainBody
    expect(domain.hostname).toBe('example.com')
    expect(domain).toMatchObject({ enabled: false, verificationStatus: 'pending', note: '主站' })

    const duplicate = await createDomain('panel', 'example.com')
    expect(duplicate.response.status).toBe(409)
    // The other table is independent: the same hostname may live there too.
    const otherSide = await createDomain('subscription', 'example.com')
    expect(otherSide.response.status).toBe(201)
  })

  it('blocks enabling or promoting unverified domains', async () => {
    const created = await createDomain('panel', 'pending.example.com')
    const id = (created.body.domain as DomainBody).id

    const enable = await adminJson(`/api/admin/system/domains/panel/${id}`, jsonRequest({ enabled: true }, { method: 'PATCH' }))
    expect(enable.response.status).toBe(422)
    expect((enable.body.error as { code: string }).code).toBe('DOMAIN_NOT_VERIFIED')

    const promote = await fetchApi(`/api/admin/system/domains/panel/${id}/primary`, withCookie(adminCookie, jsonRequest({})))
    expect(promote.status).toBe(422)
  })

  it('verifies through one manual request and then allows enable + primary', async () => {
    const instance = (await (await fetchApi('/api/system/instance')).json()) as { instanceId: string }
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ instanceId: instance.instanceId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const created = await createDomain('subscription', 'verify.example.com')
    const id = (created.body.domain as DomainBody).id
    const verified = await fetchApi(`/api/admin/system/domains/subscription/${id}/verify`, withCookie(adminCookie, jsonRequest({})))
    expect(verified.status).toBe(200)
    const domain = ((await verified.json()) as { domain: DomainBody }).domain
    expect(domain.verificationStatus).toBe('verified')
    expect(domain.verifiedAt).not.toBeNull()
    expect(seen).toEqual(['https://verify.example.com/api/system/instance'])

    const enable = await adminJson(`/api/admin/system/domains/subscription/${id}`, jsonRequest({ enabled: true }, { method: 'PATCH' }))
    expect(enable.response.status).toBe(200)
    const promote = await fetchApi(`/api/admin/system/domains/subscription/${id}/primary`, withCookie(adminCookie, jsonRequest({})))
    expect(promote.status).toBe(200)
    const list = await adminJson('/api/admin/system/domains')
    expect(list.body.primarySubscriptionDomainId).toBe(id)
  })

  it('records failed verification outcomes without throwing', async () => {
    const created = await createDomain('panel', 'unit.example.com')
    const id = (created.body.domain as DomainBody).id
    const { verifyDomain } = await import('../../../worker/domains/service')

    const mismatch = await verifyDomain(env.DB, 'panel', id, async () =>
      new Response(JSON.stringify({ instanceId: 'ins_00000000000000000000000000000000' }), { status: 200 }))
    expect(mismatch.verificationStatus).toBe('failed')
    expect(mismatch.lastCheckError).toContain('不一致')
    expect(mismatch.lastCheckAt).not.toBeNull()

    const httpError = await verifyDomain(env.DB, 'panel', id, async () => new Response('nope', { status: 404 }))
    expect(httpError.verificationStatus).toBe('failed')
    expect(httpError.lastCheckError).toContain('HTTP 404')

    const networkError = await verifyDomain(env.DB, 'panel', id, async () => {
      throw new Error('connection refused')
    })
    expect(networkError.verificationStatus).toBe('failed')
    expect(networkError.lastCheckError).toContain('connection refused')
  })

  it('protects the primary domain from deletion and disabling', async () => {
    const del = await fetchApi('/api/admin/system/domains/panel/dom_panel_primary', withCookie(adminCookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }))
    expect(del.status).toBe(409)
    const disable = await adminJson('/api/admin/system/domains/panel/dom_panel_primary', jsonRequest({ enabled: false }, { method: 'PATCH' }))
    expect(disable.response.status).toBe(409)

    const created = await createDomain('panel', 'spare.example.com')
    const id = (created.body.domain as DomainBody).id
    const removed = await fetchApi(`/api/admin/system/domains/panel/${id}`, withCookie(adminCookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }))
    expect(removed.status).toBe(204)
    const missing = await fetchApi(`/api/admin/system/domains/panel/${id}/verify`, withCookie(adminCookie, jsonRequest({})))
    expect(missing.status).toBe(404)
  })
})

describe('delivery links and share links', () => {
  beforeEach(async () => {
    await resetData()
    await enableD1Modules()
    await reseedDomains()
    await setupAdmin()
    adminCookie = await login()
  })

  const ssLine = (name: string, host = 'ss.example.com') =>
    `ss://${btoa('aes-128-gcm:password')}@${host}:8388#${encodeURIComponent(name)}`

  async function createSubscription(): Promise<{ id: string; token: string; links: Record<string, string>; linkError: string | null }> {
    const sourceResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/sources`,
      jsonRequest({ type: 'manual', name: 'Domain source', content: ssLine('Domain node') }, withCookie(adminCookie)),
    )
    const sourceId = ((await sourceResponse.json()) as { source: { id: string } }).source.id
    const catalog = (await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(adminCookie))).json()) as { nodes: Array<{ id: string }> }
    const groupResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups`,
      jsonRequest({ name: 'Domain group', sourceIds: [sourceId], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [catalog.nodes[0].id] }, withCookie(adminCookie)),
    )
    const groupId = ((await groupResponse.json()) as { group: { id: string } }).group.id
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: 'usr_1', name: '域名订阅', groupIds: [groupId], defaultClient: 'mihomo' }, withCookie(adminCookie)),
    )
    expect(created.status).toBe(201)
    const body = (await created.json()) as {
      subscription: { id: string; links: Record<string, string>; linkError: string | null }
      token: string
    }
    return { id: body.subscription.id, token: body.token, links: body.subscription.links, linkError: body.subscription.linkError }
  }

  it('generates subscription and share links on the primary subscription domain', async () => {
    const subscription = await createSubscription()
    expect(subscription.linkError).toBeNull()
    expect(subscription.links.mihomo).toBe(`https://sub.warp.dpdns.org/sub/${subscription.token}/mihomo`)
    expect(subscription.links.auto).toBe(`https://sub.warp.dpdns.org/sub/${subscription.token}`)

    const shareResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares`,
      jsonRequest({ subscriptionId: subscription.id, allowOriginalLink: true }, withCookie(adminCookie)),
    )
    expect(shareResponse.status).toBe(201)
    const shareBody = (await shareResponse.json()) as { share: { id: string }; token: string; linkBaseUrl: string | null }
    expect(shareBody.linkBaseUrl).toBe('https://sub.warp.dpdns.org')

    const metaResponse = await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${shareBody.token}/meta`)
    expect(metaResponse.status).toBe(200)
    expect(((await metaResponse.json()) as { linkBaseUrl: string | null }).linkBaseUrl).toBe('https://sub.warp.dpdns.org')

    const reveal = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${shareBody.share.id}/reveal`,
      jsonRequest({}, withCookie(adminCookie)),
    )
    expect(reveal.status).toBe(200)
    const link = ((await reveal.json()) as { link: string }).link
    expect(link).toBe(`https://sub.warp.dpdns.org/sub/${subscription.token}`)
  })

  it('reports a recognizable error instead of falling back to the request host', async () => {
    const subscription = await createSubscription()
    await env.DB.prepare('DELETE FROM subscription_domains').run()
    await env.DB.prepare("DELETE FROM system_settings WHERE key = 'primary_subscription_domain_id'").run()

    const list = await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscriptions`, withCookie(adminCookie))
    expect(list.status).toBe(200)
    const body = (await list.json()) as { subscriptions: Array<{ id: string; links: Record<string, string>; linkError: string | null }> }
    const mine = body.subscriptions.find((entry) => entry.id === subscription.id)
    expect(mine).toBeDefined()
    expect(mine!.links).toEqual({})
    expect(mine!.linkError).toBe('SUBSCRIPTION_DOMAIN_NOT_CONFIGURED')
  })
})

describe('host gate', () => {
  it('stays off by default, enforces per class when on, and fails safe on empty tables', async () => {
    // Default off: any host is served.
    const offPanel = await fetchHost('anything.example.com', '/api/account/subscription-platforms', withCookie(adminCookie))
    expect(offPanel.status).toBe(200)

    const toggle = await fetchApi(
      '/api/admin/system/domain-restriction',
      withCookie(adminCookie, jsonRequest({ enabled: true }, { method: 'PUT' })),
    )
    expect(toggle.status).toBe(200)

    // Panel class: the seeded panel domain passes, other hosts get 404.
    const allowedPanel = await fetchHost('sub.warp.dpdns.org', '/api/account/subscription-platforms', withCookie(adminCookie))
    expect(allowedPanel.status).toBe(200)
    const blockedPanel = await fetchApi('/api/account/subscription-platforms', withCookie(adminCookie))
    expect(blockedPanel.status).toBe(404)
    expect(((await blockedPanel.json()) as { error: { code: string } }).error.code).toBe('DOMAIN_NOT_ALLOWED')

    // X-Forwarded-Host is never trusted.
    const spoofed = await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscription-platforms`, {
      headers: { cookie: adminCookie, 'x-forwarded-host': 'sub.warp.dpdns.org' },
    })
    expect(spoofed.status).toBe(404)

    // Health and instance endpoints stay reachable from any host.
    expect((await fetchHost('anything.example.com', '/api/health')).status).toBe(200)
    expect((await fetchHost('anything.example.com', '/api/system/instance')).status).toBe(200)

    // Subscription class: allowed on the seeded subscription domain,
    // blocked elsewhere with the gate code (not the subscription 404).
    const blockedSub = await exports.default.fetch(`${TEST_ORIGIN}/sub/some-token`)
    expect(blockedSub.status).toBe(404)
    expect(((await blockedSub.json()) as { error: { code: string } }).error.code).toBe('DOMAIN_NOT_ALLOWED')
    const allowedSub = await fetchHost('sub.warp.dpdns.org', '/sub/some-token')
    expect(allowedSub.status).toBe(404)
    expect(((await allowedSub.json()) as { error: { code: string } }).error.code).not.toBe('DOMAIN_NOT_ALLOWED')

    // Empty enabled set for a class disables that class gate (no lockout).
    await env.DB.prepare('DELETE FROM panel_domains').run()
    await env.DB.prepare("DELETE FROM system_settings WHERE key = 'primary_panel_domain_id'").run()
    invalidateGateCache(env.DB)
    const fallbackPanel = await fetchApi('/api/account/subscription-platforms', withCookie(adminCookie))
    expect(fallbackPanel.status).toBe(200)

    // Turning the switch off restores every host (cleanup for other tests).
    await resetRestriction()
    const restored = await fetchHost('anything.example.com', '/api/account/subscription-platforms', withCookie(adminCookie))
    expect(restored.status).toBe(200)
  })
})
