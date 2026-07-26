import { z } from 'zod'
import { encryptedValueSchema, type EncryptedValue } from '../platform/crypto.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

export { encryptedValueSchema }
export type { EncryptedValue }

export const sourceIdSchema = z.string().regex(/^src_[1-9]\d*$/)
export const nodeIdSchema = z.string().regex(/^node_[1-9]\d*$/)
export const groupIdSchema = z.string().regex(/^grp_[1-9]\d*$/)

export const sourceTypeSchema = z.enum(['manual', 'file', 'remote'])
export const importFormatSchema = z.enum([
  'uri-list',
  'base64-uri-list',
  'mihomo',
  'sing-box',
  'sip008',
  'loon',
  'surge',
  'quantumultx',
  'v2rayn',
  'nekobox',
  'shadowrocket',
  'mixed',
])
export const protocolSchema = z.enum([
  'shadowsocks',
  'ss2022',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'wireguard',
  'anytls',
  'naive',
  'snell',
  'shadowtls',
  'http',
  'https',
  'socks5',
])

export const sourceWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  line: z.number().int().positive().optional(),
})

export const MAX_NODES = 100

const jsonRecordSchema = z.record(z.string(), jsonValueSchema)
const uniqueStringArray = <T extends z.ZodType<string>>(item: T) => z.array(item).refine(
  (values) => new Set(values).size === values.length,
  'Duplicate identifiers are not allowed',
)

const sourceBaseSchema = z.object({
  id: sourceIdSchema,
  name: z.string().trim().min(1).max(128),
  type: sourceTypeSchema,
  enabled: z.boolean(),
  encryptedContent: encryptedValueSchema.optional(),
  encryptedUrl: encryptedValueSchema.optional(),
  encryptedHeaders: encryptedValueSchema.optional(),
  refreshIntervalMinutes: z.number().int().positive().optional(),
  detectedFormat: importFormatSchema.optional(),
  warnings: z.array(sourceWarningSchema),
  lastAttemptAt: z.iso.datetime().optional(),
  lastSuccessAt: z.iso.datetime().optional(),
  lastErrorCode: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const sourceSchema = sourceBaseSchema.superRefine((source, ctx) => {
  if (source.type === 'remote') {
    if (!source.encryptedUrl) {
      ctx.addIssue({ code: 'custom', path: ['encryptedUrl'], message: 'Remote source URL is required' })
    }
    if (!source.encryptedHeaders) {
      ctx.addIssue({ code: 'custom', path: ['encryptedHeaders'], message: 'Remote source headers are required' })
    }
    if (!source.refreshIntervalMinutes || source.refreshIntervalMinutes % 15 !== 0) {
      ctx.addIssue({ code: 'custom', path: ['refreshIntervalMinutes'], message: 'Refresh interval must be a positive 15-minute multiple' })
    }
  } else {
    if (source.encryptedUrl || source.encryptedHeaders || source.refreshIntervalMinutes !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Only remote sources may store URL, headers, or refresh interval' })
    }
  }
})

export const rawVariantSchema = z.object({
  sourceId: sourceIdSchema,
  format: importFormatSchema,
  raw: z.string(),
  extensions: jsonRecordSchema,
})

export const nodeSchema = z.object({
  id: nodeIdSchema,
  protocol: protocolSchema,
  displayName: z.string().trim().min(1).max(256),
  server: z.string().min(1).max(2048),
  port: z.number().int().min(1).max(65535),
  credentials: jsonRecordSchema,
  tls: jsonRecordSchema.optional(),
  transport: jsonRecordSchema.optional(),
  plugin: jsonRecordSchema.optional(),
  extensions: jsonRecordSchema,
  fingerprint: z.string().min(1),
  sourceIds: uniqueStringArray(sourceIdSchema),
  rawVariants: z.array(rawVariantSchema),
  enabled: z.boolean(),
  retained: z.boolean(),
  order: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const groupSchema = z.object({
  id: groupIdSchema,
  name: z.string().trim().min(1).max(128),
  sourceIds: uniqueStringArray(sourceIdSchema),
  includedNodeIds: uniqueStringArray(nodeIdSchema),
  excludedNodeIds: uniqueStringArray(nodeIdSchema),
  nodeOrder: uniqueStringArray(nodeIdSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((group, ctx) => {
  const included = new Set(group.includedNodeIds)
  for (const [index, nodeId] of group.excludedNodeIds.entries()) {
    if (included.has(nodeId)) ctx.addIssue({ code: 'custom', path: ['excludedNodeIds', index], message: 'A node cannot be both included and excluded' })
  }
})

type SnapshotCollections = {
  nextSourceId: number
  nextNodeId: number
  nextGroupId: number
  sources: Source[]
  nodes: Node[]
  groups: Group[]
}

function maxIdentifierNumber(ids: string[], prefix: string): number {
  return ids.reduce((maximum, id) => Math.max(maximum, Number(id.slice(prefix.length))), 0)
}

function validateSnapshot(snapshot: SnapshotCollections, ctx: z.RefinementCtx): void {
  const sourceIds = new Set<string>()
  const nodeIds = new Set<string>()
  const groupIds = new Set<string>()
  const fingerprints = new Set<string>()
  const sourceIdSet = new Set(snapshot.sources.map((source) => source.id))
  const nodeIdSet = new Set(snapshot.nodes.map((node) => node.id))

  if (snapshot.nodes.length > MAX_NODES) {
    ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Catalog cannot contain more than 100 nodes' })
  }

  if (snapshot.nextSourceId <= maxIdentifierNumber(snapshot.sources.map(({ id }) => id), 'src_')) {
    ctx.addIssue({ code: 'custom', path: ['nextSourceId'], message: 'nextSourceId must be greater than all existing source IDs' })
  }
  if (snapshot.nextNodeId <= maxIdentifierNumber(snapshot.nodes.map(({ id }) => id), 'node_')) {
    ctx.addIssue({ code: 'custom', path: ['nextNodeId'], message: 'nextNodeId must be greater than all existing node IDs' })
  }
  if (snapshot.nextGroupId <= maxIdentifierNumber(snapshot.groups.map(({ id }) => id), 'grp_')) {
    ctx.addIssue({ code: 'custom', path: ['nextGroupId'], message: 'nextGroupId must be greater than all existing group IDs' })
  }

  for (const [index, source] of snapshot.sources.entries()) {
    if (sourceIds.has(source.id)) ctx.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: 'Duplicate source id' })
    sourceIds.add(source.id)
  }

  for (const [index, node] of snapshot.nodes.entries()) {
    if (nodeIds.has(node.id)) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: 'Duplicate node id' })
    nodeIds.add(node.id)
    if (fingerprints.has(node.fingerprint)) {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'fingerprint'], message: 'Duplicate node fingerprint' })
    }
    fingerprints.add(node.fingerprint)

    for (const sourceId of node.sourceIds) {
      if (!sourceIdSet.has(sourceId)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', index, 'sourceIds'], message: 'Node references a missing source' })
      }
      if (!node.rawVariants.some((variant) => variant.sourceId === sourceId)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', index, 'rawVariants'], message: 'Node source is missing a raw variant' })
      }
    }
    for (const [variantIndex, variant] of node.rawVariants.entries()) {
      if (!node.sourceIds.includes(variant.sourceId)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', index, 'rawVariants', variantIndex, 'sourceId'], message: 'Raw variant references an unrelated source' })
      }
    }
  }

  for (const [index, group] of snapshot.groups.entries()) {
    if (groupIds.has(group.id)) ctx.addIssue({ code: 'custom', path: ['groups', index, 'id'], message: 'Duplicate group id' })
    groupIds.add(group.id)
    for (const sourceId of group.sourceIds) {
      if (!sourceIdSet.has(sourceId)) ctx.addIssue({ code: 'custom', path: ['groups', index, 'sourceIds'], message: 'Group references a missing source' })
    }
    for (const nodeId of [...group.includedNodeIds, ...group.excludedNodeIds, ...group.nodeOrder]) {
      if (!nodeIdSet.has(nodeId)) ctx.addIssue({ code: 'custom', path: ['groups', index], message: 'Group references a missing node' })
    }
    if (new Set(group.nodeOrder).size !== group.nodeOrder.length) {
      ctx.addIssue({ code: 'custom', path: ['groups', index, 'nodeOrder'], message: 'Group node order contains duplicates' })
    }
  }
}

const snapshotFields = {
    revision: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
    nextSourceId: z.number().int().positive(),
    nextNodeId: z.number().int().positive(),
    nextGroupId: z.number().int().positive(),
    sources: z.array(sourceSchema),
    nodes: z.array(nodeSchema),
    groups: z.array(groupSchema),
  } as const

const currentCatalogSnapshotSchema = z
  .object({ schemaVersion: z.literal(2), ...snapshotFields })
  .superRefine(validateSnapshot)

export const legacyCatalogSnapshotSchema = z
  .object({ schemaVersion: z.literal(1), ...snapshotFields })
  .superRefine(validateSnapshot)

export const catalogSnapshotSchema = z
  .union([currentCatalogSnapshotSchema, legacyCatalogSnapshotSchema])
  .transform((snapshot) => currentCatalogSnapshotSchema.parse({ ...snapshot, schemaVersion: 2 }))

export type SourceId = z.infer<typeof sourceIdSchema>
export type NodeId = z.infer<typeof nodeIdSchema>
export type GroupId = z.infer<typeof groupIdSchema>
export type SourceType = z.infer<typeof sourceTypeSchema>
export type ImportFormat = z.infer<typeof importFormatSchema>
export type Protocol = z.infer<typeof protocolSchema>
export type SourceWarning = z.infer<typeof sourceWarningSchema>
export type RawVariant = z.infer<typeof rawVariantSchema>
export type Source = z.infer<typeof sourceSchema>
export type Node = z.infer<typeof nodeSchema>
export type Group = z.infer<typeof groupSchema>
export type CatalogSnapshot = z.output<typeof catalogSnapshotSchema>
export type LegacyCatalogSnapshot = z.infer<typeof legacyCatalogSnapshotSchema>
export type CatalogSnapshotInput = CatalogSnapshot | LegacyCatalogSnapshot

export function upgradeCatalogSnapshot(input: unknown): CatalogSnapshot {
  return catalogSnapshotSchema.parse(input)
}

export const emptyCatalogSnapshot = (now = '1970-01-01T00:00:00.000Z'): CatalogSnapshot => ({
  schemaVersion: 2,
  revision: 0,
  updatedAt: now,
  nextSourceId: 1,
  nextNodeId: 1,
  nextGroupId: 1,
  sources: [],
  nodes: [],
  groups: [],
})
