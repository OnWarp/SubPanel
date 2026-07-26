import { describe, expect, it } from 'vitest'
import quantumultXNodes from '../fixtures/import/quantumultx-nodes.conf?raw'
import surgeNodes from '../fixtures/import/surge-nodes.conf?raw'
import { detectImport } from '../../../worker/import/detect'
import { parseMihomo } from '../../../worker/import/mihomo'
import { parseQuantumultX } from '../../../worker/import/quantumultx'
import { parseSingBox } from '../../../worker/import/singbox'
import { parseSurge } from '../../../worker/import/surge'

describe('lossless structured imports', () => {
  it('preserves Mihomo certificate, cert pin, Reality, flow and unknown fields', () => {
    const result = parseMihomo(`
proxies:
  - name: Reality VLESS
    type: vless
    server: reality.example.com
    port: 443
    uuid: 22222222-2222-4222-8222-222222222222
    flow: xtls-rprx-vision
    tls: true
    servername: www.example.com
    client-fingerprint: chrome
    fingerprint: 01:02:03:04
    ca-str: |-
      -----BEGIN CERTIFICATE-----
      CERT
      -----END CERTIFICATE-----
    reality-opts:
      public-key: public-key
      short-id: short-id
    network: ws
    ws-opts:
      path: /edge
      headers:
        Host: cdn.example.com
      max-early-data: 2048
    x-vendor:
      enabled: true
`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      credentials: { uuid: '22222222-2222-4222-8222-222222222222', flow: 'xtls-rprx-vision' },
      tls: {
        enabled: true,
        serverName: 'www.example.com',
        fingerprint: 'chrome',
        certificateFingerprint: '01:02:03:04',
        certificate: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
        reality: { publicKey: 'public-key', shortId: 'short-id' },
      },
      transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' }, earlyData: 2048 },
      extensions: { 'x-vendor': { enabled: true } },
    })
  })

  it('preserves sing-box certificate, pin, Reality, flow and ShadowTLS hops', () => {
    const result = parseSingBox(JSON.stringify({
      outbounds: [
        {
          type: 'vless',
          tag: 'Reality VLESS',
          server: 'reality.example.com',
          server_port: 443,
          uuid: '22222222-2222-4222-8222-222222222222',
          flow: 'xtls-rprx-vision',
          tls: {
            enabled: true,
            server_name: 'www.example.com',
            certificate: ['-----BEGIN CERTIFICATE-----'],
            certificate_public_key_sha256: ['pin-sha256'],
            utls: { enabled: true, fingerprint: 'chrome' },
            reality: { enabled: true, public_key: 'public-key', short_id: 'short-id' },
          },
          transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' }, max_early_data: 2048 },
          custom_field: { keep: true },
        },
        {
          type: 'shadowsocks',
          tag: 'shadowtls-leaf',
          server: '127.0.0.1',
          server_port: 1080,
          method: '2022-blake3-aes-128-gcm',
          password: 'leaf-password',
          detour: 'shadowtls-hop',
        },
        {
          type: 'shadowtls',
          tag: 'shadowtls-hop',
          server: 'shadowtls.example.com',
          server_port: 443,
          version: 3,
          password: 'hop-password',
          tls: { enabled: true, server_name: 'www.example.com' },
        },
      ],
    }))
    expect(result.warnings).toEqual([])
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]).toMatchObject({
      credentials: { flow: 'xtls-rprx-vision' },
      tls: {
        certificate: '-----BEGIN CERTIFICATE-----',
        certificateFingerprint: 'pin-sha256',
        reality: { publicKey: 'public-key', shortId: 'short-id' },
      },
      transport: { earlyData: 2048 },
      extensions: { custom_field: { keep: true } },
    })
    expect(result.nodes[1]).toMatchObject({
      protocol: 'ss2022',
      server: 'shadowtls.example.com',
      port: 443,
      extensions: { shadowtls: { version: 3, password: 'hop-password' } },
    })
  })

  it('parses Surge and Quantumult X node rows', () => {
    const surge = parseSurge(surgeNodes)
    const quantumultX = parseQuantumultX(quantumultXNodes)
    expect(surge.warnings).toEqual([])
    expect(surge.nodes).toHaveLength(6)
    expect(surge.nodes[0]).toMatchObject({
      protocol: 'shadowsocks',
      credentials: { method: 'aes-128-gcm', password: 'password' },
      plugin: { name: 'http', options: { host: 'cdn.example.com' } },
    })
    expect(surge.nodes[2]).toMatchObject({
      protocol: 'snell',
      credentials: { psk: 'snell-password', version: '4' },
      plugin: { name: 'http', options: { host: 'snell.example.com' } },
    })
    expect(surge.nodes[3]).toMatchObject({ protocol: 'tuic', credentials: { token: 'tuic-password' }, tls: { enabled: true, alpn: ['h3'] } })
    expect(surge.nodes[4]).toMatchObject({ protocol: 'hysteria2', credentials: { password: 'hy2-password' }, transport: { mport: '2000-3000', hopInterval: '30', obfsPassword: 'hy2-obfs' } })
    expect(surge.nodes[5]).toMatchObject({ protocol: 'anytls', credentials: { password: 'anytls-password' }, tls: { enabled: true, serverName: 'anytls.example.com' } })
    expect(quantumultX.warnings).toEqual([])
    expect(quantumultX.nodes).toHaveLength(2)
    expect(quantumultX.nodes[1]).toMatchObject({
      protocol: 'trojan',
      tls: { enabled: true, serverName: 'trojan.example.com', insecure: true },
    })
  })

  it('detects line formats and mixed independent blocks', () => {
    expect(detectImport(surgeNodes).format).toBe('surge')
    expect(detectImport(quantumultXNodes).format).toBe('quantumultx')
    const mixed = detectImport(`${surgeNodes}\n-----\nvless://22222222-2222-4222-8222-222222222222@mixed.example.com:443?security=tls`)
    expect(mixed.format).toBe('mixed')
    expect(mixed.nodes.map(({ server }) => server)).toEqual(expect.arrayContaining(['ss.example.com', 'trojan.example.com', 'mixed.example.com']))
  })

  it('does not advertise VLESS as a Surge node', () => {
    const result = parseSurge('[Proxy]\nVLESS = vless, vless.example.com, 443, username=22222222-2222-4222-8222-222222222222')
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
  })
})
