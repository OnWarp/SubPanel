import { describe, expect, it } from 'vitest'
import manifest from '../fixtures/import/manifest.json'
import loonNodes from '../fixtures/import/loon-nodes.conf?raw'
import mihomoBare from '../fixtures/import/mihomo-bare.yaml?raw'
import mihomoProvider from '../fixtures/import/mihomo-provider.yaml?raw'
import mihomoProxies from '../fixtures/import/mihomo-proxies.yaml?raw'
import quantumultXNodes from '../fixtures/import/quantumultx-nodes.conf?raw'
import quantumultXServers from '../fixtures/import/quantumultx-servers.txt?raw'
import singBox from '../fixtures/import/sing-box.json?raw'
import singBoxOutbounds from '../fixtures/import/sing-box-outbounds.json?raw'
import sip008 from '../fixtures/import/sip008.json?raw'
import uriListBase64 from '../fixtures/import/uri-list-base64.txt?raw'
import uriList from '../fixtures/import/uri-list.txt?raw'
import uriLossless from '../fixtures/import/uri-lossless.txt?raw'
import surgeNodes from '../fixtures/import/surge-nodes.conf?raw'
import { detectImport } from '../../../worker/import/detect.js'

type FixtureManifestEntry = {
  file: string
  upstreamUrl: string
  ref: string
  formats: string[]
  expectedFormat: string
  expectedNodes: number
  highValueFields: string[]
  coveredFields: string[]
  omissions: string[]
}

const fixtures = new Map<string, string>([
  ['loon-nodes.conf', loonNodes],
  ['mihomo-bare.yaml', mihomoBare],
  ['mihomo-provider.yaml', mihomoProvider],
  ['mihomo-proxies.yaml', mihomoProxies],
  ['quantumultx-nodes.conf', quantumultXNodes],
  ['quantumultx-servers.txt', quantumultXServers],
  ['sing-box.json', singBox],
  ['sing-box-outbounds.json', singBoxOutbounds],
  ['sip008.json', sip008],
  ['uri-list-base64.txt', uriListBase64],
  ['uri-list.txt', uriList],
  ['uri-lossless.txt', uriLossless],
  ['surge-nodes.conf', surgeNodes],
])

function hasPath(value: unknown, path: string): boolean {
  let current: unknown = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(key in current)) return false
    current = (current as Record<string, unknown>)[key]
  }
  return current !== undefined
}

describe('catalog import fixtures', () => {
  it('keeps every sanitized fixture traceable to a locked upstream source', () => {
    const entries = manifest as FixtureManifestEntry[]
    expect(entries.map(({ file }) => file).toSorted()).toEqual([...fixtures.keys()].toSorted())

    for (const entry of entries) {
      expect(entry.upstreamUrl).toMatch(/^https:\/\//)
      expect(entry.ref).not.toBe('')
      expect(entry.formats.length).toBeGreaterThan(0)
      expect(entry.coveredFields.length).toBeGreaterThan(0)
      expect(fixtures.get(entry.file)).toBeTruthy()
    }
  })

  it('uses only reserved example endpoints and synthetic credentials', () => {
    for (const content of fixtures.values()) {
      expect(content).not.toMatch(/localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\./i)
      expect(content).not.toMatch(/bearer\s+|-----BEGIN (?:PRIVATE|OPENSSH)|cloudflare|setup-token/i)
    }
  })

  it('locks the detected container and normalized node inventory for every fixture', () => {
    for (const entry of manifest as FixtureManifestEntry[]) {
      const content = fixtures.get(entry.file)!
      const result = detectImport(content)
      expect(result.format, entry.file).toBe(entry.expectedFormat)
      expect(result.nodes, entry.file).toHaveLength(entry.expectedNodes)
      for (const field of entry.highValueFields) {
        expect(result.nodes.some((node) => hasPath(node, field)), `${entry.file}: ${field}`).toBe(true)
      }
      expect(entry.coveredFields.length, entry.file).toBeGreaterThan(0)
      expect(result.nodes.every((node) => node.raw.length > 0), entry.file).toBe(true)
    }
  })
})
