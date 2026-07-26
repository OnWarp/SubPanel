import { describe, expect, it } from 'vitest'
import type { AdminSubscription, CatalogGroup, CatalogNode, CatalogSource } from '../../../src/app/api'
import { groupNodeIds, subscriptionCounts } from '../../../src/features/catalog/catalog-counts'

const now = '2026-07-27T00:00:00.000Z'
const sources: CatalogSource[] = [
  { id: 'source-a', name: 'A', type: 'manual', enabled: true, warnings: [], createdAt: now, updatedAt: now },
  { id: 'source-b', name: 'B', type: 'manual', enabled: false, warnings: [], createdAt: now, updatedAt: now },
]
const nodes: CatalogNode[] = [
  { id: 'node-a', protocol: 'ss', displayName: 'A', server: 'a.test', port: 1, sourceIds: ['source-a'], enabled: true, retained: false, order: 1, createdAt: now, updatedAt: now },
  { id: 'node-b', protocol: 'ss', displayName: 'B', server: 'b.test', port: 2, sourceIds: ['source-b'], enabled: true, retained: false, order: 2, createdAt: now, updatedAt: now },
  { id: 'node-c', protocol: 'ss', displayName: 'C', server: 'c.test', port: 3, sourceIds: [], enabled: true, retained: true, order: 3, createdAt: now, updatedAt: now },
  { id: 'node-d', protocol: 'ss', displayName: 'D', server: 'd.test', port: 4, sourceIds: ['source-a'], enabled: false, retained: false, order: 4, createdAt: now, updatedAt: now },
]
const groups: CatalogGroup[] = [
  { id: 'group-a', name: 'A', sourceIds: ['source-a', 'source-b'], includedNodeIds: ['node-c'], excludedNodeIds: [], nodeOrder: [], createdAt: now, updatedAt: now },
  { id: 'group-b', name: 'B', sourceIds: ['source-a'], includedNodeIds: [], excludedNodeIds: ['node-a'], nodeOrder: [], createdAt: now, updatedAt: now },
]

describe('catalog counts', () => {
  it('matches effective group node resolution', () => {
    expect([...groupNodeIds(groups[0], sources, nodes)]).toEqual(['node-a', 'node-c'])
  })

  it('deduplicates subscription groups, sources and effective nodes', () => {
    const subscription = { groupIds: ['group-a', 'group-b'] } as AdminSubscription
    expect(subscriptionCounts(subscription, groups, sources, nodes)).toEqual({ groups: 2, sources: 2, nodes: 2 })
  })
})
