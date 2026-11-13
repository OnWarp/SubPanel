import { z } from 'zod'
import { catalogSnapshotSchema, legacyCatalogSnapshotSchema, type CatalogSnapshot } from '../catalog/schema.js'

// Element schemas stay in force. Snapshot superRefine (dangling ids, next* counters)
// must not throw: the converter reports those as anomalies.
const structuralCatalogSnapshotSchema = z.object({
  ...legacyCatalogSnapshotSchema.shape,
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
})

export interface ConversionReport {
  converted: number
  skipped: number
  anomalies: string[]
}

export interface CatalogConversionResult {
  rows: {
    sources: SourceRow[]
    nodes: NodeRow[]
    node_raw_variants: NodeRawVariantRow[]
    groups: GroupRow[]
    group_sources: GroupSourceRow[]
    group_nodes: GroupNodeRow[]
    group_node_order: GroupNodeOrderRow[]
  }
  report: ConversionReport
}

export interface SourceRow {
  id: string
  name: string
  type: 'manual' | 'file' | 'remote'
  enabled: 0 | 1
  encrypted_content: string | null
  encrypted_url: string | null
  encrypted_headers: string | null
  refresh_interval_minutes: number | null
  detected_format: string | null
  warnings: string
  last_attempt_at: string | null
  last_success_at: string | null
  last_error_code: string | null
  created_at: string
  updated_at: string
}

export interface NodeRow {
  id: string
  protocol: string
  display_name: string
  server: string
  port: number
  credentials: string
  tls: string | null
  transport: string | null
  plugin: string | null
  extensions: string
  fingerprint: string
  source_ids: string
  enabled: 0 | 1
  retained: 0 | 1
  sort_order: number
  created_at: string
  updated_at: string
}

export interface NodeRawVariantRow {
  node_id: string
  source_id: string
  format: string
  raw: string
  extensions: string
}

export interface GroupRow {
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface GroupSourceRow {
  group_id: string
  source_id: string
  position: number
}

export interface GroupNodeRow {
  group_id: string
  node_id: string
  relation: 'included' | 'excluded'
  position: number
}

export interface GroupNodeOrderRow {
  group_id: string
  node_id: string
  position: number
}

export function convertCatalog(kvValue: unknown): CatalogConversionResult {
  const report: ConversionReport = { converted: 0, skipped: 0, anomalies: [] }
  const strict = catalogSnapshotSchema.safeParse(kvValue)
  const snapshot: CatalogSnapshot = strict.success
    ? strict.data
    : { ...structuralCatalogSnapshotSchema.parse(kvValue), schemaVersion: 2 }

  const sourceIdSet = new Set(snapshot.sources.map((s) => s.id))
  const nodeIdSet = new Set(snapshot.nodes.map((n) => n.id))


  // Convert sources
  const sources: SourceRow[] = snapshot.sources.map((source) => ({
    id: source.id,
    name: source.name,
    type: source.type,
    enabled: source.enabled ? 1 : 0,
    encrypted_content: source.encryptedContent ? JSON.stringify(source.encryptedContent) : null,
    encrypted_url: source.encryptedUrl ? JSON.stringify(source.encryptedUrl) : null,
    encrypted_headers: source.encryptedHeaders ? JSON.stringify(source.encryptedHeaders) : null,
    refresh_interval_minutes: source.refreshIntervalMinutes ?? null,
    detected_format: source.detectedFormat ?? null,
    warnings: JSON.stringify(source.warnings),
    last_attempt_at: source.lastAttemptAt ?? null,
    last_success_at: source.lastSuccessAt ?? null,
    last_error_code: source.lastErrorCode ?? null,
    created_at: source.createdAt,
    updated_at: source.updatedAt,
  }))

  // Convert nodes
  const nodes: NodeRow[] = []
  const node_raw_variants: NodeRawVariantRow[] = []

  for (const node of snapshot.nodes) {
    // Check for dangling source references
    for (const sourceId of node.sourceIds) {
      if (!sourceIdSet.has(sourceId)) {
        report.anomalies.push(`Node ${node.id} references missing source ${sourceId}`)
        report.skipped++
      }
    }

    // Check that each sourceId has a corresponding rawVariant
    for (const sourceId of node.sourceIds) {
      const hasVariant = node.rawVariants.some((v) => v.sourceId === sourceId)
      if (!hasVariant) {
        report.anomalies.push(`Node ${node.id} source ${sourceId} missing raw variant`)
        report.skipped++
      }
    }

    // Check for rawVariants referencing unrelated sources
    for (const variant of node.rawVariants) {
      if (!node.sourceIds.includes(variant.sourceId)) {
        report.anomalies.push(`Node ${node.id} raw variant references unrelated source ${variant.sourceId}`)
        report.skipped++
      }
    }

    nodes.push({
      id: node.id,
      protocol: node.protocol,
      display_name: node.displayName,
      server: node.server,
      port: node.port,
      credentials: JSON.stringify(node.credentials),
      tls: node.tls ? JSON.stringify(node.tls) : null,
      transport: node.transport ? JSON.stringify(node.transport) : null,
      plugin: node.plugin ? JSON.stringify(node.plugin) : null,
      extensions: JSON.stringify(node.extensions),
      fingerprint: node.fingerprint,
      source_ids: JSON.stringify(node.sourceIds),
      enabled: node.enabled ? 1 : 0,
      retained: node.retained ? 1 : 0,
      sort_order: node.order,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
    })

    for (const variant of node.rawVariants) {
      node_raw_variants.push({
        node_id: node.id,
        source_id: variant.sourceId,
        format: variant.format,
        raw: variant.raw,
        extensions: JSON.stringify(variant.extensions),
      })
    }
  }

  // Convert groups
  const groups: GroupRow[] = []
  const group_sources: GroupSourceRow[] = []
  const group_nodes: GroupNodeRow[] = []
  const group_node_order: GroupNodeOrderRow[] = []

  for (const group of snapshot.groups) {
    // Check for dangling source references
    for (const sourceId of group.sourceIds) {
      if (!sourceIdSet.has(sourceId)) {
        report.anomalies.push(`Group ${group.id} references missing source ${sourceId}`)
        report.skipped++
      }
    }

    // Check for dangling node references
    for (const nodeId of [...group.includedNodeIds, ...group.excludedNodeIds, ...group.nodeOrder]) {
      if (!nodeIdSet.has(nodeId)) {
        report.anomalies.push(`Group ${group.id} references missing node ${nodeId}`)
        report.skipped++
      }
    }

    groups.push({
      id: group.id,
      name: group.name,
      created_at: group.createdAt,
      updated_at: group.updatedAt,
    })

    for (let i = 0; i < group.sourceIds.length; i++) {
      group_sources.push({
        group_id: group.id,
        source_id: group.sourceIds[i],
        position: i,
      })
    }

    for (let i = 0; i < group.includedNodeIds.length; i++) {
      group_nodes.push({
        group_id: group.id,
        node_id: group.includedNodeIds[i],
        relation: 'included',
        position: i,
      })
    }

    for (let i = 0; i < group.excludedNodeIds.length; i++) {
      group_nodes.push({
        group_id: group.id,
        node_id: group.excludedNodeIds[i],
        relation: 'excluded',
        position: i,
      })
    }

    for (let i = 0; i < group.nodeOrder.length; i++) {
      group_node_order.push({
        group_id: group.id,
        node_id: group.nodeOrder[i],
        position: i,
      })
    }
  }

  report.converted = sources.length + nodes.length + node_raw_variants.length + groups.length +
    group_sources.length + group_nodes.length + group_node_order.length

  return {
    rows: {
      sources,
      nodes,
      node_raw_variants,
      groups,
      group_sources,
      group_nodes,
      group_node_order,
    },
    report,
  }
}