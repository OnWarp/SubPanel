import { describe, expect, it } from 'vitest'
import { parseLoon } from '../../../worker/import/loon.js'
import { renderClient, type RenderNode } from '../../../worker/renderers/index.js'

const uuid = '52396e06-041a-4cc2-be5c-8525eb457809'

const base = (overrides: Partial<RenderNode> = {}): RenderNode => ({
  id: 'node_1',
  protocol: 'shadowsocks',
  displayName: 'Demo',
  server: 'example.com',
  port: 443,
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

describe('Loon protocol compatibility', () => {
  it('skips VLESS Reality instead of emitting an unusable downgraded node', () => {
    const rendered = renderClient('loon', [base({
      protocol: 'vless',
      displayName: 'VLESS Reality',
      credentials: { uuid },
      tls: { enabled: true, security: 'reality', serverName: 'www.example.com', fingerprint: 'chrome', reality: { publicKey: 'public-key' } },
      transport: { type: 'tcp' },
    })])
    expect(rendered.outputNodes).toBe(0)
    expect(rendered.body).not.toContain('VLESS Reality')
    expect(rendered.diagnostics).toMatchObject([{ code: 'UNSUPPORTED_FIELD', outcome: 'skipped', fields: ['tls.reality'] }])
  })

  it('parses the official VMess cipher, UUID, transport and TLS fields', () => {
    const result = parseLoon(
      `vmess1 = vmess,example.com,10086,aes-128-gcm,"${uuid}",transport=ws,alterId=0,path=/edge,host=cdn.example.com,over-tls=true,tls-name=example.com,skip-cert-verify=true`,
    )

    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      protocol: 'vmess',
      credentials: { security: 'aes-128-gcm', uuid, alterId: '0' },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' } },
      tls: { enabled: true, serverName: 'example.com', insecure: true },
    })
  })

  it('maps official Shadowsocks obfs fields to the plugin model', () => {
    const result = parseLoon(
      'ssObfs = Shadowsocks,example.com,80,aes-128-gcm,"password",obfs-name=http,obfs-host=www.example.com,obfs-uri=/edge,udp=true',
    )

    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      plugin: { name: 'http', options: { host: 'www.example.com', uri: '/edge' } },
      extensions: { udp: true },
    })
  })

  it('renders a VMess node in official Loon syntax that parses back', () => {
    const rendered = renderClient('loon', [base({
      protocol: 'vmess',
      displayName: 'VMess',
      credentials: { security: 'aes-128-gcm', uuid, alterId: '0' },
      tls: { enabled: true, serverName: 'example.com', insecure: true },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' } },
    })])

    expect(rendered.outputNodes).toBe(1)
    expect(rendered.diagnostics).toEqual([])
    expect(rendered.body).toContain('VMess,example.com,443,aes-128-gcm')
    expect(rendered.body).toContain(`"${uuid}"`)
    expect(rendered.body).toContain('transport=ws')
    expect(rendered.body).toContain('over-tls=true')
    expect(parseLoon(rendered.body).nodes[0]).toMatchObject({
      credentials: { security: 'aes-128-gcm', uuid },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' } },
      tls: { enabled: true, serverName: 'example.com', insecure: true },
    })
  })

  it('renders Shadowsocks obfs using Loon obfs-name fields', () => {
    const rendered = renderClient('loon', [base({
      plugin: { name: 'http', options: { host: 'www.example.com', uri: '/edge' } },
      extensions: { 'fast-open': false, udp: true },
    })])

    expect(rendered.outputNodes).toBe(1)
    expect(rendered.diagnostics).toEqual([])
    expect(rendered.body).toContain('obfs-name=http')
    expect(rendered.body).toContain('obfs-host=www.example.com')
    expect(rendered.body).toContain('obfs-uri=/edge')
    expect(rendered.body).toContain('fast-open=false')
    expect(rendered.body).toContain('udp=true')
    expect(rendered.body).not.toContain('plugin=')
    expect(parseLoon(rendered.body).nodes[0]).toMatchObject({
      plugin: { name: 'http', options: { host: 'www.example.com', uri: '/edge' } },
    })
  })

  it('keeps an explicit Loon TLS verification value when rendering', () => {
    const rendered = renderClient('loon', [base({
      protocol: 'https',
      displayName: 'HTTPS',
      server: 'secure.example.com',
      port: 443,
      credentials: {},
      tls: { enabled: true, insecure: false },
    })])
    expect(rendered.body).toContain('skip-cert-verify=false')
    expect(parseLoon(rendered.body).nodes[0]).toMatchObject({ tls: { enabled: true, insecure: false } })
  })

  it('parses and renders the official ShadowsocksR fields', () => {
    const parsed = parseLoon(
      'ssr1 = ShadowsocksR,example.com,443,aes-256-cfb,"password",protocol=origin,protocol-param=9555:loon,obfs=http_simple,obfs-param=download.windows.com,udp=true',
    )
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes[0]).toMatchObject({
      protocol: 'ssr',
      credentials: { method: 'aes-256-cfb', password: 'password', protocol: 'origin', obfs: 'http_simple' },
      extensions: { 'protocol-param': '9555:loon', 'obfs-param': 'download.windows.com', udp: true },
    })

    const rendered = renderClient('loon', [base({
      protocol: 'ssr',
      credentials: { method: 'aes-256-cfb', password: 'password', protocol: 'origin', obfs: 'http_simple' },
      extensions: { 'protocol-param': '9555:loon', 'obfs-param': 'download.windows.com', udp: true },
    })])
    expect(rendered.outputNodes).toBe(1)
    expect(rendered.diagnostics).toEqual([])
    expect(rendered.body).toContain('ShadowsocksR,example.com,443')
    expect(rendered.body).toContain('protocol=origin')
    expect(parseLoon(rendered.body).nodes[0]).toMatchObject({ protocol: 'ssr', credentials: { protocol: 'origin', obfs: 'http_simple' } })
  })

  it('parses and renders an official WireGuard peer without losing its nested options', () => {
    const line = 'wireguardNode = wireguard,interface-ip=192.168.2.2,private-key="private-key",mtu=1280,dns=192.168.2.1,keepalive=45,peers=[{public-key="public-key",preshared-key="shared-key",reserved=[1,2,3],allowed-ips="0.0.0.0/0",endpoint=192.168.3.17:51820}]'
    const parsed = parseLoon(line)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes[0]).toMatchObject({
      protocol: 'wireguard',
      server: '192.168.3.17',
      port: 51820,
      credentials: { privateKey: 'private-key', publicKey: 'public-key', preSharedKey: 'shared-key' },
      extensions: { localAddress: '192.168.2.2', mtu: 1280, dns: '192.168.2.1', keepalive: 45, peers: expect.any(String) },
    })

    const rendered = renderClient('loon', [base({
      protocol: 'wireguard',
      server: '192.168.3.17',
      port: 51820,
      credentials: { privateKey: 'private-key', publicKey: 'public-key', preSharedKey: 'shared-key' },
      extensions: { localAddress: '192.168.2.2', mtu: 1280, dns: '192.168.2.1', keepalive: 45, peers: '{public-key="public-key",preshared-key="shared-key",reserved=[1,2,3],allowed-ips="0.0.0.0/0",endpoint=192.168.3.17:51820}' },
    })])
    expect(rendered.outputNodes).toBe(1)
    expect(rendered.diagnostics).toEqual([])
    expect(rendered.body).toContain('wireguard,interface-ip=192.168.2.2')
    expect(rendered.body).toContain('peers=[{public-key=')
    expect(parseLoon(rendered.body).nodes[0]).toMatchObject({ protocol: 'wireguard', server: '192.168.3.17', port: 51820 })
  })

  it('builds a valid Loon WireGuard peer from normalized sing-box-style fields', () => {
    const rendered = renderClient('loon', [base({
      protocol: 'wireguard',
      server: 'wg.example.com',
      port: 51820,
      credentials: { privateKey: 'private-key', publicKey: 'public-key', preSharedKey: 'shared-key' },
      extensions: { localAddress: ['10.0.0.2/32'], mtu: 1280, reserved: [1, 2, 3], allowedIPs: ['0.0.0.0/0', '::/0'] },
    })])
    expect(rendered.outputNodes).toBe(1)
    expect(rendered.body).toContain('interface-ip=10.0.0.2/32')
    expect(rendered.body).toContain('reserved=[1,2,3]')
    expect(rendered.body).toContain('allowed-ips=')
    expect(parseLoon(rendered.body).nodes[0]).toMatchObject({ protocol: 'wireguard', credentials: { publicKey: 'public-key', preSharedKey: 'shared-key' } })
  })

  it('does not advertise undocumented Loon protocol rows', () => {
    const parsed = parseLoon('TUIC = tuic,tuic.example.com,443,"uuid","password"')
    expect(parsed.nodes).toEqual([])
    expect(parsed.warnings).toHaveLength(1)
  })
})
