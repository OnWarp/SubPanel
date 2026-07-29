import { describe, expect, it } from 'vitest'
import loonNodes from '../fixtures/import/loon-nodes.conf?raw'
import mihomoBare from '../fixtures/import/mihomo-bare.yaml?raw'
import mihomoProvider from '../fixtures/import/mihomo-provider.yaml?raw'
import mihomoProxies from '../fixtures/import/mihomo-proxies.yaml?raw'
import quantumultXServers from '../fixtures/import/quantumultx-servers.txt?raw'
import singBoxOutbounds from '../fixtures/import/sing-box-outbounds.json?raw'
import singBox from '../fixtures/import/sing-box.json?raw'
import sip008 from '../fixtures/import/sip008.json?raw'
import uriListBase64 from '../fixtures/import/uri-list-base64.txt?raw'
import uriList from '../fixtures/import/uri-list.txt?raw'
import { detectImport } from '../../../worker/import/detect'
import { parseLoon } from '../../../worker/import/loon'

describe('catalog import container detection', () => {
  it('detects every locked fixture', () => {
    const cases = [
      [uriList, 'uri-list'],
      [uriListBase64, 'uri-list'],
      [mihomoProxies, 'mihomo'],
      [mihomoProvider, 'mihomo'],
      [mihomoBare, 'mihomo'],
      [singBox, 'sing-box'],
      [singBoxOutbounds, 'sing-box'],
      [sip008, 'sip008'],
      [loonNodes, 'loon'],
      [quantumultXServers, 'uri-list'],
    ] as const
    for (const [content, format] of cases) expect(detectImport(content).format).toBe(format)
  })

  it('prefers SIP008 over generic sing-box JSON', () => {
    const mixed = JSON.stringify({
      version: 1,
      servers: [{ server: 'ss.example.com', server_port: 8388, method: 'aes-128-gcm', password: 'password' }],
      outbounds: [{ type: 'direct' }],
    })
    expect(detectImport(mixed).format).toBe('sip008')
  })

  it('prefers Mihomo roots over line parsing', () => {
    expect(detectImport(`${mihomoProvider}\nnote: "Demo = Shadowsocks,ss.example.com,8388,aes-128-gcm,password"`).format).toBe('mihomo')
  })

  it('accepts uniformly indented bare Mihomo lists', () => {
    const content = `
  - {name: "TUIC", type: tuic, server: 172.245.120.103, port: 8883, uuid: 2efc3fbc-0c98-4fa3-a156-51ff83d0d20e, password: 2efc3fbc-0c98-4fa3-a156-51ff83d0d20e, alpn: [h3], congestion-controller: bbr}

  - {name: "VLESS", type: vless, server: cf.example.com, port: 443, uuid: 2efc3fbc-0c98-4fa3-a156-51ff83d0d20e, tls: true}
`
    expect(detectImport(content).nodes).toHaveLength(2)
  })

  it('parses Loon quoted commas and key-value options', () => {
    const result = parseLoon('Quoted = Shadowsocks,ss.example.com,8388,aes-128-gcm,"pass,word",note="a,b",udp=true')
    expect(result.nodes[0]).toMatchObject({
      credentials: { method: 'aes-128-gcm', password: 'pass,word' },
      extensions: { note: 'a,b', udp: true },
    })
  })

  it('treats Quantumult X official snippets as URI lists', () => {
    expect(detectImport(quantumultXServers)).toMatchObject({ format: 'uri-list', warnings: [] })
  })

  it('detects NaiveProxy and Trojan-Go URI-only subscriptions', () => {
    const content = [
      'naive+https://user:password@naive.example.com:443#Naive',
      'trojan-go://password@trojan.example.com:443#Trojan-Go',
    ].join('\n')
    expect(detectImport(content)).toMatchObject({ format: 'uri-list', warnings: [] })
  })

  it('returns an unknown-format error without content details', () => {
    const secret = 'do-not-leak-password'
    expect(() => detectImport(`unknown ${secret}`)).toThrow('UNSUPPORTED_IMPORT_FORMAT')
    try {
      detectImport(`unknown ${secret}`)
    } catch (error) {
      expect((error as Error).message).not.toContain(secret)
    }
  })
})
