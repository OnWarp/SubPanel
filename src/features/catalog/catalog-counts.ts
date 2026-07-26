import type { AdminSubscription, CatalogGroup, CatalogNode, CatalogSource } from '../../app/api'

export function groupNodeIds(group: CatalogGroup, sources: CatalogSource[], nodes: CatalogNode[]): Set<string> {
  const enabledSources = new Set(sources.filter((source) => source.enabled && group.sourceIds.includes(source.id)).map((source) => source.id))
  const candidates = new Set(nodes.filter((node) => node.sourceIds.some((id) => enabledSources.has(id))).map((node) => node.id))
  for (const id of group.includedNodeIds) candidates.add(id)
  for (const id of group.excludedNodeIds) candidates.delete(id)
  const enabledNodes = new Set(nodes.filter((node) => node.enabled).map((node) => node.id))
  return new Set([...candidates].filter((id) => enabledNodes.has(id)))
}

export function subscriptionCounts(subscription: AdminSubscription, groups: CatalogGroup[], sources: CatalogSource[], nodes: CatalogNode[]) {
  const selectedGroups = groups.filter((group) => subscription.groupIds.includes(group.id))
  const sourceIds = new Set(selectedGroups.flatMap((group) => group.sourceIds))
  const nodeIds = new Set(selectedGroups.flatMap((group) => [...groupNodeIds(group, sources, nodes)]))
  return { groups: selectedGroups.length, sources: sourceIds.size, nodes: nodeIds.size }
}
