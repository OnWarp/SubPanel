import type { CatalogSnapshot, Node } from '../catalog/schema.js'
import { canonicalNodeJson } from '../import/fingerprint.js'
import { apiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import { rawShareUri, serializeShareUri } from '../renderers/uri.js'
import { bindingConfig, maxBindings, readBindings, type BindingRow } from './bindings.js'
import { selectedNodes, type ZeroNodeReason } from './compiler.js'
import { accountAvailable, readUserAccess, type UserAccess } from './user-access.js'

export function connectionIdentity(node: Node) {
  const normalized = canonicalNodeJson({ ...node, tls: node.tls ?? {}, transport: node.transport ?? {}, plugin: node.plugin ?? {} })
  const raw = rawShareUri(node)
  if (!raw) return normalized
  // Some renderers preserve an original URI for protocols or TLS settings
  // whose connection options are not fully modeled by the catalog.
  const usesRaw = ['ssr', 'wireguard', 'snell', 'shadowtls'].includes(node.protocol)
    || node.extensions.sourceScheme === 'trojan-go' || Boolean(node.tls?.certificate || node.tls?.certificateFingerprint || node.tls?.reality)
    || serializeShareUri(node) === null
  return usesRaw ? JSON.stringify([normalized, raw.split('#', 1)[0]]) : normalized
}

export function uniqueConnections(nodes: Iterable<Node>) {
  const ids = new Set<string>()
  const connections = new Set<string>()
  const result: Node[] = []
  for (const node of nodes) {
    if (!node.enabled || ids.has(node.id)) continue
    ids.add(node.id)
    const connection = connectionIdentity(node)
    if (connections.has(connection)) continue
    connections.add(connection)
    result.push(node)
  }
  return result
}

export function aggregateBindings(access: UserAccess | null, rows: BindingRow[], now: number, catalog: CatalogSnapshot) {
  const enabled = accountAvailable(access) && access.enabled === 1
  const relevant = rows.filter(row => row.status !== 'revoked')
  const eligible = enabled ? relevant.filter(row => row.status === 'active' && row.template_status === 'enabled'
    && (row.owner_user_id === null || row.owner_user_id === access.user_id)) : []
  const effective = eligible.filter(row => row.starts_at <= now && (row.expires_at === null || now < row.expires_at))
  const future = eligible.filter(row => now < row.starts_at)
  const expired = eligible.filter(row => row.expires_at !== null && row.expires_at <= now)
  const status = !accountAvailable(access) || (access.revision !== null && !enabled) ? 'disabled'
    : effective.length ? 'active' : future.length ? 'pending' : expired.length ? 'expired'
      : relevant.length ? 'disabled' : 'none'
  const permanent = effective.some(row => row.expires_at === null)
  const expiry = effective.flatMap(row => row.expires_at === null ? [] : [row.expires_at])
  const next = Math.min(...expiry, ...future.map(row => row.starts_at))
  const history = relevant.flatMap(row => row.expires_at !== null && row.expires_at <= now ? [row.expires_at] : [])
  const configs = effective.map(bindingConfig)
  // Quota cannot be evaluated in this data plane. A single renderer speed can
  // preserve one policy, but applying it to a mixed grant would alter scope.
  const speeds = new Set(configs.map(config => config.limits.speedLimitMbps))
  const conflict = configs.some(config => config.quotaBytes !== null)
    || (configs.length > 1 && [...speeds].some(speed => speed > 0))
  const nodes = conflict ? [] : uniqueConnections(configs.flatMap(config => selectedNodes(catalog, config)))
  if (nodes.length > 2000 || relevant.length > maxBindings) {
    throw apiError(409, 'UNIFIED_RESOURCE_LIMIT', '授权资源数量超出限制')
  }
  const zeroNodeReason: ZeroNodeReason | null = status === 'expired' || status === 'pending' || status === 'disabled'
    ? status : nodes.length ? null : 'noEnabledNodes'
  return {
    catalog, nodes, status, permanent, expiresAt: !permanent && expiry.length ? Math.max(...expiry) : null,
    lastExpiredAt: history.length ? Math.max(...history) : null,
    nextTransitionAt: Number.isFinite(next) ? next : null,
    effectiveTemplateIds: effective.map(row => row.template_id),
    dependencies: relevant.map(row => [row.template_id, row.revision, row.template_revision, row.template_status, row.version_id]),
    speed: conflict ? 0 : configs[0]?.limits.speedLimitMbps ?? 0,
    diagnostics: conflict ? ['PLAN_POLICY_UNVERIFIED'] : [],
    zeroNodeReason,
  }
}

export async function resolveUserSubscription(db: D1Database, userId: string, now: number, catalog: CatalogSnapshot) {
  const [access, rows] = await Promise.all([readUserAccess(db, { userId }), readBindings(db, userId, false)])
  const resolved = aggregateBindings(access, rows, now, catalog)
  const templateRevision = await hashToken(JSON.stringify(resolved.dependencies))
  return { ...resolved, access, templateRevision }
}
