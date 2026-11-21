import type { CatalogSnapshot, Group, Node } from './schema.js'

export function resolveGroupCandidates(snapshot: CatalogSnapshot, group: Group): Node[] {
  const sources = new Set(snapshot.sources
    .filter((source) => source.enabled && group.sourceIds.includes(source.id))
    .map(({ id }) => id))
  const included = new Set(group.includedNodeIds)
  const excluded = new Set(group.excludedNodeIds)
  const { tags, protocols, region, namePattern } = group.rules ?? {}
  const name = namePattern ? new RegExp(namePattern, 'iu') : undefined
  const dynamic = Boolean(tags?.length || protocols?.length || region || name)
  return snapshot.nodes.filter((node) => !excluded.has(node.id) && (
    included.has(node.id) ||
    node.sourceIds.some((id) => sources.has(id)) ||
    (dynamic && (node.retained || node.sourceIds.length === 0 ||
      node.sourceIds.some((id) => snapshot.sources.some((source) => source.id === id && source.enabled))) &&
      (!tags?.length || tags.every((tag) => node.tags?.includes(tag))) &&
      (!protocols?.length || protocols.includes(node.protocol)) &&
      (!region || region.toLowerCase() === node.region?.toLowerCase()) &&
      (!name || name.test(node.displayName)))
  ))
}

export function resolveGroupNodes(snapshot: CatalogSnapshot, groupId: string): Node[] {
  const group = snapshot.groups.find(({ id }) => id === groupId)
  if (!group) throw new Error('GROUP_NOT_FOUND')

  const explicitRank = new Map(group.nodeOrder.map((id, index) => [id, index]))
  const sourceRank = new Map(group.sourceIds.map((id, index) => [id, index]))
  return resolveGroupCandidates(snapshot, group)
    .filter((node) => node.enabled)
    .sort((left, right) => {
      const leftOrder = explicitRank.get(left.id) ?? Infinity
      const rightOrder = explicitRank.get(right.id) ?? Infinity
      const leftSource = Math.min(...left.sourceIds.map((id) => sourceRank.get(id) ?? Infinity))
      const rightSource = Math.min(...right.sourceIds.map((id) => sourceRank.get(id) ?? Infinity))
      return leftOrder - rightOrder || leftSource - rightSource || left.order - right.order || left.id.localeCompare(right.id)
    })
}
