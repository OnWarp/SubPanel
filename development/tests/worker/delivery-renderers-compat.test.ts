import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseShareUri } from '../../../worker/import/uri.js'
import { renderClient, serializeShareUri, type RenderNode } from '../../../worker/renderers/index.js'

const uuid = '22222222-2222-4222-8222-222222222222'

function node(overrides: Partial<RenderNode> = {}): RenderNode {
  return {
    id: 'node_1',
    protocol: 'vless',
    displayName: 'Reality',
    server: 'reality.example.com',
    port: 443,
    credentials: { uuid, encryption: 'none', flow: 'xtls-rprx-vision' },
    tls: {
      enabled: true,
      security: 'reality',
      serverName: 'www.example.com',
      fingerprint: 'chrome',
      certificate: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
      certificateFingerprint: 'AA:BB:CC',
      reality: { publicKey: 'public-key', shortId: 'short-id', spiderX: '/' },
    },
    transport: {
      type: 'ws',
      path: '/edge',
      headers: { Host: 'cdn.example.com' },
      serviceName: 'edge',
      earlyData: 2048,
      earlyDataHeaderName: 'Sec-WebSocket-Protocol',
    },
    plugin: {},
    extensions: {},
    fingerprint: 'fingerprint',
    sourceIds: ['src_1'],
    rawVariants: [],
    enabled: true,
    retained: false,
    order: 1,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('delivery renderer compatibility matrix', () => {
  it('does not warn about a Reality security marker that structured clients fully map', () => {
    const reality = node({
      tls: { enabled: true, security: 'reality', serverName: 'www.example.com', fingerprint: 'chrome', reality: { publicKey: 'public-key' } },
      transport: { type: 'tcp' },
    })
    for (const client of ['mihomo', 'singbox'] as const) {
      const result = renderClient(client, [reality])
      expect(result.outputNodes, client).toBe(1)
      expect(result.diagnostics, client).toEqual([])
    }
  })

  it('does not warn about NaiveProxy default TCP transport in sing-box', () => {
    const result = renderClient('singbox', [node({
      protocol: 'naive',
      displayName: 'Naive HTTP2',
      credentials: { username: 'user', password: 'password' },
      tls: { enabled: true, serverName: 'naive.example.com' },
      transport: { type: 'tcp' },
    })])
    expect(result.outputNodes).toBe(1)
    expect(result.diagnostics).toEqual([])
  })

  it('round-trips Reality, Flow, certificate and early-data URI fields', () => {
    const raw = serializeShareUri(node())
    expect(raw).toBeTruthy()
    expect(raw).toContain('security=reality')
    expect(raw).toContain('pbk=public-key')
    expect(raw).toContain('sid=short-id')
    expect(raw).toContain('spx=%2F')
    expect(raw).toContain('flow=xtls-rprx-vision')
    expect(raw).toContain('cert=')
    expect(raw).toContain('ed=2048')
    expect(parseShareUri(raw!).transport).toMatchObject({ type: 'ws', earlyData: '2048', earlyDataHeaderName: 'Sec-WebSocket-Protocol' })
    expect(parseShareUri(raw!).tls).toMatchObject({ certificate: expect.any(String), reality: { publicKey: 'public-key', shortId: 'short-id' } })
  })

  it('round-trips VMess JSON Reality, certificate, Flow and early-data fields', () => {
    const raw = serializeShareUri(node({
      protocol: 'vmess',
      displayName: 'VMess',
      credentials: { uuid, alterId: '0', security: 'auto', flow: 'xtls-rprx-vision' },
      tls: {
        enabled: true,
        serverName: 'www.example.com',
        fingerprint: 'chrome',
        certificate: 'CERTIFICATE',
        reality: { publicKey: 'public-key', shortId: 'short-id', spiderX: '/' },
      },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' }, earlyData: 2048, earlyDataHeaderName: 'Sec-WebSocket-Protocol' },
    }))
    expect(raw).toBeTruthy()
    expect(parseShareUri(raw!).credentials).toMatchObject({ uuid, flow: 'xtls-rprx-vision' })
    expect(parseShareUri(raw!).tls).toMatchObject({ certificate: 'CERTIFICATE', reality: { publicKey: 'public-key', shortId: 'short-id' } })
    expect(parseShareUri(raw!).transport).toMatchObject({ earlyData: '2048', earlyDataHeaderName: 'Sec-WebSocket-Protocol' })
  })

  it('does not render a server certificate as a Mihomo mTLS client certificate', () => {
    const result = renderClient('mihomo', [node()])
    const proxy = (parseYaml(result.body) as { proxies: Array<Record<string, unknown>> }).proxies[0]
    expect(proxy).toMatchObject({
      flow: 'xtls-rprx-vision',
      'client-fingerprint': 'chrome',
      fingerprint: 'AA:BB:CC',
      'reality-opts': { 'public-key': 'public-key', 'short-id': 'short-id' },
      'ws-opts': { path: '/edge', headers: { Host: 'cdn.example.com' }, 'max-early-data': 2048 },
    })
    expect(proxy).not.toHaveProperty('certificate')
    expect(proxy).not.toHaveProperty('ca-str')
    expect(proxy['reality-opts']).not.toHaveProperty('spider-x')
    expect(result.diagnostics[0]).toMatchObject({ fields: expect.arrayContaining(['tls.certificate', 'tls.reality.spiderX']) })
    expect(result.outputNodes).toBe(1)
  })

  it('renders sing-box certificate pin, Reality, Flow and early-data fields', () => {
    const result = renderClient('singbox', [node()])
    const outbounds = (JSON.parse(result.body) as { outbounds: Array<Record<string, any>> }).outbounds
    expect(outbounds[0]).toMatchObject({
      flow: 'xtls-rprx-vision',
      tls: {
        certificate: expect.stringContaining('BEGIN CERTIFICATE'),
        certificate_public_key_sha256: ['AA:BB:CC'],
        reality: { enabled: true, public_key: 'public-key', short_id: 'short-id' },
      },
      transport: { max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol' },
    })
    expect((outbounds[0].tls as Record<string, any>).reality).not.toHaveProperty('spider_x')
    expect(result.diagnostics[0]).toMatchObject({ fields: expect.arrayContaining(['tls.reality.spiderX']) })
  })

  it('uses native Hysteria authentication fields and preserves hopping options', () => {
    const hysteria = node({
      protocol: 'hysteria',
      displayName: 'Hysteria',
      server: 'hy.example.com',
      credentials: { password: 'auth-secret' },
      transport: { upMbps: 20, downMbps: 100, obfs: 'obfs-secret', mport: '2000-3000', hopInterval: '30' },
      tls: { enabled: true },
    })
    const mihomo = parseYaml(renderClient('mihomo', [hysteria]).body) as { proxies: Array<Record<string, unknown>> }
    expect(mihomo.proxies[0]).toMatchObject({ type: 'hysteria', 'auth-str': 'auth-secret', up: 20, down: 100, obfs: 'obfs-secret', ports: '2000-3000', 'hop-interval': '30' })
    expect(mihomo.proxies[0]).not.toHaveProperty('auth')
    expect(mihomo.proxies[0]).not.toHaveProperty('obfs-password')
    const singbox = JSON.parse(renderClient('singbox', [hysteria]).body) as { outbounds: Array<Record<string, unknown>> }
    expect(singbox.outbounds[0]).toMatchObject({ type: 'hysteria', auth_str: 'auth-secret', up_mbps: 20, down_mbps: 100, obfs: 'obfs-secret', server_ports: ['2000:3000'], hop_interval: '30s' })
    expect(singbox.outbounds[0]).not.toHaveProperty('obfs_password')
  })

  it('keeps Hysteria v1 nodes without optional authentication', () => {
    const nodeWithoutAuth = node({
      protocol: 'hysteria',
      displayName: 'Hysteria no auth',
      credentials: {},
      tls: { enabled: true },
      transport: { upMbps: 20, downMbps: 100, obfs: 'obfs-secret' },
    })
    expect(renderClient('mihomo', [nodeWithoutAuth]).outputNodes).toBe(1)
    expect(renderClient('singbox', [nodeWithoutAuth]).outputNodes).toBe(1)
  })

  it('does not attach TLS or V2Ray transports to unsupported structured protocols', () => {
    const shadowsocks = node({
      protocol: 'shadowsocks',
      credentials: { method: 'aes-128-gcm', password: 'password' },
      tls: { enabled: true, serverName: 'wrong.example.com' },
      transport: { type: 'ws', path: '/wrong' },
    })
    const mihomo = renderClient('mihomo', [shadowsocks])
    const proxy = (parseYaml(mihomo.body) as { proxies: Array<Record<string, unknown>> }).proxies[0]
    expect(proxy).not.toHaveProperty('tls')
    expect(proxy).not.toHaveProperty('servername')
    expect(proxy).not.toHaveProperty('network')
    expect(proxy).not.toHaveProperty('ws-opts')
    expect(mihomo.diagnostics[0]).toMatchObject({ fields: expect.arrayContaining(['tls.enabled', 'tls.serverName', 'transport.type', 'transport.path']) })

    const singbox = renderClient('singbox', [shadowsocks])
    const outbound = (JSON.parse(singbox.body) as { outbounds: Array<Record<string, unknown>> }).outbounds[0]
    expect(outbound).not.toHaveProperty('tls')
    expect(outbound).not.toHaveProperty('transport')
    expect(singbox.diagnostics[0]).toMatchObject({ fields: expect.arrayContaining(['tls.enabled', 'tls.serverName', 'transport.type', 'transport.path']) })
  })

  it('uses each Mihomo protocol schema for TLS names and implicit TLS', () => {
    const trojan = renderClient('mihomo', [node({ protocol: 'trojan', credentials: { password: 'secret' } })])
    const proxy = (parseYaml(trojan.body) as { proxies: Array<Record<string, unknown>> }).proxies[0]
    expect(proxy).toMatchObject({ type: 'trojan', sni: 'www.example.com' })
    expect(proxy).not.toHaveProperty('tls')
    expect(proxy).not.toHaveProperty('servername')
  })

  it('omits native TCP from sing-box V2Ray transport objects', () => {
    const result = renderClient('singbox', [node({ tls: { enabled: true }, transport: { type: 'tcp' } })])
    const outbound = (JSON.parse(result.body) as { outbounds: Array<Record<string, unknown>> }).outbounds[0]
    expect(outbound).not.toHaveProperty('transport')
    expect(result.diagnostics).toEqual([])
  })

  it('serializes Hysteria v1 without authentication', () => {
    const raw = serializeShareUri(node({ protocol: 'hysteria', credentials: {}, tls: { enabled: true } }))
    expect(raw).toContain('hysteria://@')
    expect(parseShareUri(raw!).credentials).toEqual({})
  })

  it('does not emit the removed sing-box WireGuard outbound', () => {
    const result = renderClient('singbox', [node({
      protocol: 'wireguard',
      displayName: 'WireGuard',
      server: 'wg.example.com',
      port: 51820,
      credentials: { privateKey: 'private-key', publicKey: 'public-key', preSharedKey: 'shared-key' },
      tls: undefined,
      transport: { localAddress: ['10.0.0.2/32'], mtu: 1280, reserved: [1, 2, 3] },
      extensions: {},
    })])
    expect(result.outputNodes).toBe(0)
    expect(result.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_PROTOCOL', outcome: 'skipped', protocol: 'wireguard' })
  })

  it('maps WireGuard address arrays to Mihomo IPv4 and IPv6 fields', () => {
    const result = renderClient('mihomo', [node({
      protocol: 'wireguard',
      credentials: { privateKey: 'private-key', publicKey: 'public-key' },
      tls: undefined,
      transport: undefined,
      extensions: { localAddress: ['10.0.0.2/32', 'fd00::2/128'], 'allowed-ips': ['0.0.0.0/0'] },
    })])
    const proxy = (parseYaml(result.body) as { proxies: Array<Record<string, unknown>> }).proxies[0]
    expect(proxy).toMatchObject({ ip: '10.0.0.2/32', ipv6: 'fd00::2/128', 'allowed-ips': ['0.0.0.0/0'] })
    expect(result.diagnostics).toEqual([])
  })

  it('renders sing-box HTTPS as an HTTP outbound with TLS', () => {
    const result = renderClient('singbox', [node({ protocol: 'https', server: 'secure.example.com', port: 443, credentials: {}, tls: { enabled: true } })])
    const outbound = (JSON.parse(result.body) as { outbounds: Array<Record<string, unknown>> }).outbounds[0]
    expect(outbound).toMatchObject({ type: 'http', server: 'secure.example.com', tls: { enabled: true } })
  })

  it('keeps Shadowsocks plugin fields in sing-box output', () => {
    const result = renderClient('singbox', [node({ protocol: 'shadowsocks', credentials: { method: 'aes-128-gcm', password: 'password' }, plugin: { name: 'obfs-local', options: 'obfs=http;obfs-host=cdn.example.com' } })])
    const outbound = (JSON.parse(result.body) as { outbounds: Array<Record<string, unknown>> }).outbounds[0]
    expect(outbound).toMatchObject({ plugin: 'obfs-local', plugin_opts: 'obfs=http;obfs-host=cdn.example.com' })
  })

  it('skips AnyTLS with Reality for Mihomo instead of emitting an invalid profile', () => {
    const result = renderClient('mihomo', [node({ protocol: 'anytls', credentials: { password: 'secret' }, tls: { enabled: true, reality: { publicKey: 'key' } } })])
    expect(result.outputNodes).toBe(0)
    expect(result.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_FIELD', outcome: 'skipped', fields: ['tls.reality'] })
  })

  it('uses a raw v2rayN variant when a standard URI cannot safely carry the stored fields', () => {
    const payload = btoa(JSON.stringify({ address: 'reality.example.com', port: 443, id: uuid, remarks: 'Raw', cert: 'CERT' }))
    const raw = `v2rayn://vless/${payload}`
    const result = renderClient('v2rayn', [node({ rawVariants: [{ sourceId: 'src_1', format: 'v2rayn', raw, extensions: {} }] })])
    expect(atob(result.body)).toContain(raw)
    expect(result.outputNodes).toBe(1)
  })

  it('round-trips VMess certificate pins, verification and early-data aliases', () => {
    const raw = serializeShareUri(node({
      protocol: 'vmess',
      credentials: { uuid, alterId: '0', security: 'auto' },
      tls: { enabled: true, insecure: false, certificateFingerprint: 'pin-sha256' },
      transport: { type: 'ws', maxEarlyData: 2048, earlyDataHeaderName: 'Sec-WebSocket-Protocol' },
    }))
    const parsed = parseShareUri(raw!)
    expect(parsed.tls).toMatchObject({ enabled: true, insecure: false, certificateFingerprint: 'pin-sha256' })
    expect(parsed.transport).toMatchObject({ type: 'ws', earlyData: '2048', earlyDataHeaderName: 'Sec-WebSocket-Protocol' })
  })

  it('keeps supported Surge nodes and reports only fields it cannot express', () => {
    const result = renderClient('surge', [node({ protocol: 'trojan', credentials: { password: 'secret' }, tls: { ...node().tls, insecure: true }, extensions: { vendor: true } })])
    expect(result.body).toContain('skip-cert-verify=true')
    expect(result.outputNodes).toBe(1)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      nodeId: 'node_1',
      nodeName: 'Reality',
      code: 'UNSUPPORTED_FIELD',
      outcome: 'included',
    })
  })

  it('round-trips NaiveProxy credentials in its native URI scheme', () => {
    const raw = serializeShareUri(node({
      protocol: 'naive',
      displayName: 'Naive',
      credentials: { username: 'user', password: 'pass' },
      tls: { enabled: true },
    }))
    expect(raw).toContain('naive+https://user:pass@')
    expect(parseShareUri(raw!).credentials).toEqual({ username: 'user', password: 'pass' })
    expect(parseShareUri(raw!).protocol).toBe('naive')
  })

  it('preserves the Trojan-Go URI scheme when the normalized node carries it', () => {
    const raw = serializeShareUri(node({
      protocol: 'trojan',
      displayName: 'Trojan-Go',
      credentials: { password: 'pass' },
      extensions: { sourceScheme: 'trojan-go' },
    }))
    expect(raw).toContain('trojan-go://')
    expect(parseShareUri(raw!).extensions).toMatchObject({ sourceScheme: 'trojan-go' })
  })

  it('serializes SSR IPv6 endpoints and hyphenated parameter aliases', () => {
    const raw = serializeShareUri(node({
      protocol: 'ssr',
      displayName: 'SSR IPv6',
      server: '2001:db8::1',
      port: 443,
      credentials: { method: 'aes-256-cfb', password: 'password', protocol: 'origin', obfs: 'plain' },
      tls: undefined,
      transport: undefined,
      extensions: { 'obfs-param': 'obfs-param', 'protocol-param': 'proto-param' },
    }))
    expect(raw).toContain('ssr://')
    const parsed = parseShareUri(raw!)
    expect(parsed.server).toBe('2001:db8::1')
    expect(parsed.extensions).toMatchObject({ obfsparam: 'obfs-param', protoparam: 'proto-param' })
  })

  it('keeps an existing x- extension prefix stable across URI round trips', () => {
    const raw = serializeShareUri(node({ extensions: { 'x-vendor-mode': 'fast' } }))
    expect(raw).toContain('x-vendor-mode=fast')
    expect(raw).not.toContain('x-x-vendor-mode')
    expect(parseShareUri(raw!).extensions).toMatchObject({ 'x-vendor-mode': 'fast' })
  })

  it('does not reuse a raw URI variant from a different protocol', () => {
    const wrong = 'trojan://secret@wrong.example.com:443#Wrong'
    const right = 'vless://22222222-2222-4222-8222-222222222222@right.example.com:443?security=tls#Right'
    const result = renderClient('v2rayn', [node({
      server: 'right.example.com',
      rawVariants: [
        { sourceId: 'src_1', format: 'uri-list', raw: wrong, extensions: {} },
        { sourceId: 'src_1', format: 'uri-list', raw: right, extensions: {} },
      ],
    })])
    expect(atob(result.body)).toContain(right)
    expect(atob(result.body)).not.toContain(wrong)
  })
})
