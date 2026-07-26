import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { readCatalog, CATALOG_KEY } from '../../../worker/catalog/repository'
import { catalogSnapshotSchema, emptyCatalogSnapshot } from '../../../worker/catalog/schema'
import { resetData } from './helpers'

const NOW = '2026-07-25T00:00:00.000Z'

beforeEach(resetData)

describe('catalog snapshot migration', () => {
  it('rejects ID counters that can allocate an existing identifier', () => {
    const snapshot = emptyCatalogSnapshot(NOW)
    snapshot.sources = [{
      id: 'src_1',
      name: 'source',
      type: 'manual',
      enabled: true,
      warnings: [],
      createdAt: NOW,
      updatedAt: NOW,
    }]
    snapshot.nextSourceId = 1
    expect(() => catalogSnapshotSchema.parse(snapshot)).toThrow()
  })

  it('upgrades a v1 snapshot without losing rich node fields', async () => {
    await env.DATA.put(CATALOG_KEY, JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      updatedAt: NOW,
      nextSourceId: 2,
      nextNodeId: 2,
      nextGroupId: 1,
      sources: [{
        id: 'src_1',
        name: 'legacy',
        type: 'manual',
        enabled: true,
        warnings: [],
        createdAt: NOW,
        updatedAt: NOW,
      }],
      nodes: [{
        id: 'node_1',
        protocol: 'vless',
        displayName: 'Reality',
        server: 'example.com',
        port: 443,
        credentials: { uuid: '11111111-1111-4111-8111-111111111111' },
        tls: {
          enabled: true,
          certificate: '-----BEGIN CERTIFICATE-----',
          reality: { publicKey: 'public-key', shortId: 'short-id' },
        },
        transport: { type: 'ws', path: '/edge', headers: { Host: 'cdn.example.com' } },
        extensions: { flow: 'xtls-rprx-vision', custom: ['keep', true] },
        fingerprint: 'legacy-fingerprint',
        sourceIds: ['src_1'],
        rawVariants: [{ sourceId: 'src_1', format: 'uri-list', raw: 'vless://legacy', extensions: { cert: 'raw-cert' } }],
        enabled: true,
        retained: false,
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      groups: [],
    }))

    const snapshot = await readCatalog(env.DATA)

    expect(snapshot.schemaVersion).toBe(2)
    expect(snapshot.revision).toBe(4)
    expect(snapshot.nodes[0]).toMatchObject({
      protocol: 'vless',
      credentials: { uuid: '11111111-1111-4111-8111-111111111111' },
      tls: { certificate: '-----BEGIN CERTIFICATE-----', reality: { publicKey: 'public-key', shortId: 'short-id' } },
      transport: { type: 'ws', path: '/edge' },
      extensions: { flow: 'xtls-rprx-vision', custom: ['keep', true] },
    })
    expect(snapshot.nodes[0].rawVariants[0].extensions).toEqual({ cert: 'raw-cert' })
  })

  it('rejects an unknown snapshot version as corrupt', async () => {
    await env.DATA.put(CATALOG_KEY, JSON.stringify({ schemaVersion: 99 }))
    await expect(readCatalog(env.DATA)).rejects.toThrow('Catalog snapshot is corrupt')
  })
})
