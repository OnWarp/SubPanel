import { describe, expect, it } from 'vitest'
import { clientImportLink, detectImportDevice, prefersClientImport } from '../../../src/features/user/client-import'

describe('client import URLs', () => {
  const link = 'https://sub.example/订阅?client=demo&value=%2F#配置'
  it.each([
    ['mihomo', 'clash://install-config?url='],
    ['clash', 'clash://install-config?url='],
    ['clash-meta', 'clash://install-config?url='],
    ['stash', 'stash://install-config?url='],
    ['surge', 'surge:///install-config?url='],
    ['loon', 'loon://import?sub='],
  ])('encodes the original URL for %s', (client, scheme) => {
    const href = clientImportLink(client, link)
    expect(href?.startsWith(scheme)).toBe(true)
    expect(decodeURIComponent(href!.slice(scheme.length))).toBe(link)
  })

  it('encodes Shadowrocket payloads as UTF-8 Base64', () => {
    const prefix = 'shadowrocket://add/sub://'
    const href = clientImportLink('shadowrocket', link)
    expect(href?.startsWith(prefix)).toBe(true)
    expect(new TextDecoder().decode(Uint8Array.from(atob(href!.slice(prefix.length)), char => char.charCodeAt(0)))).toBe(link)
  })

  it('returns no scheme for empty URLs or unsupported clients', () => {
    expect(clientImportLink('clash', '')).toBeNull()
    for (const client of ['auto', 'generic', 'singbox', 'karing', 'quantumultx', 'v2rayn', 'nekobox', 'v2rayng', 'toString']) {
      expect(clientImportLink(client, link)).toBeNull()
    }
  })
})

describe('device-based import ordering', () => {
  it.each([
    ['iPhone; CPU iPhone OS', 0, 'ios', ['stash', 'surge', 'loon', 'shadowrocket']],
    ['iPad; CPU OS', 0, 'ios', ['stash', 'surge', 'loon', 'shadowrocket']],
    ['Macintosh; Intel Mac OS X', 5, 'ios', ['stash', 'surge', 'loon', 'shadowrocket']],
    ['Linux; Android 15', 0, 'android', ['mihomo', 'clash', 'clash-meta']],
    ['Windows NT 10.0', 0, 'windows', ['mihomo', 'clash', 'clash-meta']],
    ['Macintosh; Intel Mac OS X', 0, 'macos', ['mihomo', 'clash', 'clash-meta', 'stash', 'surge']],
    ['X11; Linux x86_64', 0, 'linux', ['mihomo', 'clash', 'clash-meta']],
    ['', 0, 'unknown', ['mihomo', 'clash', 'shadowrocket']],
  ] as const)('classifies %s with %i touch points', (ua, touchPoints, expectedDevice, preferred) => {
    const device = detectImportDevice(ua, touchPoints)
    expect(device).toBe(expectedDevice)
    const clients = ['mihomo', 'clash', 'clash-meta', 'stash', 'surge', 'loon', 'shadowrocket', 'singbox']
    expect(clients.filter(client => prefersClientImport(device, client))).toEqual(preferred)
  })
})
