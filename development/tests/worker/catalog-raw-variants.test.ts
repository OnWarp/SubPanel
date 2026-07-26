import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSource, replaceSourceContent } from '../../../worker/catalog/import-service'
import { readCatalog } from '../../../worker/catalog/repository'
import { resetData } from './helpers'

const NOW = '2026-07-25T00:00:00.000Z'
const uuid = '22222222-2222-4222-8222-222222222222'

function vless(name: string, certificate = 'CERT-A'): string {
  return `vless://${uuid}@reality.example.com:443?encryption=none&security=reality&sni=www.example.com&pbk=public-key&sid=short-id&cert=${encodeURIComponent(certificate)}#${encodeURIComponent(name)}`
}

beforeEach(resetData)

describe('catalog raw variant aggregation', () => {
  it('retains every raw representation from the same source while deduplicating identity', async () => {
    await createSource(env.DATA, {
      type: 'manual',
      name: 'Variants',
      content: `${vless('First name')}\n${vless('Second name')}`,
    }, { now: NOW })

    const catalog = await readCatalog(env.DATA)
    expect(catalog.nodes).toHaveLength(1)
    expect(catalog.nodes[0].sourceIds).toEqual(['src_1'])
    expect(catalog.nodes[0].rawVariants.map(({ raw }) => raw)).toEqual([
      vless('First name'),
      vless('Second name'),
    ])
  })

  it('treats certificate and Reality changes as distinct identities and removes only refreshed variants', async () => {
    const first = await createSource(env.DATA, {
      type: 'manual',
      name: 'One',
      content: `${vless('Certificate A', 'CERT-A')}\n${vless('Certificate B', 'CERT-B')}`,
    }, { now: NOW })
    await createSource(env.DATA, {
      type: 'file',
      name: 'Two',
      content: vless('Shared A', 'CERT-A'),
    }, { now: NOW })

    let catalog = await readCatalog(env.DATA)
    expect(catalog.nodes).toHaveLength(2)
    expect(new Set(catalog.nodes.map(({ fingerprint }) => fingerprint)).size).toBe(2)
    expect(catalog.nodes.find(({ tls }) => tls?.certificate === 'CERT-A')?.sourceIds).toEqual(['src_1', 'src_2'])

    await replaceSourceContent(env.DATA, first.source.id, vless('Only B', 'CERT-B'), { now: '2026-07-25T01:00:00.000Z' })
    catalog = await readCatalog(env.DATA)
    expect(catalog.nodes).toHaveLength(2)
    expect(catalog.nodes.find(({ tls }) => tls?.certificate === 'CERT-A')?.sourceIds).toEqual(['src_2'])
    expect(catalog.nodes.find(({ tls }) => tls?.certificate === 'CERT-B')?.sourceIds).toEqual(['src_1'])
  })
})

