import { describe, expect, it } from 'vitest'
import uriLossless from '../fixtures/import/uri-lossless.txt?raw'
import uriListBase64 from '../fixtures/import/uri-list-base64.txt?raw'
import uriList from '../fixtures/import/uri-list.txt?raw'
import { decodeSubscriptionBase64 } from '../../../worker/import/base64'
import { parseUriList } from '../../../worker/import/uri'

describe('share URI imports', () => {
  it('parses every supported line in uri-list.txt', () => {
    const result = parseUriList(uriList)
    expect(result.warnings).toEqual([])
    expect(result.nodes.map(({ protocol }) => protocol)).toEqual([
      'shadowsocks',
      'vmess',
      'vless',
      'trojan',
      'hysteria2',
      'tuic',
      'anytls',
      'http',
      'https',
      'socks5',
    ])
    expect(result.nodes[0]).toMatchObject({
      displayName: 'SS Demo',
      server: 'ss.example.com',
      port: 8388,
      credentials: { method: 'aes-128-gcm', password: 'password' },
    })
    expect(result.nodes[1]).toMatchObject({
      displayName: 'VMess Demo',
      server: 'vmess.example.com',
      credentials: { uuid: '11111111-1111-4111-8111-111111111111', alterId: '0', security: 'auto' },
      tls: { enabled: true, serverName: 'vmess.example.com', alpn: ['h2', 'http/1.1'], fingerprint: 'chrome' },
      transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } },
    })
    expect(result.nodes[2]).toMatchObject({
      credentials: { uuid: '22222222-2222-4222-8222-222222222222', encryption: 'none' },
      tls: { enabled: true, serverName: 'vless.example.com' },
      transport: { type: 'ws', path: '/vless', headers: { Host: 'cdn.example.com' } },
    })
    expect(result.nodes[5].credentials).toEqual({
      uuid: '33333333-3333-4333-8333-333333333333',
      password: 'tuic-password',
    })
    expect(result.nodes[7].credentials).toEqual({ username: 'proxy-user', password: 'proxy-password' })
    expect(result.nodes[8].credentials).toEqual({ username: 'proxy-user', password: 'proxy-password' })
    expect(result.nodes[9].credentials).toEqual({ username: 'socks-user', password: 'socks-password' })
  })

  it('decodes one whole-body Base64 layer', () => {
    const decoded = decodeSubscriptionBase64(uriListBase64)
    expect(decoded).toContain('ss://')
    expect(parseUriList(decoded!).nodes).toHaveLength(1)
  })

  it('keeps valid siblings when one URI is invalid', () => {
    const content = `${uriList.trim().split('\n')[0]}\nvless://not-a-uuid@bad.example.com:443`
    const result = parseUriList(content)
    expect(result.nodes).toHaveLength(1)
    expect(result.warnings).toEqual([{ code: 'INVALID_URI', message: 'Unable to parse vless URI', line: 2 }])
    expect(JSON.stringify(result.warnings)).not.toContain('not-a-uuid')
  })

  it('retains unknown query keys in extensions', () => {
    const result = parseUriList('vless://22222222-2222-4222-8222-222222222222@vless.example.com:443?encryption=none&mystery=value')
    expect(result.nodes[0].extensions).toEqual({ mystery: 'value' })
  })

  it('does not recursively decode arbitrary Base64', () => {
    expect(decodeSubscriptionBase64(btoa(uriListBase64.trim()))).toBeNull()
  })

  it('preserves Reality, certificate, flow, hopping and plugin fields', () => {
    const result = parseUriList(uriLossless)
    expect(result.warnings).toEqual([])
    expect(result.nodes.map(({ protocol }) => protocol)).toEqual(['vless', 'hysteria2', 'tuic', 'ss2022', 'ssr'])
    expect(result.nodes[0]).toMatchObject({
      tls: {
        enabled: true,
        security: 'reality',
        serverName: 'www.example.com',
        fingerprint: 'chrome',
        certificate: '-----BEGIN CERTIFICATE----- CERT -----END CERTIFICATE-----',
        reality: { publicKey: 'public-key', shortId: 'short-id', spiderX: '/' },
      },
      transport: { type: 'ws', path: '/reality', headers: { Host: 'cdn.example.com' } },
      credentials: { flow: 'xtls-rprx-vision' },
    })
    expect(result.nodes[1]).toMatchObject({
      tls: { insecure: true, certificate: '-----BEGIN CERTIFICATE-----' },
      transport: { obfs: 'salamander', obfsPassword: 'obfs-secret', mport: '2000-3000', upMbps: '20', downMbps: '100', hopInterval: '30' },
    })
    expect(result.nodes[2]).toMatchObject({
      tls: { alpn: ['h3', 'h2'] },
      transport: { congestionControl: 'bbr', udpRelayMode: 'native' },
    })
    expect(result.nodes[4]).toMatchObject({
      server: 'ssr.example.com',
      port: 443,
      credentials: { protocol: 'protocol', method: 'method', obfs: 'obfs' },
      extensions: { obfsparam: 'x', protoparam: 'y', remarks: 'SSR' },
    })
  })

  it('parses v2rayN wrappers and rejoins soft-wrapped payloads', () => {
    const payload = btoa(JSON.stringify({
      Address: 'v2rayn.example.com',
      Port: 443,
      Remarks: 'v2rayN Reality',
      Id: '44444444-4444-4444-8444-444444444444',
      StreamSecurity: 'reality',
      Network: 'ws',
      Sni: 'www.example.com',
      Fingerprint: 'chrome',
      PublicKey: 'v2rayn-public-key',
      ShortId: 'v2rayn-short-id',
      Flow: 'xtls-rprx-vision',
      Cert: '-----BEGIN CERTIFICATE-----',
      ProtoExtraObj: { Host: 'cdn.example.com' },
    }))
    const line = `v2rayn://vless/${payload}`
    const split = `${line.slice(0, 42)}\n${line.slice(42)}`
    const result = parseUriList(split)
    expect(result.warnings).toEqual([])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]).toMatchObject({
      format: 'v2rayn',
      displayName: 'v2rayN Reality',
      protocol: 'vless',
      server: 'v2rayn.example.com',
      tls: { security: 'reality', certificate: '-----BEGIN CERTIFICATE-----', reality: { publicKey: 'v2rayn-public-key', shortId: 'v2rayn-short-id' } },
      transport: { type: 'ws', headers: { Host: 'cdn.example.com' } },
      credentials: { flow: 'xtls-rprx-vision' },
    })
  })

  it('retains unknown nested v2rayN wrapper fields', () => {
    const payload = btoa(JSON.stringify({
      Address: 'vless.example.com', Port: 443, Id: '22222222-2222-4222-8222-222222222222',
      ProtoExtraObj: { Host: 'cdn.example.com', VendorMode: { keep: true } },
    }))
    const result = parseUriList(`v2rayn://vless/${payload}`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      transport: { headers: { Host: 'cdn.example.com' } },
      extensions: { ProtoExtraObj: { VendorMode: { keep: true } } },
    })
  })

  it('parses NaiveProxy and Trojan-Go URI schemes without dropping credentials', () => {
    const content = [
      'naive+https://naive-user:naive-password@naive.example.com:443?padding=true#Naive',
      'trojan-go://trojan-password@trojan-go.example.com:443?sni=www.example.com&type=ws&host=cdn.example.com&path=%2Fws#Trojan-Go',
    ].join('\n')
    const result = parseUriList(content)
    expect(result.warnings).toEqual([])
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]).toMatchObject({
      protocol: 'naive',
      displayName: 'Naive',
      server: 'naive.example.com',
      credentials: { username: 'naive-user', password: 'naive-password' },
      tls: { enabled: true },
      extensions: { padding: 'true' },
    })
    expect(result.nodes[1]).toMatchObject({
      protocol: 'trojan',
      displayName: 'Trojan-Go',
      credentials: { password: 'trojan-password' },
      tls: { enabled: true, serverName: 'www.example.com' },
      transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } },
      extensions: { sourceScheme: 'trojan-go' },
    })
  })

  it('parses v2rayN AnyTLS and Naive wrappers', () => {
    const anytls = btoa(JSON.stringify({ Address: 'anytls.example.com', Port: 443, Remarks: 'AnyTLS', Password: 'secret' }))
    const naive = btoa(JSON.stringify({ Address: 'naive.example.com', Port: 443, Remarks: 'Naive', Username: 'user', Password: 'pass' }))
    const result = parseUriList(`v2rayn://anytls/${anytls}\nv2rayn://naive/${naive}`)
    expect(result.warnings).toEqual([])
    expect(result.nodes).toMatchObject([
      { protocol: 'anytls', credentials: { password: 'secret' } },
      { protocol: 'naive', credentials: { username: 'user', password: 'pass' } },
    ])
  })

  it('uses Username as the UUID in v2rayN TUIC wrappers', () => {
    const payload = btoa(JSON.stringify({
      Address: 'tuic.example.com', Port: 443, Remarks: 'Wrapped TUIC',
      Username: '33333333-3333-4333-8333-333333333333', Password: 'tuic-password',
      Sni: 'tuic.example.com', ProtoExtraObj: { CongestionControl: 'bbr' },
    }))
    const result = parseUriList(`v2rayn://tuic/${payload}`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      protocol: 'tuic',
      credentials: { uuid: '33333333-3333-4333-8333-333333333333', password: 'tuic-password' },
      transport: { congestionControl: 'bbr' },
    })
  })

  it('marks HTTPS-family v2rayN wrappers as TLS', () => {
    const https = btoa(JSON.stringify({ Address: 'https.example.com', Port: 443, Username: 'user', Password: 'pass' }))
    const naive = btoa(JSON.stringify({ Address: 'naive.example.com', Port: 443, Username: 'user', Password: 'pass' }))
    const result = parseUriList(`v2rayn://https/${https}\nv2rayn://naive/${naive}`)
    expect(result.warnings).toEqual([])
    expect(result.nodes).toMatchObject([
      { protocol: 'https', tls: { enabled: true } },
      { protocol: 'naive', tls: { enabled: true } },
    ])
  })

  it('rejects v2rayN wrappers with missing protocol credentials', () => {
    const invalidVless = btoa(JSON.stringify({ Address: 'vless.example.com', Port: 443, Id: 'not-a-uuid' }))
    const invalidTuic = btoa(JSON.stringify({ Address: 'tuic.example.com', Port: 443, Password: 'password' }))
    const result = parseUriList(`v2rayn://vless/${invalidVless}\nv2rayn://tuic/${invalidTuic}`)
    expect(result.nodes).toEqual([])
    expect(result.warnings.map(({ code }) => code)).toEqual(['INVALID_URI', 'INVALID_URI'])
  })

  it('parses v2rayN Shadowsocks wrappers with method and plugin fields', () => {
    const payload = btoa(JSON.stringify({
      Address: 'ss.example.com', Port: 8388, Remarks: 'Wrapped SS',
      Method: 'aes-128-gcm', Password: 'password',
      Plugin: 'obfs-local', PluginOptions: 'obfs=http;obfs-host=cdn.example.com',
    }))
    const result = parseUriList(`v2rayn://ss/${payload}`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({
      protocol: 'shadowsocks',
      credentials: { method: 'aes-128-gcm', password: 'password' },
      plugin: { name: 'obfs-local', options: { obfs: 'http', 'obfs-host': 'cdn.example.com' } },
    })
  })

  it('uses the standard HTTPS port for Hysteria URIs without an explicit port', () => {
    const result = parseUriList('hysteria://auth@hy.example.com?sni=hy.example.com')
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({ protocol: 'hysteria', server: 'hy.example.com', port: 443, credentials: { password: 'auth' } })
  })

  it('parses Shadowrocket base64 VLESS authorities and SSR IPv6 hosts', () => {
    const uuid = '55555555-5555-4555-8555-555555555555'
    const authority = btoa(`auto:${uuid}@vless.example.com:443`).replace(/=+$/u, '')
    const shadowrocket = `vless://${authority}?remarks=Shadowrocket&obfs=websocket&obfsParam=%2Fedge&tls=1&peer=www.example.com`
    const ssrPayload = `2001:db8::1:443:origin:aes-256-cfb:plain:${btoa('ssr-secret').replace(/=+$/u, '')}/?remarks=${btoa('SSR IPv6').replace(/=+$/u, '')}`
    const ssr = `ssr://${btoa(ssrPayload).replace(/=+$/u, '')}`
    const result = parseUriList(`${shadowrocket}\n${ssr}`)
    expect(result.warnings).toEqual([])
    expect(result.nodes[0]).toMatchObject({ server: 'vless.example.com', port: 443, credentials: { uuid }, transport: { type: 'ws' }, tls: { enabled: true, serverName: 'www.example.com' } })
    expect(result.nodes[1]).toMatchObject({ protocol: 'ssr', server: '2001:db8::1', port: 443, credentials: { password: 'ssr-secret' } })
  })
})
