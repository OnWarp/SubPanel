import { createHash, createHmac } from 'node:crypto'
import { encodeProof, verifyDomain, type DomainProof } from '../../../worker/domains/verification'
import { DOMAIN_VERIFY_PATH, VERIFY_FAILURES } from '../../../worker/domains/verification-contract'
import { signHmac } from '../../../worker/platform/crypto'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getSetting } from '../../../worker/db/settings-repository'
import { DomainService, invalidateGateCache, normalizeHostname } from '../../../worker/domains/domain-service'
import { applyMigrations } from './d1'
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  bindFixtureTemplate,
  createFixtureAccount,
  setupContractedAdmin,
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

const SEED_NOW = '2026-01-01T00:00:00.000Z'
async function reseedDomains() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM domains'),
    env.DB.prepare('DELETE FROM subscription_platform_settings'),
    env.DB.prepare(`INSERT INTO domains (id, hostname, verification_status, verified_at, last_checked_at, created_at, updated_at)
      VALUES ('fixture', 'sub.warp.dpdns.org', 'verified', ?, ?, ?, ?)`).bind(SEED_NOW, SEED_NOW, SEED_NOW, SEED_NOW),
    ...(['panel', 'subscription'] as const).map(purpose => env.DB.prepare(
      `INSERT INTO domain_bindings (id, domain_id, purpose, enabled, is_primary, created_at, updated_at)
      VALUES (?, 'fixture', ?, 1, 1, ?, ?)`,
    ).bind(purpose === 'panel' ? 'dom_panel_primary' : 'dom_sub_primary', purpose, SEED_NOW, SEED_NOW)),
    env.DB.prepare(`INSERT INTO system_settings (key, value, updated_at)
      VALUES ('domain_restriction_enabled', 'false', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(SEED_NOW),
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

const domainPath = '/api/admin/system/domains'

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
    await createFixtureAccount('domainreader', 'test-password-123')
    const cookie = await login('domainreader', 'test-password-123')
    const forbidden = await fetchApi('/api/admin/system/domains', withCookie(cookie))
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })
})

describe('instance identity endpoint', () => {
  it('answers without auth and stays stable across calls', async () => {
    const first = await fetchApi('/api/system/instance')
    expect(first.status).toBe(200)
    expect(first.headers.get('access-control-allow-origin')).toBe('*')
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

  it('validates hostnames, normalizes case and rejects duplicates per purpose', async () => {
    for (const bad of ['https://example.com', 'localhost', 'exa mple.com', 'example.com:8080', 'example.com/path', '-bad.com', 'bad-.com']) {
      const { response } = await createDomain('panel', bad)
      expect(response.status, bad).toBe(400)
    }
    const created = await createDomain('panel', '  Example.COM ', '主站')
    expect(created.response.status).toBe(201)
    const domain = created.body.domain as DomainBody
    expect(domain.hostname).toBe('example.com')
    expect(domain).toMatchObject({ enabled: false, verificationStatus: 'pending', note: '主站' })

    const duplicate = await createDomain('panel', 'example.com')
    expect(duplicate.response.status).toBe(409)
    const otherSide = await createDomain('subscription', 'example.com')
    expect(otherSide.response.status).toBe(201)
    expect(await env.DB.prepare("SELECT count(*) AS total FROM domains WHERE hostname = 'example.com'").first()).toEqual({ total: 1 })
    const filtered = await adminJson('/api/admin/system/domains?purpose=subscription')
    expect(filtered.body.domains).toEqual(expect.arrayContaining([expect.objectContaining({
      hostname: 'example.com', purpose: 'subscription', isPrimary: false, health: 'pending',
    })]))
  })

  it('blocks enabling or promoting unverified domains', async () => {
    const created = await createDomain('panel', 'pending.example.com')
    const id = (created.body.domain as DomainBody).id

    const enable = await adminJson(`/api/admin/system/domains/panel/${id}`, jsonRequest({ enabled: true }, { method: 'PATCH' }))
    expect(enable.response.status).toBe(409)
    expect((enable.body.error as { code: string }).code).toBe('NOT_VERIFIED')

    const promote = await fetchApi(`/api/admin/system/domains/panel/${id}/primary`, withCookie(adminCookie, jsonRequest({})))
    expect(promote.status).toBe(409)
  })

  type Challenge = { nonce: string; expiresAt: string; challengeId: string }

  const issue = async (path: string) => {
    const { response, body } = await adminJson(`${path}/challenge`, { method: 'POST', headers: { origin: TEST_ORIGIN } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return body.challenge as Challenge
  }
  const probePath = ({ nonce }: Challenge) => `${DOMAIN_VERIFY_PATH}?challenge=${nonce}`
  const getProof = async (host: string, challenge: Challenge) => {
    const response = await fetchHost(host, probePath(challenge))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    return response.json<DomainProof>()
  }
  const verify = (path: string, input: unknown) => adminJson(`${path}/verify`, jsonRequest(input))
  const failureIs = async (path: string, input: unknown, reason: string) => {
    const result = await verify(path, input)
    expect(result.response.status).toBe(422)
    expect(result.body.error).toEqual({ code: 'VERIFY_FAILED', message: '域名验证失败', details: { reason } })
  }

  it('signs HTTP challenges, consumes once under concurrency, and auto-promotes the first enable', async () => {
    const host = 'verify.example.com'
    const { body } = await createDomain('subscription', host)
    const path = `${domainPath}/subscription/${(body.domain as DomainBody).id}`
    const old = await issue(path)
    const challenge = await issue(path)
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(Date.parse(challenge.expiresAt) - Date.now()).toBeGreaterThan(110_000)
    expect(await env.DB.prepare('SELECT challenge_hash, consumed_at FROM domain_verification_challenges WHERE id = ?')
      .bind(challenge.challengeId).first()).toEqual({
      challenge_hash: createHash('sha256').update(challenge.nonce).digest('hex'), consumed_at: null,
    })
    expect((await fetchHost(host, probePath(old))).status).toBe(404)
    const proof = await getProof(host, challenge)
    const instance = await (await fetchApi('/api/system/instance')).json<{ instanceId: string }>()
    expect(proof).toEqual({
      version: 1, hostname: host, challengeId: challenge.challengeId, expiresAt: challenge.expiresAt,
      instanceId: instance.instanceId, signature: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    })
    expect((await getProof(host, challenge)).signature).toBe(proof.signature)

    const results = await Promise.all([verify(path, { proof }), verify(path, { proof })])
    const verified = results.find(result => result.response.status === 200)
    expect(verified?.body.domain).toMatchObject({
      verificationStatus: 'verified', verifiedAt: expect.any(String), enabled: false, isPrimary: false, lastCheckError: null,
    })
    expect(results.find(result => result.response.status === 422)?.body.error)
      .toMatchObject({ details: { reason: 'CHALLENGE_INVALID' } })
    expect((await fetchHost(host, probePath(challenge))).status).toBe(404)
    expect(await env.DB.prepare('SELECT count(*) AS total FROM domain_verification_challenges WHERE consumed_at IS NULL').first())
      .toEqual({ total: 0 })

    const other = await createDomain('panel', host)
    expect(other.body.domain).toMatchObject({ verificationStatus: 'verified', enabled: false })
    const service = new DomainService(env.DB)
    await env.DB.prepare("DELETE FROM domain_bindings WHERE id = 'dom_sub_primary'").run()
    const enable = await adminJson(path, jsonRequest({ enabled: true }, { method: 'PATCH' }))
    expect(enable.body).toMatchObject({ autoPrimary: true, domain: { isPrimary: true, enabled: true } })
    expect(await service.buildSubscriptionUrl('fixture', 'clash')).toBe('https://verify.example.com/sub/fixture/clash')
    expect(await service.buildSubscriptionUrl('fixture')).toBe('https://verify.example.com/sub/fixture')
    expect(await service.buildPanelUrl('/invite/code')).toBe('https://sub.warp.dpdns.org/invite/code')
    const audit = await env.DB.prepare("SELECT detail FROM audit_logs WHERE action LIKE 'domain.%'").all<{ detail: string }>()
    expect(audit.results.some(row => JSON.parse(row.detail).autoPrimary)).toBe(true)
    expect(audit.results.some(row => JSON.parse(row.detail).challengeId === challenge.challengeId)).toBe(true)
    expect(JSON.stringify(audit.results)).not.toContain(challenge.nonce)
    expect(JSON.stringify(audit.results)).not.toContain(proof.signature)
  })

  it('only allows an exact GET probe on the challenge hostname while the gate is enabled', async () => {
    const host = 'pending.example.com'
    const { body } = await createDomain('panel', host)
    const path = `${domainPath}/panel/${(body.domain as DomainBody).id}`
    const challenge = await issue(path)
    await adminJson('/api/admin/system/domain-restriction', jsonRequest({ enabled: true }, { method: 'PUT' }))
    await getProof(host, challenge)
    expect(await (await fetchHost(host, '/login')).json()).toMatchObject({ error: { code: 'DOMAIN_NOT_ALLOWED' } })
    const invalid = [
      fetchHost('wrong.example.com', probePath(challenge), { headers: { 'X-Forwarded-Host': host } }),
      fetchHost(host, probePath(challenge), { method: 'POST' }),
      fetchHost(host, `${DOMAIN_VERIFY_PATH}/?challenge=${challenge.nonce}`, { headers: { Accept: 'text/html' } }),
      fetchHost(host, `${DOMAIN_VERIFY_PATH}/nested?challenge=${challenge.nonce}`),
      fetchHost(host, `${probePath(challenge)}&other=1`),
      fetchHost(host, `${probePath(challenge)}&challenge=${challenge.nonce}`),
      fetchHost(host, DOMAIN_VERIFY_PATH),
    ]
    for (const response of await Promise.all(invalid)) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } })
    }
    expect((await fetchHost(host, probePath(challenge), { method: 'HEAD' })).status).toBe(404)
  })

  it('rejects legacy, expired, cross-domain, malformed and forged proofs', async () => {
    const host = 'sub.warp.dpdns.org'
    const path = `${domainPath}/panel/dom_panel_primary`
    const other = await createDomain('panel', 'other.example.com')
    const otherPath = `${domainPath}/panel/${(other.body.domain as DomainBody).id}`
    const first = await issue(path)
    const proof = await getProof(host, first)
    await failureIs(otherPath, { proof }, 'CHALLENGE_INVALID')
    await failureIs(path, { proof: { ...proof, signature: 'A'.repeat(43) } }, 'PROOF_INVALID')
    const binding = await new DomainService(env.DB).get('panel', 'dom_panel_primary')
    expect(binding).toMatchObject({
      verificationStatus: 'failed', verifiedAt: SEED_NOW, enabled: true, isPrimary: true,
      lastCheckAt: expect.any(String), lastCheckError: 'PROOF_INVALID',
    })
    const wrongInstance = await getProof(host, await issue(path))
    await failureIs(path, { proof: { ...wrongInstance, instanceId: 'another-instance' } }, 'INSTANCE_MISMATCH')
    const expired = await issue(path)
    const expiredProof = await getProof(host, expired)
    await env.DB.prepare('UPDATE domain_verification_challenges SET created_at = ?, expires_at = ? WHERE id = ?')
      .bind('2025-01-01T00:00:00.000Z', '2025-01-01T00:02:00.000Z', expired.challengeId).run()
    expect((await fetchHost(host, probePath(expired))).status).toBe(404)
    await failureIs(path, { proof: expiredProof }, 'CHALLENGE_EXPIRED')
    const legacy = await issue(path)
    await env.DB.prepare('UPDATE domain_verification_challenges SET created_at = ? WHERE id = ?')
      .bind('2025-01-01T00:00:00.000Z', legacy.challengeId).run()
    expect((await fetchHost(host, probePath(legacy))).status).toBe(404)
    await failureIs(path, { proof: { ...proof, challengeId: legacy.challengeId } }, 'CHALLENGE_INVALID')
    const malformed = await issue(path)
    await failureIs(path, { proof: { challengeId: malformed.challengeId } }, 'PROOF_INVALID')
    const failedProbe = await issue(path)
    await failureIs(path, { challengeId: failedProbe.challengeId, reason: 'PROBE_FAILED' }, 'PROBE_FAILED')
    const unavailable = await issue(path)
    const unavailableProof = await getProof(host, unavailable)
    const missingKey = { get: async () => null } as unknown as KVNamespace
    expect(await verifyDomain({ ...env, DATA: missingKey }, 'panel', 'dom_panel_primary', { proof: unavailableProof }))
      .toMatchObject({ failure: 'TIMEOUT', domain: { lastCheckError: 'TIMEOUT' } })
    expect(VERIFY_FAILURES).toEqual([
      'CHALLENGE_EXPIRED', 'CHALLENGE_INVALID', 'PROOF_INVALID', 'INSTANCE_MISMATCH', 'PROBE_FAILED', 'TIMEOUT',
    ])
    expect(await new DomainService(env.DB).buildPanelUrl('/login')).toBe(`https://${host}/login`)
    await adminJson('/api/admin/system/domain-restriction', jsonRequest({ enabled: true }, { method: 'PUT' }))
    expect((await fetchHost(host, '/api/account/subscription-platforms', withCookie(adminCookie))).status).toBe(200)
  })

  it('limits admin verification separately from the public probe', async () => {
    const host = 'limited.example.com'
    const { body } = await createDomain('panel', host)
    const path = `${domainPath}/panel/${(body.domain as DomainBody).id}`
    const challenge = await issue(path)
    const probes = await Promise.all(Array.from({ length: 61 }, () => fetchHost(host, probePath(challenge), { headers: { 'CF-Connecting-IP': '192.0.2.42' } })))
    expect(probes.filter(response => response.status === 200)).toHaveLength(60)
    expect(probes.filter(response => response.status === 404)).toHaveLength(1)
    const proof = await probes.find(response => response.ok)!.json<DomainProof>()
    expect((await verify(path, { proof })).response.status).toBe(200)
    const attempts = await Promise.all(Array.from({ length: 10 }, () => verify(path, { proof })))
    expect(attempts.map(({ response }) => response.status).sort()).toEqual([...Array(9).fill(422), 429])
  })

  it('keeps one primary when enabled bindings are concurrently promoted', async () => {
    const service = new DomainService(env.DB)
    const bindings = await Promise.all(['one.example.com', 'two.example.com'].map(hostname => service.create('panel', { hostname })))
    await env.DB.prepare("UPDATE domains SET verification_status = 'verified'").run()
    await expect(service.update('panel', bindings[0].id, { enabled: true })).rejects.toMatchObject({ code: 'NOT_VERIFIED' })
    await expect(service.setPrimary('panel', bindings[0].id)).rejects.toMatchObject({ code: 'NOT_VERIFIED' })
    await env.DB.prepare('UPDATE domains SET verified_at = ?').bind(SEED_NOW).run()
    await expect(service.setPrimary('panel', bindings[0].id)).rejects.toMatchObject({ code: 'DOMAIN_DISABLED' })
    await Promise.all(bindings.map(binding => service.update('panel', binding.id, { enabled: true })))
    const [results, snapshots] = await Promise.all([
      Promise.allSettled(bindings.map(binding => service.setPrimary('panel', binding.id))),
      Promise.all(Array.from({ length: 12 }, () => service.list('panel'))),
    ])
    expect(snapshots.every(snapshot => snapshot.filter(binding => binding.isPrimary).length === 1)).toBe(true)
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } })
    expect((await service.list('panel')).filter(binding => binding.isPrimary)).toHaveLength(1)
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
    await setupContractedAdmin()
    await reseedDomains()
    adminCookie = await login()
  })

  it('generates unified subscription and share links on the primary subscription domain', async () => {
    const auth = withCookie(adminCookie)
    const source = await fetchApi('/api/admin/catalog/sources', jsonRequest({
      type: 'manual', name: 'Domain source', content: `ss://${btoa('aes-128-gcm:fixture')}@domain.example:8388#Domain`,
    }, auth))
    expect(source.status).toBe(201)
    const { nodes } = await (await fetchApi('/api/admin/catalog', auth)).json<{ nodes: { id: string }[] }>()
    const template = await bindFixtureTemplate('usr_1', { name: 'Domain template', nodeIds: [nodes[0].id] })
    const summary = await fetchApi('/api/user/subscription', auth)
    expect(summary.status).toBe(200)
    const { subscriptionUrl } = await summary.json<{ subscriptionUrl: string }>()
    expect(new URL(subscriptionUrl).origin).toBe('https://sub.warp.dpdns.org')
    expect(new URL(subscriptionUrl).pathname).toMatch(/^\/s\//u)
    const share = await fetchApi('/api/shares', jsonRequest({ scope: { type: 'template', templateId: template.id } }, auth))
    expect(share.status).toBe(201)
    const body = await share.json<{ token: string; linkBaseUrl: string }>()
    expect(body.linkBaseUrl).toBe('https://sub.warp.dpdns.org')
    expect(await (await fetchApi(`/api/shares/${body.token}/meta`)).json()).toMatchObject({ linkBaseUrl: body.linkBaseUrl })

    const service = new DomainService(env.DB)
    const backupHost = 'backup.example.com'
    const backup = await service.create('subscription', { hostname: backupHost })
    const backupPanel = await service.create('panel', { hostname: backupHost })
    await env.DB.prepare("UPDATE domains SET verification_status = 'verified', verified_at = ? WHERE hostname = ?")
      .bind(SEED_NOW, backupHost).run()
    await service.update('subscription', backup.id, { enabled: true })
    await service.update('panel', backupPanel.id, { enabled: true })
    const toggle = await adminJson('/api/admin/system/domain-restriction', jsonRequest({ enabled: true }, { method: 'PUT' }))
    expect(toggle.response.status).toBe(200)

    const original = new URL(subscriptionUrl)
    for (const hostname of [original.hostname, backupHost]) {
      const loginResponse = await fetchHost(hostname, '/api/login', jsonRequest({
        username: ADMIN_USERNAME, password: ADMIN_PASSWORD,
      }, { headers: { origin: `https://${hostname}` } }))
      expect(loginResponse.status).toBe(200)
      const session = loginResponse.headers.get('set-cookie')!
      expect(session).not.toMatch(/;\s*domain=/i)
      expect((await fetchHost(hostname, '/api/admin/system/domains', withCookie(session.split(';', 1)[0]))).status).toBe(200)
    }
    const [initialDownload, alternateDownload] = await Promise.all([
      fetchHost(original.hostname, original.pathname), fetchHost(backupHost, original.pathname),
    ])
    expect(initialDownload.status).toBe(200)
    expect(alternateDownload.status).toBe(200)
    expect(await alternateDownload.text()).toBe(await initialDownload.text())

    await service.setPrimary('subscription', backup.id)
    const updated = await fetchHost(original.hostname, '/api/user/subscription', auth)
    expect(await updated.json()).toMatchObject({ subscriptionUrl: `https://${backupHost}${original.pathname}` })
    expect((await fetchHost(original.hostname, original.pathname)).status).toBe(200)
    await service.update('subscription', 'dom_sub_primary', { enabled: false })
    expect(await (await fetchHost(original.hostname, original.pathname)).json())
      .toMatchObject({ error: { code: 'DOMAIN_NOT_ALLOWED' } })
    expect((await fetchHost(backupHost, original.pathname)).status).toBe(200)
  })

  it('returns no unified link when no primary domain remains', async () => {
    await env.DB.prepare("DELETE FROM domain_bindings WHERE purpose = 'subscription'").run()
    const summary = await fetchApi('/api/user/subscription', withCookie(adminCookie))
    expect(summary.status).toBe(200)
    const { subscriptionUrl } = await summary.json<{ subscriptionUrl: string | null }>()
    expect(subscriptionUrl).toBeNull()
  })
})

describe('host gate', () => {
  it('restricts subscription-only hosts and immediately revokes cached access after disabling a binding', async () => {
    const service = new DomainService(env.DB)
    const host = 'subscription.example.com'
    const domain = await service.create('subscription', { hostname: host })
    await env.DB.prepare("UPDATE domains SET verification_status = 'verified', verified_at = ? WHERE hostname = ?").bind(SEED_NOW, host).run()
    await service.update('subscription', domain.id, { enabled: true })
    const toggle = await fetchApi('/api/admin/system/domain-restriction',
      withCookie(adminCookie, jsonRequest({ enabled: true }, { method: 'PUT' })))
    expect(toggle.status).toBe(200)
    const sub = async () => (await fetchHost(host, '/sub/unknown')).json<{ error: { code: string } }>()
    expect((await sub()).error.code).not.toBe('DOMAIN_NOT_ALLOWED')
    for (const path of ['/login', '/system/distribution', '/api/account/subscription-platforms', '/api/login', '/api/admin/system/domains']) {
      const response = await fetchHost(host, path, withCookie(adminCookie))
      expect(await response.json()).toMatchObject({ error: { code: 'DOMAIN_NOT_ALLOWED' } })
    }
    const disabled = await fetchHost('sub.warp.dpdns.org', `/api/admin/system/domains/subscription/${domain.id}`,
      withCookie(adminCookie, jsonRequest({ enabled: false }, {
        method: 'PATCH', headers: { origin: 'https://sub.warp.dpdns.org' },
      })))
    expect(disabled.status).toBe(200)
    expect((await sub()).error.code).toBe('DOMAIN_NOT_ALLOWED')
  })

  it('stays off by default, enforces per class when on, and denies hosts on empty bindings', async () => {
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

    await env.DB.prepare("DELETE FROM domain_bindings WHERE purpose = 'panel'").run()
    invalidateGateCache(env.DB)
    const fallbackPanel = await fetchApi('/api/account/subscription-platforms', withCookie(adminCookie))
    expect(fallbackPanel.status).toBe(404)

    // Turning the switch off restores every host (cleanup for other tests).
    await resetRestriction()
    const restored = await fetchHost('anything.example.com', '/api/account/subscription-platforms', withCookie(adminCookie))
    expect(restored.status).toBe(200)
  })
})


it('normalizes bare hostnames', () => {
  expect(normalizeHostname('  Example.COM ')).toBe('example.com')
  for (const invalid of ['https://example.com', 'a..com', 'a.com.', 'a.com:443', 'a.com/#', 'localhost', 'foo.localhost', '192.168.1.1', '127.1', '0x7f.1', '2130706433', '::1', '[::1]', 'K.com', '例子.com']) {
    expect(normalizeHostname(invalid)).toBeNull()
  }
})


it('encodes the frozen HMAC vector byte for byte and matches Node crypto', async () => {
  const proof = {
    version: 1 as const, hostname: 'verify.example.com',
    challengeId: '12345678-1234-4234-8234-123456789abc',
    expiresAt: '2026-11-27T19:00:00.000Z', instanceId: 'ins_fixture',
  }
  const encoded = 'v1\nverify.example.com\n12345678-1234-4234-8234-123456789abc\n2026-11-27T19:00:00.000Z\nins_fixture'
  expect(encodeProof(proof)).toBe(encoded)
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
  const nodeSignature = createHmac('sha256', key).update(encoded, 'utf8').digest('base64url')
  expect(nodeSignature).toBe('ctG28TMj03h6ssu32LokivG0zvvyhlP6PZ4TnEFLg74')
  expect(await signHmac(encodeProof(proof), key.toString('base64url'))).toBe(nodeSignature)
})
