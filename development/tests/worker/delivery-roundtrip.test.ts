import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseMihomo } from '../../../worker/import/mihomo.js'
import { parseUriList } from '../../../worker/import/uri.js'
import { parseSingBox } from '../../../worker/import/singbox.js'
import { parseSurge } from '../../../worker/import/surge.js'
import { renderClient, type RenderNode } from '../../../worker/renderers/index.js'

const base = (overrides: Partial<RenderNode> = {}): RenderNode => ({
  id: 'node_1',
  protocol: 'trojan',
  displayName: 'Trojan',
  server: 'example.com',
  port: 443,
  credentials: { password: 'password' },
  tls: { enabled: true, serverName: 'example.com' },
  transport: {},
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
})

const singBoxStructuralWarnings = [
  { code: 'UNSUPPORTED_SINGBOX_OUTBOUND', message: 'Unsupported sing-box outbound type: selector' },
  { code: 'UNSUPPORTED_SINGBOX_OUTBOUND', message: 'Unsupported sing-box outbound type: direct' },
]

describe('structured delivery round trips', () => {
  it('renders a Surge document accepted by the Surge importer', () => {
    const parsed = parseSurge(renderClient('surge', [base({
      credentials: { password: 'pass,word' },
      tls: { enabled: true, serverName: 'example.com', insecure: false, alpn: ['h2', 'http/1.1'] },
    })]).body)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0].credentials).toEqual({ password: 'pass,word' })
    expect(parsed.nodes[0].tls).toMatchObject({ insecure: false, alpn: ['h2', 'http/1.1'] })
  })

  it('uses Surge positional credentials for HTTPS and SOCKS5-TLS', () => {
    for (const protocol of ['https', 'socks5'] as const) {
      const result = renderClient('surge', [base({
        protocol,
        displayName: protocol,
        credentials: { username: 'user', password: 'pass,word' },
        tls: { enabled: true, insecure: false },
      })])
      expect(result.body).toContain(`${protocol} = ${protocol === 'socks5' ? 'socks5-tls' : 'https'}, example.com, 443, user, "pass,word"`)
      const parsed = parseSurge(result.body)
      expect(parsed.warnings).toEqual([])
      expect(parsed.nodes[0]).toMatchObject({ protocol, credentials: { username: 'user', password: 'pass,word' }, tls: { enabled: true, insecure: false } })
    }
  })

  it('round-trips Surge VMess WebSocket headers', () => {
    const parsed = parseSurge(renderClient('surge', [base({
      protocol: 'vmess',
      credentials: { uuid: '22222222-2222-4222-8222-222222222222' },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com', 'X-Test': 'value' } },
    })]).body)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes[0].transport).toMatchObject({ type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com', 'X-Test': 'value' } })
  })

  it('round-trips Surge Shadowsocks obfs URI fields', () => {
    const parsed = parseSurge(renderClient('surge', [base({
      protocol: 'shadowsocks',
      credentials: { method: 'aes-128-gcm', password: 'password' },
      plugin: { name: 'http', options: { host: 'cdn.example.com', uri: '/edge' } },
    })]).body)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes[0].plugin).toMatchObject({ name: 'http', options: { host: 'cdn.example.com', uri: '/edge' } })
  })

  it('renders Mihomo YAML accepted by the Mihomo importer', () => {
    const parsed = parseMihomo(renderClient('mihomo', [base()]).body)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes).toHaveLength(1)
  })

  it('round-trips Mihomo Reality, certificate fingerprint and WebSocket fields', () => {
    const parsed = parseMihomo(renderClient('mihomo', [base({
      protocol: 'vless',
      credentials: { uuid: '22222222-2222-4222-8222-222222222222', encryption: 'none', flow: 'xtls-rprx-vision' },
      tls: {
        enabled: true,
        serverName: 'www.example.com',
        fingerprint: 'chrome',
        certificate: 'CERTIFICATE',
        certificateFingerprint: 'AA:BB:CC',
        reality: { publicKey: 'public-key', shortId: 'short-id', spiderX: '/' },
      },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' }, earlyData: 2048, earlyDataHeaderName: 'Sec-WebSocket-Protocol' },
    })]).body)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes[0]).toMatchObject({
      credentials: { uuid: '22222222-2222-4222-8222-222222222222', flow: 'xtls-rprx-vision' },
      tls: { certificateFingerprint: 'AA:BB:CC', reality: { publicKey: 'public-key', shortId: 'short-id' } },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' }, earlyData: 2048 },
    })
    expect(parsed.nodes[0].tls).not.toHaveProperty('certificate')
  })

  it('renders sing-box JSON accepted by the sing-box importer', () => {
    const parsed = parseSingBox(renderClient('singbox', [base()]).body)
    expect(parsed.warnings).toEqual(singBoxStructuralWarnings)
    expect(parsed.nodes).toHaveLength(1)
  })

  it('round-trips the sing-box NaiveProxy username', () => {
    const parsed = parseSingBox(renderClient('singbox', [base({
      protocol: 'naive',
      credentials: { username: 'user', password: 'password' },
      tls: { enabled: true },
    })]).body)
    expect(parsed.warnings).toEqual(singBoxStructuralWarnings)
    expect(parsed.nodes[0].credentials).toEqual({ username: 'user', password: 'password' })
  })

  it('round-trips sing-box Hysteria2 hopping and obfs fields', () => {
    const parsed = parseSingBox(renderClient('singbox', [base({
      protocol: 'hysteria2',
      credentials: { password: 'password' },
      tls: { enabled: true },
      transport: { mport: '2000-3000', hopInterval: '30', obfs: 'salamander', obfsPassword: 'obfs-password' },
    })]).body)
    expect(parsed.warnings).toEqual(singBoxStructuralWarnings)
    expect(parsed.nodes[0].transport).toMatchObject({ mport: '2000-3000', hopInterval: '30s', obfs: 'salamander', obfsPassword: 'obfs-password' })
  })

  it('round-trips sing-box Hysteria v1 hopping and obfs fields', () => {
    const parsed = parseSingBox(renderClient('singbox', [base({
      protocol: 'hysteria',
      credentials: { password: 'password' },
      tls: { enabled: true },
      transport: { mport: '2000-3000', hopInterval: '30', upMbps: 20, downMbps: 100, obfs: 'obfs-password' },
    })]).body)
    expect(parsed.warnings).toEqual(singBoxStructuralWarnings)
    expect(parsed.nodes[0].transport).toMatchObject({ mport: '2000-3000', hopInterval: '30s', upMbps: 20, downMbps: 100, obfs: 'obfs-password' })
  })

  it('round-trips sing-box TUIC congestion control', () => {
    const parsed = parseSingBox(renderClient('singbox', [base({
      protocol: 'tuic',
      credentials: { uuid: '22222222-2222-4222-8222-222222222222', password: 'password' },
      tls: { enabled: true },
      transport: { congestionControl: 'cubic', udpRelayMode: 'native' },
    })]).body)
    expect(parsed.warnings).toEqual(singBoxStructuralWarnings)
    expect(parsed.nodes[0].transport).toMatchObject({ congestionControl: 'cubic', udpRelayMode: 'native' })
  })

  it('round-trips Mihomo TUIC UDP relay mode', () => {
    const parsed = parseMihomo(renderClient('mihomo', [base({
      protocol: 'tuic',
      credentials: { uuid: '22222222-2222-4222-8222-222222222222', password: 'password' },
      tls: { enabled: true },
      transport: { congestionControl: 'cubic', udpRelayMode: 'native' },
    })]).body)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes[0].transport).toMatchObject({ congestionControl: 'cubic', udpRelayMode: 'native' })
  })

  it('renders Quantumult X URI rows accepted by the URI importer', () => {
    const parsed = parseUriList(renderClient('quantumultx', [base()]).body)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes).toHaveLength(1)
  })

  it('keeps rendered Mihomo YAML structurally valid', () => {
    expect(parseYaml(renderClient('mihomo', [base()]).body)).toHaveProperty('proxies')
  })
})
