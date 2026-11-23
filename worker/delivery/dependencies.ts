import type { CatalogSnapshot, Node } from '../catalog/schema.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import type { RenderClient } from '../renderers/model.js'
import { hashToken } from '../platform/crypto.js'

// Order and raw URI fallbacks affect the output. Import timestamps and source
// metadata are irrelevant once group membership and node order are resolved.
function renderNodeInput(node: Node, includeRaw = true) {
  return [
    node.id, node.protocol, node.displayName, node.server, node.port, node.credentials,
    node.tls, node.transport, node.plugin, node.extensions, includeRaw ? node.rawVariants.map(({ raw }) => raw) : null,
  ]
}

export const SPEED_LIMIT_CLIENTS: ReadonlySet<RenderClient> = new Set(['mihomo', 'singbox', 'surge'])
const structuredClients: ReadonlySet<RenderClient> = new Set(['mihomo', 'singbox', 'surge', 'loon'])

export function catalogRelevantRevision(nodes: readonly Node[], speed: number, platform: RenderClient) {
  const effectiveSpeed = SPEED_LIMIT_CLIENTS.has(platform) && nodes.some(node =>
    node.protocol === 'hysteria' || node.protocol === 'hysteria2') ? speed : 0
  return hashToken(JSON.stringify([effectiveSpeed, nodes.map(node => renderNodeInput(node, !structuredClients.has(platform)))]))
}

export function catalogDependencyChange(before: CatalogSnapshot, after: CatalogSnapshot) {
  const previous = new Map(before.nodes.map(node => [node.id, JSON.stringify(renderNodeInput(node))]))
  const current = new Map(after.nodes.map(node => [node.id, JSON.stringify(renderNodeInput(node))]))
  const nodeIds = [...new Set([...previous.keys(), ...current.keys()])]
    .filter(id => previous.get(id) !== current.get(id))
  const changedNodes = new Set(nodeIds)
  const membershipInputs = (snapshot: CatalogSnapshot) => JSON.stringify([
    snapshot.sources.map(source => [source.id, source.enabled]),
    snapshot.nodes.map(node => [node.id, node.enabled, node.order, node.sourceIds, node.retained, node.tags, node.region]),
    snapshot.groups.map(group => [group.id, group.sourceIds, group.includedNodeIds, group.excludedNodeIds, group.nodeOrder, group.rules]),
  ])
  if (!nodeIds.length && membershipInputs(before) === membershipInputs(after)) return { groupIds: [], directNodeIds: [] }
  const oldGroups = new Set(before.groups.map(group => group.id))
  const newGroups = new Set(after.groups.map(group => group.id))
  const groupIds = [...new Set([...oldGroups, ...newGroups])].filter(id => {
    const oldIds = oldGroups.has(id) ? resolveGroupNodes(before, id).map(node => node.id) : []
    const newIds = newGroups.has(id) ? resolveGroupNodes(after, id).map(node => node.id) : []
    return oldIds.length !== newIds.length || oldIds.some((oldId, index) => oldId !== newIds[index] || changedNodes.has(oldId))
  })
  const oldDirect = new Set(before.nodes.filter(node => node.enabled).map(node => node.id))
  const newDirect = new Set(after.nodes.filter(node => node.enabled).map(node => node.id))
  const directNodeIds = [...new Set([...oldDirect, ...newDirect])]
    .filter(id => oldDirect.has(id) !== newDirect.has(id) || changedNodes.has(id))
  return { groupIds, directNodeIds }
}
