import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseLoon } from '../../../worker/import/loon.js'
import { parseShareUri } from '../../../worker/import/uri.js'
import {
  CLIENT_IDS,
  renderClient,
  type RenderNode,
} from '../../../worker/renderers/index.js'

const base = (overrides: Partial<RenderNode> = {}): RenderNode => ({
  id: 'node_1',
  protocol: 'shadowsocks',
  displayName: 'Demo',
  server: 'ss.example.com',
  port: 8388,
  credentials: { method: 'aes-128-gcm', password: 'password' },
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
})

describe('delivery renderers', () => {
  it('exposes the eight stable clients and generic fallback', () => {
    expect(CLIENT_IDS).toEqual([
      'mihomo', 'singbox', 'surge', 'loon', 'quantumultx',
      'v2rayn', 'nekobox', 'shadowrocket', 'generic',
    ])
  })

  it('renders Mihomo YAML with a selector and stable duplicate names', () => {
    const result = renderClient('mihomo', [
      base(),
      base({ id: 'node_2', displayName: 'Demo', order: 2, server: 'ss2.example.com' }),
    ])
    const document = parseYaml(result.body) as { proxies: Array<Record<string, unknown>>; 'proxy-groups': Array<Record<string, unknown>> }
    expect(document.proxies).toHaveLength(2)
    expect(document.proxies.map((node) => node.name)).toEqual(['Demo', 'Demo (2)'])
    expect(document['proxy-groups'][0]).toMatchObject({ type: 'select', proxies: ['Demo', 'Demo (2)'] })
    expect(result.diagnostics).toEqual([])
  })

  it('renders sing-box JSON with selector and direct', () => {
    const result = renderClient('singbox', [base()])
    const document = JSON.parse(result.body) as { outbounds: Array<Record<string, unknown>> }
    expect(document.outbounds[0]).toMatchObject({ type: 'shadowsocks', tag: 'Demo', server: 'ss.example.com', server_port: 8388 })
    expect(document.outbounds.at(-2)).toMatchObject({ type: 'selector', tag: 'Proxy' })
    expect(document.outbounds.at(-1)).toEqual({ type: 'direct', tag: 'direct' })
  })

  it('uses standard URI rows for text and Base64 clients', () => {
    const node = base({ protocol: 'trojan', displayName: 'Trojan', server: 'trojan.example.com', port: 443, credentials: { password: 'secret' }, tls: { enabled: true, serverName: 'trojan.example.com' } })
    for (const client of ['loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'] as const) {
      const result = renderClient(client, [node])
      if (client === 'loon') {
        expect(result.body).toContain('Trojan = trojan,trojan.example.com,443')
        expect(parseLoon(result.body)).toMatchObject({ warnings: [], nodes: [{ protocol: 'trojan', displayName: 'Trojan' }] })
        continue
      }
      const text = ['v2rayn', 'nekobox', 'shadowrocket', 'generic'].includes(client)
        ? atob(result.body)
        : result.body
      expect(text).toContain('trojan://')
      expect(parseShareUri(text.trim()).protocol).toBe('trojan')
    }
  })

  it('keeps HTTP credentials and Shadowsocks plugin options in standard URIs', () => {
    const http = base({ protocol: 'http', displayName: 'HTTP', server: 'http.example.com', port: 8080, credentials: { username: 'user', password: 'pass' } })
    const parsedHttp = parseShareUri(renderClient('generic', [http]).body && atob(renderClient('generic', [http]).body).trim())
    expect(parsedHttp.credentials).toEqual({ username: 'user', password: 'pass' })
    const ss = base({ plugin: { name: 'obfs-local', options: 'obfs=http;obfs-host=cdn.example.com' } })
    const parsedSs = parseShareUri(atob(renderClient('generic', [ss]).body).trim())
    expect(parsedSs.plugin?.name).toBe('obfs-local')
  })

  it("uses Mihomo's documented hyphenated VMess alter-id field", () => {
    const vmess = base({ protocol: 'vmess', credentials: { uuid: '11111111-1111-4111-8111-111111111111', alterId: '0', security: 'auto' } })
    const document = parseYaml(renderClient('mihomo', [vmess]).body) as { proxies: Array<Record<string, unknown>> }
    expect(document.proxies[0]['alter-id']).toBe(0)
  })

  it('renders Mihomo SSR parameters without dropping the node', () => {
    const result = renderClient('mihomo', [base({
      protocol: 'ssr',
      credentials: { method: 'aes-256-cfb', password: 'password', protocol: 'auth_sha1_v4', obfs: 'http_simple' },
      extensions: { 'protocol-param': 'user:pass', 'obfs-param': 'cdn.example.com' },
    })])
    const proxy = (parseYaml(result.body) as { proxies: Array<Record<string, unknown>> }).proxies[0]
    expect(proxy).toMatchObject({ type: 'ssr', 'protocol-param': 'user:pass', 'obfs-param': 'cdn.example.com' })
    expect(result.diagnostics).toEqual([])
  })

  it('reports stable skip reasons for a client that cannot express a node', () => {
    const node = base({ protocol: 'wireguard', displayName: 'WG', credentials: { privateKey: 'private', publicKey: 'public' } })
    const result = renderClient('surge', [node])
    expect(result.body).toContain('[Proxy]')
    expect(result.outputNodes).toBe(0)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      nodeId: 'node_1',
      nodeName: 'WG',
      protocol: 'wireguard',
      code: 'UNSUPPORTED_PROTOCOL',
      outcome: 'skipped',
    })
  })

  it('renders the official Surge protocol set and skips VLESS', () => {
    const nodes: RenderNode[] = [
      base({ id: 'node_snell', protocol: 'snell', displayName: 'Snell', credentials: { psk: 'psk', version: '4' }, plugin: { name: 'http', options: { host: 'snell.example.com' } }, extensions: { reuse: true } }),
      base({ id: 'node_tuic', protocol: 'tuic', displayName: 'TUIC', credentials: { token: 'token' }, tls: { enabled: true, alpn: ['h3'] } }),
      base({ id: 'node_hy2', protocol: 'hysteria2', displayName: 'Hysteria 2', credentials: { password: 'password' }, transport: { mport: '2000-3000', hopInterval: '30', obfsPassword: 'obfs' }, tls: { enabled: true } }),
      base({ id: 'node_anytls', protocol: 'anytls', displayName: 'AnyTLS', credentials: { password: 'password' }, tls: { enabled: true } }),
      base({ id: 'node_vless', protocol: 'vless', displayName: 'VLESS', credentials: { uuid: '22222222-2222-4222-8222-222222222222' } }),
    ]
    const result = renderClient('surge', nodes)
    expect(result.body).toContain('Snell = snell,')
    expect(result.body).toContain('TUIC = tuic,')
    expect(result.body).toContain('Hysteria 2 = hysteria2,')
    expect(result.body).toContain('AnyTLS = anytls,')
    expect(result.outputNodes).toBe(4)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ nodeId: 'node_vless', protocol: 'vless', code: 'UNSUPPORTED_PROTOCOL', outcome: 'skipped' })
  })

  it('reports unsupported normalized extensions instead of dropping them', () => {
    const result = renderClient('mihomo', [base({ extensions: { unsupported: true } })])
    expect(result.outputNodes).toBe(1)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      nodeId: 'node_1',
      nodeName: 'Demo',
      code: 'UNSUPPORTED_FIELD',
      fields: ['extensions.unsupported'],
      outcome: 'included',
    })
  })

  it('reports TLS, transport and plugin fields that a structured client drops', () => {
    const result = renderClient('mihomo', [base({
      protocol: 'trojan',
      credentials: { password: 'secret' },
      tls: { enabled: true, security: 'reality', unknownTls: true },
      transport: { type: 'ws', path: '/edge', mode: 'unsupported-mode' },
      plugin: { name: 'unsupported-plugin' },
    })])
    expect(result.outputNodes).toBe(1)
    expect(result.diagnostics[0]).toMatchObject({
      code: 'UNSUPPORTED_FIELD',
      outcome: 'included',
      fields: expect.arrayContaining(['tls.security', 'tls.unknownTls', 'transport.mode', 'plugin']),
    })
  })

  it('reports URI TLS, transport and plugin fields that are not serialized', () => {
    const result = renderClient('v2rayn', [base({
      protocol: 'trojan',
      credentials: { password: 'password' },
      tls: { enabled: true, unsupportedTls: true },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com', 'X-Unsupported': 'drop' }, unsupportedTransport: true },
      plugin: { name: 'unsupported-plugin' },
    })])
    expect(result.outputNodes).toBe(1)
    expect(result.diagnostics[0]).toMatchObject({
      code: 'UNSUPPORTED_FIELD',
      outcome: 'included',
      fields: expect.arrayContaining(['tls.unsupportedTls', 'transport.headers.X-Unsupported', 'transport.unsupportedTransport', 'plugin']),
    })
  })

  it('reports client-specific plugin options that line renderers drop', () => {
    for (const client of ['surge', 'loon'] as const) {
      const result = renderClient(client, [base({ plugin: { name: 'http', options: { host: 'cdn.example.com', unsupported: true } } })])
      expect(result.outputNodes).toBe(1)
      expect(result.diagnostics[0]).toMatchObject({ fields: expect.arrayContaining(['plugin.options.unsupported']) })
    }
  })

  it('does not warn for Mihomo WireGuard extensions that are actually rendered', () => {
    const result = renderClient('mihomo', [base({
      protocol: 'wireguard',
      displayName: 'WG',
      credentials: { privateKey: 'private', publicKey: 'public' },
      extensions: { ip: '10.0.0.2/32', ipv6: 'fd00::2/128', mtu: 1280, reserved: [1, 2, 3], allowedIPs: ['0.0.0.0/0'] },
    })])
    expect(result.outputNodes).toBe(1)
    expect(result.diagnostics).toEqual([])
  })

  it('does not report the internal source scheme marker as an unsupported field', () => {
    const result = renderClient('mihomo', [base({ protocol: 'trojan', credentials: { password: 'secret' }, extensions: { sourceScheme: 'trojan-go' } })])
    expect(result.outputNodes).toBe(1)
    expect(result.diagnostics).toEqual([])
  })

  it('does not report an equivalent legacy allowInsecure extension', () => {
    const node = base({
      protocol: 'hysteria2',
      credentials: { password: 'password' },
      tls: { enabled: true, insecure: false },
      extensions: { allowInsecure: '0' },
    })
    for (const client of CLIENT_IDS) {
      expect(renderClient(client, [node]).diagnostics, client).toEqual([])
    }
  })

  it('reports malformed credentials as an invalid node instead of an unsupported protocol', () => {
    const result = renderClient('mihomo', [base({ protocol: 'vmess', displayName: 'Broken VMess', credentials: {} })])
    expect(result.outputNodes).toBe(0)
    expect(result.diagnostics[0]).toMatchObject({
      code: 'INVALID_NODE',
      nodeName: 'Broken VMess',
      outcome: 'skipped',
    })
  })

  it('skips ShadowTLS chains instead of emitting a plain Shadowsocks node', () => {
    const result = renderClient('singbox', [base({
      protocol: 'shadowsocks',
      credentials: { method: 'aes-128-gcm', password: 'password' },
      extensions: { shadowtls: { version: 3, password: 'hop-password' } },
    })])
    expect(result.outputNodes).toBe(0)
    expect(result.diagnostics).toMatchObject([{
      code: 'UNSUPPORTED_FIELD',
      outcome: 'skipped',
      fields: ['extensions.shadowtls'],
    }])
  })
})
