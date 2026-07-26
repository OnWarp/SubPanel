import { describe, expect, it } from 'vitest'
import mihomoBare from '../fixtures/import/mihomo-bare.yaml?raw'
import mihomoProvider from '../fixtures/import/mihomo-provider.yaml?raw'
import mihomoProxies from '../fixtures/import/mihomo-proxies.yaml?raw'
import singBoxOutbounds from '../fixtures/import/sing-box-outbounds.json?raw'
import singBox from '../fixtures/import/sing-box.json?raw'
import sip008 from '../fixtures/import/sip008.json?raw'
import { parseMihomo } from '../../../worker/import/mihomo'
import { parseSingBox } from '../../../worker/import/singbox'
import { parseSip008 } from '../../../worker/import/sip008'

describe('structured catalog imports', () => {
  it('parses Mihomo proxies and provider payloads', () => {
    const full = parseMihomo(mihomoProxies)
    const provider = parseMihomo(mihomoProvider)
    expect(full.warnings).toEqual([])
    expect(full.nodes.map(({ protocol }) => protocol)).toEqual(['shadowsocks', 'vless', 'wireguard'])
    expect(full.nodes[0]).toMatchObject({
      displayName: 'Mihomo SS',
      credentials: { method: 'aes-128-gcm', password: 'password' },
      plugin: { name: 'obfs', options: { mode: 'http', host: 'cdn.example.com' } },
    })
    expect(full.nodes[1]).toMatchObject({
      tls: { enabled: true, serverName: 'vless.example.com' },
      transport: { type: 'ws', path: '/vless', headers: { Host: 'cdn.example.com' } },
    })
    expect(full.nodes[2]).toMatchObject({
      server: '192.0.2.1',
      credentials: {
        privateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
        preSharedKey: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      },
      extensions: { ip: '192.0.2.2', udp: true, reserved: [1, 2, 3] },
    })
    expect(provider.nodes).toHaveLength(1)
    expect(provider.nodes[0]).toMatchObject({ protocol: 'trojan', displayName: 'Provider Trojan' })
  })

  it('parses bare Mihomo proxy arrays', () => {
    const result = parseMihomo(mihomoBare)
    expect(result.warnings).toEqual([])
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]).toMatchObject({ protocol: 'shadowsocks', displayName: 'Bare SS' })
    expect(result.nodes[1]).toMatchObject({ protocol: 'trojan', displayName: 'Bare Trojan', tls: { serverName: 'bare-trojan.example.com' } })
  })

  it('reads Mihomo VMess alter-id with its documented hyphenated spelling', () => {
    const result = parseMihomo(`proxies:\n  - name: Legacy VMess\n    type: vmess\n    server: vmess.example.com\n    port: 443\n    uuid: 11111111-1111-4111-8111-111111111111\n    alter-id: 32\n`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0].credentials).toMatchObject({ alterId: '32' })
  })

  it('normalizes the Mihomo allowInsecure TLS alias', () => {
    const result = parseMihomo(`proxies:\n  - name: VLESS TLS\n    type: vless\n    server: vless.example.com\n    port: 443\n    uuid: 22222222-2222-4222-8222-222222222222\n    tls: true\n    allowInsecure: "0"\n`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({ tls: { enabled: true, insecure: false } })
    expect(result.nodes[0].extensions).toEqual({})
  })

  it('normalizes common Hysteria authentication and transport aliases', () => {
    const mihomo = parseMihomo(`proxies:\n  - name: Hysteria v1\n    type: hysteria\n    server: hy.example.com\n    port: 443\n    auth-str: auth-secret\n    up: 20\n    down: 100\n    obfs: salamander\n    obfs-password: obfs-secret\n    ports: 2000-3000\n    hop-interval: 30\n`)
    expect(mihomo.warnings).toEqual([])
    expect(mihomo.nodes[0]).toMatchObject({
      protocol: 'hysteria',
      credentials: { password: 'auth-secret' },
      transport: { upMbps: 20, downMbps: 100, obfs: 'salamander', obfsPassword: 'obfs-secret', mport: '2000-3000', hopInterval: 30 },
    })

    const singbox = parseSingBox(JSON.stringify({ outbounds: [{
      type: 'hysteria', tag: 'Hysteria v1', server: 'hy.example.com', server_port: 443,
      auth_str: 'auth-secret', up_mbps: 20, down_mbps: 100, obfs: 'salamander', obfs_password: 'obfs-secret',
      server_ports: ['2000:3000'], hop_interval: '30',
      tls: { enabled: true },
    }] }))
    expect(singbox.warnings).toEqual([])
    expect(singbox.nodes[0]).toMatchObject({
      protocol: 'hysteria',
      credentials: { password: 'auth-secret' },
      transport: { upMbps: 20, downMbps: 100, obfs: 'salamander', obfsPassword: 'obfs-secret', mport: '2000-3000', hopInterval: '30' },
    })
  })

  it('accepts string and object sing-box Hysteria obfs forms', () => {
    const result = parseSingBox(JSON.stringify({ outbounds: [
      { type: 'hysteria', tag: 'H1', server: 'h1.example.com', server_port: 443, obfs: { type: 'salamander', password: 'h1-obfs' } },
      { type: 'hysteria2', tag: 'H2', server: 'h2.example.com', server_port: 443, password: 'password', obfs: 'salamander', obfs_password: 'h2-obfs' },
    ] }))
    expect(result.warnings).toEqual([])
    expect(result.nodes[0].transport).toMatchObject({ obfs: 'salamander', obfsPassword: 'h1-obfs' })
    expect(result.nodes[1].transport).toMatchObject({ obfs: 'salamander', obfsPassword: 'h2-obfs' })
  })

  it('retains Mihomo SSR protocol and obfs parameters', () => {
    const result = parseMihomo(`proxies:\n  - name: SSR\n    type: ssr\n    server: ssr.example.com\n    port: 443\n    cipher: aes-256-cfb\n    password: password\n    protocol: origin\n    protocol-param: proto-param\n    obfs: plain\n    obfs-param: obfs-param\n`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      protocol: 'ssr',
      credentials: { method: 'aes-256-cfb', password: 'password', protocol: 'origin', obfs: 'plain' },
      extensions: { 'protocol-param': 'proto-param', 'obfs-param': 'obfs-param' },
    })
  })

  it('accepts Mihomo Hysteria v1 entries without optional auth', () => {
    const result = parseMihomo(`proxies:\n  - name: Hysteria no auth\n    type: hysteria\n    server: hy.example.com\n    port: 443\n    obfs: salamander\n    obfs-password: obfs-secret\n`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({ protocol: 'hysteria', credentials: {}, transport: { obfs: 'salamander', obfsPassword: 'obfs-secret' } })
  })

  it('retains unknown nested Mihomo Reality and transport fields', () => {
    const result = parseMihomo(`proxies:\n  - name: Nested fields\n    type: vless\n    server: vless.example.com\n    port: 443\n    uuid: 22222222-2222-4222-8222-222222222222\n    tls: true\n    reality-opts:\n      public-key: public-key\n      custom-reality: keep\n    network: ws\n    ws-opts:\n      path: /edge\n      custom-transport:\n        keep: true\n`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      tls: { reality: { publicKey: 'public-key', 'custom-reality': 'keep' } },
      transport: { type: 'ws', path: '/edge', 'ws-opts': { 'custom-transport': { keep: true } } },
    })
  })

  it('parses sing-box full configurations and bare outbound arrays', () => {
    for (const content of [singBox, singBoxOutbounds]) {
      const result = parseSingBox(content)
      expect(result.nodes.map(({ protocol }) => protocol)).toEqual(['shadowsocks', 'vless'])
      expect(result.nodes[1]).toMatchObject({
        tls: { enabled: true, serverName: 'vless.example.com' },
        transport: { type: 'ws', path: '/vless', headers: { Host: 'cdn.example.com' } },
      })
      expect(result.warnings).toEqual([
        { code: 'UNSUPPORTED_SINGBOX_OUTBOUND', message: 'Unsupported sing-box outbound type: direct' },
      ])
    }
  })

  it('retains unknown nested sing-box TLS, Reality and transport fields', () => {
    const result = parseSingBox(JSON.stringify({ outbounds: [{
      type: 'vless', tag: 'Nested fields', server: 'vless.example.com', server_port: 443,
      uuid: '22222222-2222-4222-8222-222222222222',
      tls: {
        enabled: true,
        min_version: '1.3',
        reality: { enabled: true, public_key: 'public-key', custom_reality: 'keep' },
      },
      transport: { type: 'ws', path: '/edge', custom_transport: { keep: true } },
    }] }))
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      tls: { min_version: '1.3', reality: { publicKey: 'public-key', custom_reality: 'keep' } },
      transport: { type: 'ws', path: '/edge', custom_transport: { keep: true } },
    })
  })

  it('skips direct and selector outbounds with warnings', () => {
    const result = parseSingBox(JSON.stringify([
      { type: 'direct', tag: 'direct' },
      { type: 'selector', tag: 'select', outbounds: ['direct'] },
      { type: 'wireguard', tag: 'endpoint-only', server: '192.0.2.1', server_port: 51820, private_key: 'private', peer_public_key: 'public' },
    ]))
    expect(result.nodes).toMatchObject([{ protocol: 'wireguard', credentials: { privateKey: 'private', publicKey: 'public' } }])
    expect(result.warnings.map(({ code }) => code)).toEqual([
      'UNSUPPORTED_SINGBOX_OUTBOUND',
      'UNSUPPORTED_SINGBOX_OUTBOUND',
    ])
  })

  it('normalizes sing-box WireGuard interface fields without hiding them in transport', () => {
    const result = parseSingBox(JSON.stringify({ outbounds: [{
      type: 'wireguard', tag: 'WireGuard', server: 'wg.example.com', server_port: 51820,
      private_key: 'private', peer_public_key: 'public', pre_shared_key: 'shared',
      local_address: ['10.0.0.2/32'], mtu: 1280, reserved: [1, 2, 3],
    }] }))
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      protocol: 'wireguard',
      credentials: { privateKey: 'private', publicKey: 'public', preSharedKey: 'shared' },
      extensions: { localAddress: ['10.0.0.2/32'], mtu: 1280, reserved: [1, 2, 3] },
    })
  })

  it('parses SIP008 version 1 and preserves vendor fields', () => {
    const result = parseSip008(sip008)
    expect(result.warnings).toEqual([])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]).toMatchObject({
      protocol: 'shadowsocks',
      displayName: 'SIP008 SS',
      credentials: { method: 'aes-128-gcm', password: 'password' },
      plugin: { name: 'obfs-local', options: { obfs: 'http', 'obfs-host': 'cdn.example.com' } },
      extensions: { vendor_note: 'preserve-me' },
    })
  })

  it('rejects malformed roots without leaking content', () => {
    const secret = 'do-not-leak-password'
    for (const parse of [parseMihomo, parseSingBox, parseSip008]) {
      try {
        parse(`{"secret":"${secret}"}`)
        throw new Error('Expected parser to reject malformed root')
      } catch (error) {
        expect((error as Error).message).not.toContain(secret)
      }
    }
  })
})
