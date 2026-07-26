import type { CatalogSnapshot, Node } from './schema.js'

export function resolveGroupNodes(snapshot: CatalogSnapshot, groupId: string): Node[] {
  const group = snapshot.groups.find(({ id }) => id === groupId)
  if (!group) throw new Error('GROUP_NOT_FOUND')

  const enabledSources = new Set(
    snapshot.sources
      .filter((source) => source.enabled && group.sourceIds.includes(source.id))
      .map(({ id }) => id),
  )
  const candidates = new Set<string>()
  for (const node of snapshot.nodes) {
    if (node.sourceIds.some((sourceId) => enabledSources.has(sourceId))) candidates.add(node.id)
  }
  for (const nodeId of group.includedNodeIds) candidates.add(nodeId)
  for (const nodeId of group.excludedNodeIds) candidates.delete(nodeId)

  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const remaining = new Set(
    [...candidates].filter((nodeId) => byId.get(nodeId)?.enabled),
  )
  const resolved: Node[] = []
  for (const nodeId of group.nodeOrder) {
    if (!remaining.delete(nodeId)) continue
    resolved.push(byId.get(nodeId)!)
  }

  const sourceRank = new Map(group.sourceIds.map((sourceId, index) => [sourceId, index]))
  const append = [...remaining]
    .map((nodeId) => byId.get(nodeId)!)
    .sort((left, right) => {
      const leftRank = Math.min(...left.sourceIds.map((sourceId) => sourceRank.get(sourceId) ?? Number.POSITIVE_INFINITY))
      const rightRank = Math.min(...right.sourceIds.map((sourceId) => sourceRank.get(sourceId) ?? Number.POSITIVE_INFINITY))
      return leftRank - rightRank || left.order - right.order || left.id.localeCompare(right.id)
    })
  return [...resolved, ...append]
}
