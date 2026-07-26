import { describe, expect, it } from 'vitest'
import {
  catalogSnapshotSchema,
  type CatalogSnapshot,
  type Node,
} from '../../../worker/catalog/schema'
import { resolveGroupNodes } from '../../../worker/catalog/groups'

const NOW = '2026-07-23T00:00:00.000Z'

function node(id: `node_${number}`, sourceIds: `src_${number}`[], enabled: boolean, order: number, retained = false): Node {
  return {
    id,
    protocol: 'shadowsocks',
    displayName: id,
    server: `${id}.example.com`,
    port: 8388,
    credentials: { method: 'aes-128-gcm', password: id },
    extensions: {},
    fingerprint: `fp-${id}`,
    sourceIds,
    rawVariants: sourceIds.map((sourceId) => ({ sourceId, format: 'uri-list', raw: id, extensions: {} })),
    enabled,
    retained,
    order,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function snapshot(): CatalogSnapshot {
  return catalogSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 1,
    updatedAt: NOW,
    nextSourceId: 3,
    nextNodeId: 9,
    nextGroupId: 2,
    sources: [
      { id: 'src_1', name: 'One', type: 'manual', enabled: true, warnings: [], createdAt: NOW, updatedAt: NOW },
      { id: 'src_2', name: 'Two', type: 'file', enabled: true, warnings: [], createdAt: NOW, updatedAt: NOW },
    ],
    nodes: [
      node('node_1', ['src_1'], true, 1),
      node('node_2', ['src_1', 'src_2'], true, 2),
      node('node_3', ['src_2'], false, 3),
      node('node_4', ['src_2'], true, 4),
      node('node_5', ['src_1'], true, 5),
      node('node_6', [], true, 6, true),
      node('node_7', ['src_1'], true, 7),
      node('node_8', ['src_1'], false, 8),
    ],
    groups: [{
      id: 'grp_1',
      name: 'Selected',
      sourceIds: ['src_2', 'src_1'],
      includedNodeIds: ['node_6'],
      excludedNodeIds: ['node_3', 'node_7'],
      nodeOrder: ['node_4', 'node_1'],
      createdAt: NOW,
      updatedAt: NOW,
    }],
  })
}

describe('catalog group resolution', () => {
  it('applies source union, inclusion, exclusion, enablement, dedupe, and stable ordering', () => {
    const current = snapshot()
    const resolved = resolveGroupNodes(current, 'grp_1')
    expect(resolved.map(({ id }) => id)).toEqual(['node_4', 'node_1', 'node_2', 'node_5', 'node_6'])
  })

  it('fails for missing group IDs without mutating the snapshot', () => {
    const current = snapshot()
    const before = JSON.stringify(current)
    expect(() => resolveGroupNodes(current, 'grp_404')).toThrow('GROUP_NOT_FOUND')
    expect(JSON.stringify(current)).toBe(before)
  })
})
