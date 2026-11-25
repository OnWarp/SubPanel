import { exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { bindFixtureTemplate, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

beforeEach(setupContractedAdmin)

async function fixture(content = `ss://${btoa('aes-128-gcm:fixture')}@delivery.example:8388#Delivery`) {
  const auth = withCookie(await login())
  const source = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog/sources',
    jsonRequest({ type: 'manual', name: 'Delivery source', content }, auth))
  expect(source.status).toBe(201)
  const catalog = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog', auth)
  const { nodes } = await catalog.json<{ nodes: { id: string }[] }>()
  await bindFixtureTemplate('usr_1', { name: 'Delivery authorization', nodeIds: nodes.map(node => node.id) })
  const summary = await exports.default.fetch(TEST_ORIGIN + '/api/user/subscription', auth)
  expect(summary.status).toBe(200)
  const { subscriptionUrl } = await summary.json<{ subscriptionUrl: string }>()
  return { auth, nodes, path: new URL(subscriptionUrl).pathname }
}

it('renders live catalog data and handles conditional requests after a node edit', async () => {
  const { auth, nodes, path } = await fixture()
  const url = TEST_ORIGIN + path + '/mihomo'
  const initial = await exports.default.fetch(url)
  expect(initial.status).toBe(200)
  const etag = initial.headers.get('etag')!
  expect(parseYaml(await initial.text()).proxies).toMatchObject([{ name: 'Delivery', server: 'delivery.example' }])
  const conditional = { headers: { 'If-None-Match': etag } }
  expect((await exports.default.fetch(url, conditional)).status).toBe(304)
  const edited = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog/nodes/' + nodes[0].id,
    jsonRequest({ displayName: 'Updated delivery' }, withCookie(new Headers(auth.headers).get('cookie')!, { method: 'PATCH' })))
  expect(edited.status).toBe(200)
  const changed = await exports.default.fetch(url, conditional)
  expect(changed.status).toBe(200)
  expect(changed.headers.get('etag')).not.toBe(etag)
  expect(parseYaml(await changed.text()).proxies).toMatchObject([{ name: 'Updated delivery' }])
})

it('uses built-in formats and rejects the retired public and administrator paths', async () => {
  const { auth, path } = await fixture()
  const generic = await exports.default.fetch(TEST_ORIGIN + path, { headers: { 'User-Agent': 'custom-test-client' } })
  expect(generic.status).toBe(200)
  expect(generic.headers.get('x-subscription-client')).toBe('generic')
  expect(atob(await generic.text())).toContain('delivery.example')
  for (const client of ['clash', 'sing-box', 'surge', 'loon', 'quantumult-x', 'v2rayng', 'neko-box', 'shadowrocket']) {
    const response = await exports.default.fetch(TEST_ORIGIN + path + '/' + client)
    expect(response.status, client).toBe(200)
    const body = await response.text()
    expect(body.includes('delivery.example') ? body : atob(body), client).toContain('delivery.example')
  }
  expect((await exports.default.fetch(TEST_ORIGIN + path.replace('/s/', '/sub/'))).status).toBe(404)
  expect((await exports.default.fetch(TEST_ORIGIN + '/api/admin/subscriptions', auth)).status).toBe(404)
})

it('renders an imported Hysteria2 PEM certificate as a Mihomo fingerprint', async () => {
  const certificate = '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----'
  const { path } = await fixture(`hysteria2://password@hy2.example.com:443?cert=${encodeURIComponent(certificate)}#HY2`)
  const response = await exports.default.fetch(TEST_ORIGIN + path + '/mihomo')
  expect(response.status).toBe(200)
  const [proxy] = parseYaml(await response.text()).proxies
  expect(proxy).toMatchObject({
    type: 'hysteria2',
    fingerprint: '03:90:58:C6:F2:C0:CB:49:2C:53:3B:0A:4D:14:EF:77:CC:0F:78:AB:CC:CE:D5:28:7D:84:A1:A2:01:1C:FB:81',
  })
  expect(proxy).not.toHaveProperty('certificate')
})
