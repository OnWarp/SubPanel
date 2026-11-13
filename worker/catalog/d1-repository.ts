import { batch, type AppDatabase } from '../db/db.js'
import {
  CATALOG_SETTING_KEYS,
  countRows,
  deleteSettings,
  readSettingMap,
  upsertSettingStatement,
} from '../db/module-switch.js'
import {
  convertCatalog,
  type GroupNodeOrderRow,
  type GroupNodeRow,
  type GroupRow,
  type GroupSourceRow,
  type NodeRawVariantRow,
  type NodeRow,
  type SourceRow,
} from '../migration/catalog.js'
import {
  emptyCatalogSnapshot,
  upgradeCatalogSnapshot,
  type CatalogSnapshot,
} from './schema.js'

export type CatalogCounts = {
  sources: number
  nodes: number
  nodeRawVariants: number
  groups: number
  groupSources: number
  groupNodes: number
  groupNodeOrder: number
}

type CatalogMeta = {
  schemaVersion: 2
  revision: number
  updatedAt: string
  nextSourceId: number
  nextNodeId: number
  nextGroupId: number
  sourceOrder: string[]
  nodeOrder: string[]
  groupOrder: string[]
}

type SourceSql = {
  id: string
  name: string
  type: 'manual' | 'file' | 'remote'
  enabled: number
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

type NodeSql = {
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
  enabled: number
  retained: number
  sort_order: number
  created_at: string
  updated_at: string
}

type VariantSql = {
  id: number
  node_id: string
  source_id: string
  format: string
  raw: string
  extensions: string
}

type GroupSql = {
  id: string
  name: string
  created_at: string
  updated_at: string
}

type GroupSourceSql = { group_id: string, source_id: string, position: number }
type GroupNodeSql = { group_id: string, node_id: string, relation: 'included' | 'excluded', position: number }
type GroupOrderSql = { group_id: string, node_id: string, position: number }

const CATALOG_META_KEYS = [
  CATALOG_SETTING_KEYS.schemaVersion,
  CATALOG_SETTING_KEYS.revision,
  CATALOG_SETTING_KEYS.updatedAt,
  CATALOG_SETTING_KEYS.nextSourceId,
  CATALOG_SETTING_KEYS.nextNodeId,
  CATALOG_SETTING_KEYS.nextGroupId,
  CATALOG_SETTING_KEYS.entityOrder,
] as const

function corrupt(): never {
  throw new Error('Catalog snapshot is corrupt')
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    corrupt()
  }
}

function optionalJson(raw: string | null): unknown {
  if (raw === null) return undefined
  return parseJson(raw)
}

function assignOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value
}

function orderExactly<T extends { id: string }>(rows: T[], order: string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (order.length !== rows.length || order.some((id) => !byId.has(id))) corrupt()
  return order.map((id) => byId.get(id)!)
}

function idsByPosition(rows: { position: number, id: string }[]): string[] {
  return [...rows].sort((left, right) => left.position - right.position).map((row) => row.id)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) corrupt()
  return value
}

function metaFromSnapshot(snapshot: CatalogSnapshot): CatalogMeta {
  return {
    schemaVersion: 2,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    nextSourceId: snapshot.nextSourceId,
    nextNodeId: snapshot.nextNodeId,
    nextGroupId: snapshot.nextGroupId,
    sourceOrder: snapshot.sources.map((source) => source.id),
    nodeOrder: snapshot.nodes.map((node) => node.id),
    groupOrder: snapshot.groups.map((group) => group.id),
  }
}

function deleteMissing(db: AppDatabase, table: 'sources' | 'groups', ids: string[]): D1PreparedStatement {
  return db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids))
}

export async function clearCatalogStorage(db: AppDatabase): Promise<void> {
  await batch(db, [
    db.prepare('DELETE FROM group_node_order'),
    db.prepare('DELETE FROM group_nodes'),
    db.prepare('DELETE FROM group_sources'),
    db.prepare('DELETE FROM node_raw_variants'),
    db.prepare('DELETE FROM groups'),
    db.prepare('DELETE FROM nodes'),
    db.prepare('DELETE FROM sources'),
  ])
  await deleteSettings(db, CATALOG_META_KEYS)
}

export async function catalogCounts(db: AppDatabase): Promise<CatalogCounts> {
  const [sources, nodes, nodeRawVariants, groups, groupSources, groupNodes, groupNodeOrder] = await Promise.all([
    countRows(db, 'sources'),
    countRows(db, 'nodes'),
    countRows(db, 'node_raw_variants'),
    countRows(db, 'groups'),
    countRows(db, 'group_sources'),
    countRows(db, 'group_nodes'),
    countRows(db, 'group_node_order'),
  ])
  return { sources, nodes, nodeRawVariants, groups, groupSources, groupNodes, groupNodeOrder }
}

export async function readCatalogFromD1(db: AppDatabase): Promise<CatalogSnapshot> {
  try {
    const [sources, nodes, variants, groups, groupSources, groupNodes, groupOrder, settings] = await Promise.all([
      db.prepare('SELECT * FROM sources').all<SourceSql>(),
      db.prepare('SELECT * FROM nodes').all<NodeSql>(),
      db.prepare('SELECT * FROM node_raw_variants ORDER BY id').all<VariantSql>(),
      db.prepare('SELECT * FROM groups').all<GroupSql>(),
      db.prepare('SELECT group_id, source_id, position FROM group_sources ORDER BY group_id, position').all<GroupSourceSql>(),
      db.prepare('SELECT group_id, node_id, relation, position FROM group_nodes ORDER BY group_id, relation, position').all<GroupNodeSql>(),
      db.prepare('SELECT group_id, node_id, position FROM group_node_order ORDER BY group_id, position').all<GroupOrderSql>(),
      readSettingMap(db, CATALOG_META_KEYS),
    ])

    const sourceRows = sources.results
    const nodeRows = nodes.results
    const groupRows = groups.results
    const hasRows = sourceRows.length + nodeRows.length + groupRows.length > 0
    const revision = settings.get(CATALOG_SETTING_KEYS.revision)
    if (revision === undefined && !hasRows) return emptyCatalogSnapshot()

    const updatedAt = settings.get(CATALOG_SETTING_KEYS.updatedAt)
    const nextSourceId = settings.get(CATALOG_SETTING_KEYS.nextSourceId)
    const nextNodeId = settings.get(CATALOG_SETTING_KEYS.nextNodeId)
    const nextGroupId = settings.get(CATALOG_SETTING_KEYS.nextGroupId)
    const storedOrder = settings.get(CATALOG_SETTING_KEYS.entityOrder)
    if (
      typeof revision !== 'number' ||
      typeof updatedAt !== 'string' ||
      typeof nextSourceId !== 'number' ||
      typeof nextNodeId !== 'number' ||
      typeof nextGroupId !== 'number' ||
      storedOrder === null ||
      typeof storedOrder !== 'object' ||
      Array.isArray(storedOrder)
    ) corrupt()

    const order = storedOrder as { sources?: unknown, nodes?: unknown, groups?: unknown }
    const orderedSources = orderExactly(sourceRows, asStringArray(order.sources))
    const orderedNodes = orderExactly(nodeRows, asStringArray(order.nodes))
    const orderedGroups = orderExactly(groupRows, asStringArray(order.groups))

    const variantsByNode = new Map<string, VariantSql[]>()
    for (const variant of variants.results) {
      const list = variantsByNode.get(variant.node_id) ?? []
      list.push(variant)
      variantsByNode.set(variant.node_id, list)
    }

    const snapshot = {
      schemaVersion: 2,
      revision,
      updatedAt,
      nextSourceId,
      nextNodeId,
      nextGroupId,
      sources: orderedSources.map((row) => {
        const source: Record<string, unknown> = {
          id: row.id,
          name: row.name,
          type: row.type,
          enabled: row.enabled === 1,
          warnings: parseJson(row.warnings),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
        assignOptional(source, 'encryptedContent', optionalJson(row.encrypted_content))
        assignOptional(source, 'encryptedUrl', optionalJson(row.encrypted_url))
        assignOptional(source, 'encryptedHeaders', optionalJson(row.encrypted_headers))
        assignOptional(source, 'refreshIntervalMinutes', row.refresh_interval_minutes)
        assignOptional(source, 'detectedFormat', row.detected_format)
        assignOptional(source, 'lastAttemptAt', row.last_attempt_at)
        assignOptional(source, 'lastSuccessAt', row.last_success_at)
        assignOptional(source, 'lastErrorCode', row.last_error_code)
        return source
      }),
      nodes: orderedNodes.map((row) => {
        const node: Record<string, unknown> = {
          id: row.id,
          protocol: row.protocol,
          displayName: row.display_name,
          server: row.server,
          port: row.port,
          credentials: parseJson(row.credentials),
          extensions: parseJson(row.extensions),
          fingerprint: row.fingerprint,
          sourceIds: parseJson(row.source_ids),
          rawVariants: (variantsByNode.get(row.id) ?? []).map((variant) => ({
            sourceId: variant.source_id,
            format: variant.format,
            raw: variant.raw,
            extensions: parseJson(variant.extensions),
          })),
          enabled: row.enabled === 1,
          retained: row.retained === 1,
          order: row.sort_order,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
        assignOptional(node, 'tls', optionalJson(row.tls))
        assignOptional(node, 'transport', optionalJson(row.transport))
        assignOptional(node, 'plugin', optionalJson(row.plugin))
        return node
      }),
      groups: orderedGroups.map((row) => ({
        id: row.id,
        name: row.name,
        sourceIds: idsByPosition(groupSources.results.filter((item) => item.group_id === row.id).map((item) => ({ position: item.position, id: item.source_id }))),
        includedNodeIds: idsByPosition(groupNodes.results.filter((item) => item.group_id === row.id && item.relation === 'included').map((item) => ({ position: item.position, id: item.node_id }))),
        excludedNodeIds: idsByPosition(groupNodes.results.filter((item) => item.group_id === row.id && item.relation === 'excluded').map((item) => ({ position: item.position, id: item.node_id }))),
        nodeOrder: idsByPosition(groupOrder.results.filter((item) => item.group_id === row.id).map((item) => ({ position: item.position, id: item.node_id }))),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    }
    return upgradeCatalogSnapshot(snapshot)
  } catch (error) {
    if (error instanceof Error && error.message === 'Catalog snapshot is corrupt') throw error
    throw new Error('Catalog snapshot is corrupt')
  }
}

function sourceInsert(db: AppDatabase, row: SourceRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sources (
      id, name, type, enabled,
      encrypted_content, encrypted_url, encrypted_headers,
      refresh_interval_minutes, detected_format, warnings,
      last_attempt_at, last_success_at, last_error_code,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      enabled = excluded.enabled,
      encrypted_content = excluded.encrypted_content,
      encrypted_url = excluded.encrypted_url,
      encrypted_headers = excluded.encrypted_headers,
      refresh_interval_minutes = excluded.refresh_interval_minutes,
      detected_format = excluded.detected_format,
      warnings = excluded.warnings,
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = excluded.last_success_at,
      last_error_code = excluded.last_error_code,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
  ).bind(
    row.id,
    row.name,
    row.type,
    row.enabled,
    row.encrypted_content,
    row.encrypted_url,
    row.encrypted_headers,
    row.refresh_interval_minutes,
    row.detected_format,
    row.warnings,
    row.last_attempt_at,
    row.last_success_at,
    row.last_error_code,
    row.created_at,
    row.updated_at,
  )
}

function nodeInsert(db: AppDatabase, row: NodeRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO nodes (
      id, protocol, display_name, server, port,
      credentials, tls, transport, plugin, extensions,
      fingerprint, source_ids, enabled, retained, sort_order,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id,
    row.protocol,
    row.display_name,
    row.server,
    row.port,
    row.credentials,
    row.tls,
    row.transport,
    row.plugin,
    row.extensions,
    row.fingerprint,
    row.source_ids,
    row.enabled,
    row.retained,
    row.sort_order,
    row.created_at,
    row.updated_at,
  )
}

function variantInsert(db: AppDatabase, row: NodeRawVariantRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO node_raw_variants (node_id, source_id, format, raw, extensions)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(row.node_id, row.source_id, row.format, row.raw, row.extensions)
}

function groupInsert(db: AppDatabase, row: GroupRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO groups (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  ).bind(row.id, row.name, row.created_at, row.updated_at)
}

function groupSourceInsert(db: AppDatabase, row: GroupSourceRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO group_sources (group_id, source_id, position) VALUES (?, ?, ?)`,
  ).bind(row.group_id, row.source_id, row.position)
}

function groupNodeInsert(db: AppDatabase, row: GroupNodeRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO group_nodes (group_id, node_id, relation, position) VALUES (?, ?, ?, ?)`,
  ).bind(row.group_id, row.node_id, row.relation, row.position)
}

function groupOrderInsert(db: AppDatabase, row: GroupNodeOrderRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO group_node_order (group_id, node_id, position) VALUES (?, ?, ?)`,
  ).bind(row.group_id, row.node_id, row.position)
}

export async function persistCatalogSnapshot(db: AppDatabase, snapshot: CatalogSnapshot): Promise<void> {
  const converted = convertCatalog(snapshot)
  const meta = metaFromSnapshot(snapshot)
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM group_node_order'),
    db.prepare('DELETE FROM group_nodes'),
    db.prepare('DELETE FROM group_sources'),
    db.prepare('DELETE FROM node_raw_variants'),
    db.prepare('DELETE FROM nodes'),
    deleteMissing(db, 'sources', converted.rows.sources.map((row) => row.id)),
    ...converted.rows.sources.map((row) => sourceInsert(db, row)),
    ...converted.rows.nodes.map((row) => nodeInsert(db, row)),
    ...converted.rows.node_raw_variants.map((row) => variantInsert(db, row)),
    ...converted.rows.groups.map((row) => groupInsert(db, row)),
    deleteMissing(db, 'groups', converted.rows.groups.map((row) => row.id)),
    ...converted.rows.group_sources.map((row) => groupSourceInsert(db, row)),
    ...converted.rows.group_nodes.map((row) => groupNodeInsert(db, row)),
    ...converted.rows.group_node_order.map((row) => groupOrderInsert(db, row)),
    upsertSettingStatement(db, CATALOG_SETTING_KEYS.schemaVersion, meta.schemaVersion, meta.updatedAt),
    upsertSettingStatement(db, CATALOG_SETTING_KEYS.revision, meta.revision, meta.updatedAt),
    upsertSettingStatement(db, CATALOG_SETTING_KEYS.updatedAt, meta.updatedAt, meta.updatedAt),
    upsertSettingStatement(db, CATALOG_SETTING_KEYS.nextSourceId, meta.nextSourceId, meta.updatedAt),
    upsertSettingStatement(db, CATALOG_SETTING_KEYS.nextNodeId, meta.nextNodeId, meta.updatedAt),
    upsertSettingStatement(db, CATALOG_SETTING_KEYS.nextGroupId, meta.nextGroupId, meta.updatedAt),
    upsertSettingStatement(db, CATALOG_SETTING_KEYS.entityOrder, {
      sources: meta.sourceOrder,
      nodes: meta.nodeOrder,
      groups: meta.groupOrder,
    }, meta.updatedAt),
  ]
  await batch(db, statements)
}
