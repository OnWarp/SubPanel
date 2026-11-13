import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
import { enableD1Modules, resetData } from './helpers'

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

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
})
afterEach(() => vi.restoreAllMocks())

describe('catalog snapshot repository', () => {
  it('returns an empty catalog when no rows are stored', async () => {
    expect(await readCatalog(env)).toEqual(emptyCatalogSnapshot())
  })

  it('rejects corrupt JSON and invalid references', async () => {
    await writeCatalog(env, validSnapshot(), NOW)
    await env.DB.prepare(`UPDATE sources SET warnings = ? WHERE id = ?`).bind('[1]', 'src_1').run()
    await expect(readCatalog(env)).rejects.toThrow('Catalog snapshot is corrupt')

    await enableD1Modules()
    await writeCatalog(env, validSnapshot(), NOW)
    await env.DB.prepare(`UPDATE nodes SET source_ids = ? WHERE id = ?`).bind('["src_2"]', 'node_1').run()
    await expect(readCatalog(env)).rejects.toThrow('Catalog snapshot is corrupt')
  })

  it('increments revision after a validated write', async () => {
    const saved = await writeCatalog(env, validSnapshot(), NOW)
    expect(saved.revision).toBe(1)
    expect(saved.updatedAt).toBe(NOW)
    expect(await readCatalog(env)).toEqual(saved)
    expect(await env.DATA.get(CATALOG_KEY)).toBeNull()
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
    await expect(writeCatalog(env, snapshot, NOW)).rejects.toThrow('Catalog snapshot validation failed')
  })

  it('rejects a serialized snapshot larger than 20 MiB before KV put', async () => {
    const snapshot = validSnapshot()
    snapshot.nodes[0].rawVariants[0].raw = 'x'.repeat(MAX_CATALOG_BYTES)
    const put = vi.spyOn(env.DATA, 'put')

    await expect(writeCatalog(env, snapshot, NOW)).rejects.toThrow('Catalog snapshot is too large')
    expect(put).not.toHaveBeenCalled()
  })
})
