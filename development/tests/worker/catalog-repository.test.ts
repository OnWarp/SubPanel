import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  catalogSnapshotSchema,
  emptyCatalogSnapshot,
  type CatalogSnapshot,
} from '../../../worker/catalog/schema'
import {
  CATALOG_KEY,
  MAX_CATALOG_BYTES,
  MAX_NODES,
  readCatalog,
  writeCatalog,
} from '../../../worker/catalog/repository'
import { resetData } from './helpers'

const NOW = '2026-07-23T00:00:00.000Z'
const ENCRYPTED = {
  version: 1 as const,
  algorithm: 'AES-GCM' as const,
  iv: 'A'.repeat(16),
  ciphertext: 'B'.repeat(32),
}

function validSnapshot(): CatalogSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: NOW,
    nextSourceId: 2,
    nextNodeId: 2,
    nextGroupId: 2,
    sources: [
      {
        id: 'src_1',
        name: 'Fixture source',
        type: 'manual',
        enabled: true,
        encryptedContent: ENCRYPTED,
        warnings: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    nodes: [
      {
        id: 'node_1',
        protocol: 'shadowsocks',
        displayName: 'Fixture node',
        server: 'ss.example.com',
        port: 8388,
        credentials: { password: 'password', method: 'aes-128-gcm' },
        extensions: {},
        fingerprint: 'fp_fixture',
        sourceIds: ['src_1'],
        rawVariants: [{ sourceId: 'src_1', format: 'uri-list', raw: 'ss://fixture', extensions: {} }],
        enabled: true,
        retained: false,
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    groups: [
      {
        id: 'grp_1',
        name: 'All fixtures',
        sourceIds: ['src_1'],
        includedNodeIds: ['node_1'],
        excludedNodeIds: [],
        nodeOrder: ['node_1'],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  }
}

beforeEach(resetData)
afterEach(() => vi.restoreAllMocks())

describe('catalog snapshot repository', () => {
  it('returns an empty catalog when state:catalog is absent', async () => {
    expect(await readCatalog(env.DATA)).toEqual(emptyCatalogSnapshot())
  })

  it('rejects corrupt JSON and invalid references', async () => {
    await env.DATA.put(CATALOG_KEY, '{broken')
    await expect(readCatalog(env.DATA)).rejects.toThrow('Catalog snapshot is corrupt')

    await env.DATA.put(CATALOG_KEY, JSON.stringify({
      ...validSnapshot(),
      nodes: [{ ...validSnapshot().nodes[0], sourceIds: ['src_2'] }],
    }))
    await expect(readCatalog(env.DATA)).rejects.toThrow('Catalog snapshot is corrupt')
  })

  it('increments revision after a validated write', async () => {
    const saved = await writeCatalog(env.DATA, validSnapshot(), NOW)
    expect(saved.revision).toBe(1)
    expect(saved.updatedAt).toBe(NOW)
    expect(catalogSnapshotSchema.parse(JSON.parse((await env.DATA.get(CATALOG_KEY))!))).toEqual(saved)
  })

  it('rejects more than 100 logical nodes', async () => {
    const snapshot = validSnapshot()
    snapshot.nodes = Array.from({ length: MAX_NODES + 1 }, (_, index) => ({
      ...snapshot.nodes[0],
      id: `node_${index + 1}`,
      fingerprint: `fp_${index + 1}`,
      order: index + 1,
      rawVariants: [{ ...snapshot.nodes[0].rawVariants[0] }],
    }))
    snapshot.nextNodeId = MAX_NODES + 2
    await expect(writeCatalog(env.DATA, snapshot, NOW)).rejects.toThrow('Catalog snapshot validation failed')
  })

  it('rejects a serialized snapshot larger than 20 MiB before KV put', async () => {
    const snapshot = validSnapshot()
    snapshot.nodes[0].rawVariants[0].raw = 'x'.repeat(MAX_CATALOG_BYTES)
    const put = vi.spyOn(env.DATA, 'put')

    await expect(writeCatalog(env.DATA, snapshot, NOW)).rejects.toThrow('Catalog snapshot is too large')
    expect(put).not.toHaveBeenCalled()
  })
})
