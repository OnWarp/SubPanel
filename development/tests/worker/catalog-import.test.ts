import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { readCatalog, writeCatalog } from '../../../worker/catalog/repository'
import {
  createSource,
  refreshSource,
  replaceSourceContent,
  summarizeSources,
  updateSource,
} from '../../../worker/catalog/import-service'
import { decryptText, readCryptoMaterial } from '../../../worker/platform/crypto'
import { resetData } from './helpers'

const NOW = '2026-07-23T00:00:00.000Z'

const ssLine = (name: string, password = 'password', host = 'ss.example.com') =>
  `ss://${btoa(`aes-128-gcm:${password}`)}@${host}:8388#${encodeURIComponent(name)}`

const vlessLine = (name: string, path: string) =>
  `vless://22222222-2222-4222-8222-222222222222@vless.example.com:443?encryption=none&security=tls&sni=vless.example.com&type=ws&host=cdn.example.com&path=${encodeURIComponent(path)}#${encodeURIComponent(name)}`

beforeEach(resetData)

describe('catalog import service', () => {
  it('does not initialize crypto material when an import is rejected', async () => {
    await expect(createSource(env.DATA, { type: 'manual', name: 'Invalid', content: 'not a supported import' }, { now: NOW }))
      .rejects.toThrow('UNSUPPORTED_IMPORT_FORMAT')
    expect(await env.DATA.get('system:crypto')).toBeNull()
  })

  it('enforces source name limits in the service layer', async () => {
    await expect(createSource(env.DATA, {
      type: 'manual',
      name: 'x'.repeat(129),
      content: ssLine('Valid content'),
    }, { now: NOW })).rejects.toThrow('CATALOG_SOURCE_INVALID')
  })

  it('encrypts manual and file content before writing the Catalog', async () => {
    for (const type of ['manual', 'file'] as const) {
      const content = ssLine(`${type} source`)
      const result = await createSource(env.DATA, { type, name: `${type} source`, content }, { now: NOW })
      const catalog = await readCatalog(env.DATA)
      const source = catalog.sources.find(({ id }) => id === result.source.id)!
      const material = await readCryptoMaterial(env.DATA)
      expect(source.encryptedContent).toBeDefined()
      await expect(decryptText(source.encryptedContent!, material.encryptionKey)).resolves.toBe(content)
      expect(source).not.toHaveProperty('content')
    }
  })

  it('encrypts remote URL and custom headers and never returns them in summaries', async () => {
    const url = 'https://feed.example.com/subscription?token=url-secret'
    const headers = { Authorization: 'header-secret' }
    const fetcher: typeof fetch = async () => new Response(ssLine('Remote SS'))
    const result = await createSource(env.DATA, {
      type: 'remote',
      name: 'Remote source',
      url,
      headers,
      refreshIntervalMinutes: 30,
    }, { now: NOW, fetcher })

    const catalog = await readCatalog(env.DATA)
    const source = catalog.sources[0]
    const material = await readCryptoMaterial(env.DATA)
    await expect(decryptText(source.encryptedUrl!, material.encryptionKey)).resolves.toBe(url)
    await expect(decryptText(source.encryptedHeaders!, material.encryptionKey)).resolves.toBe(JSON.stringify(headers))
    expect(JSON.stringify(result.source)).not.toContain(url)
    expect(JSON.stringify(result.source)).not.toContain('url-secret')
    expect(JSON.stringify(result.source)).not.toContain('header-secret')
  })

  it('still summarizes remote sources when crypto material is temporarily unavailable', async () => {
    await createSource(env.DATA, {
      type: 'remote',
      name: 'Remote source',
      url: 'https://feed.example.com/subscription',
      headers: {},
      refreshIntervalMinutes: 15,
    }, { now: NOW, fetcher: async () => new Response(ssLine('Remote SS')) })
    await env.DATA.delete('system:crypto')
    const catalog = await readCatalog(env.DATA)
    await expect(summarizeSources(env.DATA, catalog.sources))
      .resolves.toMatchObject([{ id: 'src_1', remoteHost: undefined }])
  })

  it('allows remote metadata edits without decrypting URL or headers', async () => {
    const created = await createSource(env.DATA, {
      type: 'remote',
      name: 'Remote source',
      url: 'https://feed.example.com/subscription',
      headers: {},
      refreshIntervalMinutes: 15,
    }, { now: NOW, fetcher: async () => new Response(ssLine('Remote SS')) })
    await env.DATA.delete('system:crypto')

    await expect(updateSource(env.DATA, created.source.id, { enabled: false }, { now: `${NOW.slice(0, 10)}T01:00:00.000Z` }))
      .resolves.toMatchObject({ success: true, source: { enabled: false, remoteHost: undefined } })
  })

  it('merges identical identities from two sources while retaining both raw variants', async () => {
    await createSource(env.DATA, { type: 'manual', name: 'One', content: ssLine('One') }, { now: NOW })
    await createSource(env.DATA, { type: 'file', name: 'Two', content: ssLine('Two') }, { now: NOW })
    const catalog = await readCatalog(env.DATA)
    expect(catalog.nodes).toHaveLength(1)
    expect(catalog.nodes[0].sourceIds).toEqual(['src_1', 'src_2'])
    expect(catalog.nodes[0].rawVariants.map(({ sourceId }) => sourceId)).toEqual(['src_1', 'src_2'])
  })

  it('keeps separate nodes when authentication or transport differs', async () => {
    await createSource(env.DATA, {
      type: 'manual',
      name: 'Differences',
      content: [ssLine('Password one', 'one'), ssLine('Password two', 'two'), vlessLine('Path one', '/one'), vlessLine('Path two', '/two')].join('\n'),
    }, { now: NOW })
    expect((await readCatalog(env.DATA)).nodes).toHaveLength(4)
  })

  it('removes only the refreshed source association and deletes orphan nodes', async () => {
    const shared = ssLine('Shared')
    const orphan = ssLine('Orphan', 'orphan-password', 'orphan.example.com')
    const retained = ssLine('Retained', 'retained-password', 'retained.example.com')
    const first = await createSource(env.DATA, { type: 'manual', name: 'First', content: `${shared}\n${orphan}\n${retained}` }, { now: NOW })
    await createSource(env.DATA, { type: 'file', name: 'Second', content: shared }, { now: NOW })

    const before = await readCatalog(env.DATA)
    before.nodes.find(({ server }) => server === 'retained.example.com')!.retained = true
    await writeCatalog(env.DATA, before, '2026-07-23T00:30:00.000Z')

    await replaceSourceContent(env.DATA, first.source.id, shared, { now: '2026-07-23T01:00:00.000Z' })
    const catalog = await readCatalog(env.DATA)
    expect(catalog.nodes).toHaveLength(2)
    expect(catalog.nodes.find(({ server }) => server === 'ss.example.com')?.sourceIds).toEqual(['src_1', 'src_2'])
    expect(catalog.nodes.find(({ server }) => server === 'retained.example.com')).toMatchObject({ sourceIds: [], rawVariants: [] })
  })

  it('preserves stable IDs and order across refreshes', async () => {
    const first = ssLine('First', 'first', 'first.example.com')
    const second = ssLine('Second', 'second', 'second.example.com')
    const created = await createSource(env.DATA, { type: 'manual', name: 'Stable', content: `${first}\n${second}` }, { now: NOW })
    const before = await readCatalog(env.DATA)
    const identities = new Map(before.nodes.map((node) => [node.server, { id: node.id, order: node.order }]))

    const third = ssLine('Third', 'third', 'third.example.com')
    await replaceSourceContent(env.DATA, created.source.id, `${second}\n${first}\n${third}`, { now: '2026-07-23T01:00:00.000Z' })
    const after = await readCatalog(env.DATA)
    expect(after.nodes.find(({ server }) => server === 'first.example.com')).toMatchObject(identities.get('first.example.com')!)
    expect(after.nodes.find(({ server }) => server === 'second.example.com')).toMatchObject(identities.get('second.example.com')!)
    expect(after.nodes.find(({ server }) => server === 'third.example.com')?.order).toBe(3)
  })

  it('preserves last-good content after fetch, parse, or zero-node failure', async () => {
    const initial: typeof fetch = async () => new Response(ssLine('Last good'))
    const created = await createSource(env.DATA, {
      type: 'remote',
      name: 'Last good',
      url: 'https://feed.example.com/source',
      headers: {},
      refreshIntervalMinutes: 15,
    }, { now: NOW, fetcher: initial })
    const before = await readCatalog(env.DATA)
    const sourceBefore = before.sources[0]
    const nodeIds = before.nodes.map(({ id }) => id)

    const failures: Array<typeof fetch> = [
      async () => { throw new Error('network failure') },
      async () => new Response('not a supported import'),
      async () => new Response(JSON.stringify([{ type: 'direct' }])),
    ]
    for (const [index, fetcher] of failures.entries()) {
      const result = await refreshSource(env.DATA, created.source.id, {
        now: `2026-07-23T0${index + 1}:00:00.000Z`,
        fetcher,
      })
      expect(result.success).toBe(false)
      const after = await readCatalog(env.DATA)
      expect(after.sources[0].encryptedContent).toEqual(sourceBefore.encryptedContent)
      expect(after.sources[0].lastSuccessAt).toBe(sourceBefore.lastSuccessAt)
      expect(after.nodes.map(({ id }) => id)).toEqual(nodeIds)
    }
  })

  it('rejects an import that would exceed 100 nodes', async () => {
    const content = Array.from({ length: 101 }, (_, index) => ssLine(`Node ${index}`, `password-${index}`, `node-${index}.example.com`)).join('\n')
    await expect(createSource(env.DATA, { type: 'manual', name: 'Too many', content }, { now: NOW })).rejects.toThrow('CATALOG_NODE_LIMIT')
    expect(await env.DATA.get('state:catalog')).toBeNull()
  })
})
