import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import {
  CatalogImportError,
  createSource,
  deleteSource,
  refreshSource,
  recompileDelivery,
  summarizeSources,
  updateSource,
} from './import-service.js'
import { catalogSnapshotSchema, groupIdSchema, nodeIdSchema, sourceIdSchema, type Group, type Node } from './schema.js'
import { readCatalog, writeCatalog } from './repository.js'
import { RemoteFetchError } from './remote.js'
import { detectImport } from '../import/detect.js'
import { readDelivery } from '../delivery/repository.js'
import { removeGroupReference } from '../delivery/service.js'

const sourceName = z.string().trim().min(1).max(128)
const headers = z.record(z.string(), z.string()).default({})
const createSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['manual', 'file']), name: sourceName, content: z.string().min(1), enabled: z.boolean().optional() }),
  z.object({ type: z.literal('remote'), name: sourceName, url: z.string().min(1), headers, refreshIntervalMinutes: z.number().int().positive(), enabled: z.boolean().optional() }),
])
const updateSourceSchema = z.object({
  name: sourceName.optional(),
  enabled: z.boolean().optional(),
  content: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  refreshIntervalMinutes: z.number().int().positive().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
const previewSchema = z.object({ content: z.string().min(1) })
const nodePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
  retained: z.boolean().optional(),
  order: z.number().int().nonnegative().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
const groupInputSchema = z.object({
  name: sourceName,
  sourceIds: z.array(sourceIdSchema),
  includedNodeIds: z.array(nodeIdSchema),
  excludedNodeIds: z.array(nodeIdSchema),
  nodeOrder: z.array(nodeIdSchema),
})

const MAX_CONTENT_BYTES = 5 * 1024 * 1024

function assertContentSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
    throw apiError(413, 'CONTENT_TOO_LARGE', '导入内容超过大小限制')
  }
}

function mapCatalogError(error: unknown): never {
  if (error instanceof RemoteFetchError) throw apiError(422, error.code, '远程来源请求无效')
  if (error instanceof CatalogImportError) {
    const status = error.code === 'CATALOG_SOURCE_NOT_FOUND' ? 404 : error.code === 'CATALOG_NODE_LIMIT' ? 409 : error.code === 'CATALOG_SOURCE_TYPE_INVALID' ? 409 : 422
    throw apiError(status, error.code, 'Catalog 操作未完成')
  }
  if (error instanceof Error && error.message === 'GROUP_NOT_FOUND') throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  throw error
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    mapCatalogError(error)
  }
}

function safeNode(node: Node) {
  return {
    id: node.id,
    protocol: node.protocol,
    displayName: node.displayName,
    server: node.server,
    port: node.port,
    tls: node.tls,
    transport: node.transport,
    sourceIds: node.sourceIds,
    enabled: node.enabled,
    retained: node.retained,
    order: node.order,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  }
}

function safePreviewNode(node: Node | { protocol: string; displayName: string; server: string; port: number; tls?: unknown; transport?: unknown }) {
  return {
    protocol: node.protocol,
    displayName: node.displayName,
    server: node.server,
    port: node.port,
    tls: node.tls,
    transport: node.transport,
  }
}

function validateReferences(snapshot: ReturnType<typeof catalogSnapshotSchema.parse>, input: z.infer<typeof groupInputSchema>): void {
  const sources = new Set(snapshot.sources.map(({ id }) => id))
  const nodes = new Set(snapshot.nodes.map(({ id }) => id))
  if (
    input.sourceIds.some((id) => !sources.has(id)) ||
    input.includedNodeIds.some((id) => !nodes.has(id)) ||
    input.excludedNodeIds.some((id) => !nodes.has(id)) ||
    input.nodeOrder.some((id) => !nodes.has(id))
  ) {
    throw apiError(422, 'CATALOG_REFERENCE_INVALID', 'Catalog 引用无效')
  }
}

export const catalogRoutes = new Hono<AppEnv>()

catalogRoutes.get('/', async (c) => {
  const snapshot = await readCatalog(c.env.DATA)
  const sources = await summarizeSources(c.env.DATA, snapshot.sources)
  return c.json({
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    sources,
    nodes: snapshot.nodes.map(safeNode),
    groups: snapshot.groups,
  })
})

catalogRoutes.post('/preview', async (c) => {
  const input = await readJson(c, previewSchema)
  assertContentSize(input.content)
  const result = await run(async () => detectImport(input.content))
  if (result.nodes.length === 0) throw apiError(422, 'IMPORT_ZERO_NODES', '未检测到可导入节点')
  return c.json({
    format: result.format,
    nodes: result.nodes.map(safePreviewNode),
    warnings: result.warnings,
  })
})

catalogRoutes.post('/sources', async (c) => {
  const input = await readJson(c, createSourceSchema)
  if (input.type !== 'remote') assertContentSize(input.content)
  const result = await run(() => createSource(c.env.DATA, input))
  return c.json(result, 201)
})

catalogRoutes.put('/sources/:sourceId', async (c) => {
  const id = sourceIdSchema.safeParse(c.req.param('sourceId'))
  if (!id.success) throw apiError(404, 'CATALOG_SOURCE_NOT_FOUND', '来源不存在')
  const input = await readJson(c, updateSourceSchema)
  if (input.content !== undefined) assertContentSize(input.content)
  const result = await run(() => updateSource(c.env.DATA, id.data, input))
  return c.json(result)
})

catalogRoutes.delete('/sources/:sourceId', async (c) => {
  const id = sourceIdSchema.safeParse(c.req.param('sourceId'))
  if (!id.success) throw apiError(404, 'CATALOG_SOURCE_NOT_FOUND', '来源不存在')
  const warning = await run(() => deleteSource(c.env.DATA, id.data))
  if (warning) c.header('X-Catalog-Recompile', 'failed')
  return c.body(null, 204)
})

catalogRoutes.post('/sources/:sourceId/refresh', async (c) => {
  const id = sourceIdSchema.safeParse(c.req.param('sourceId'))
  if (!id.success) throw apiError(404, 'CATALOG_SOURCE_NOT_FOUND', '来源不存在')
  const result = await run(() => refreshSource(c.env.DATA, id.data))
  return c.json(result)
})

catalogRoutes.patch('/nodes/:nodeId', async (c) => {
  const id = nodeIdSchema.safeParse(c.req.param('nodeId'))
  if (!id.success) throw apiError(404, 'CATALOG_NODE_NOT_FOUND', '节点不存在')
  const input = await readJson(c, nodePatchSchema)
  const snapshot = await readCatalog(c.env.DATA)
  const node = snapshot.nodes.find(({ id: nodeId }) => nodeId === id.data)
  if (!node) throw apiError(404, 'CATALOG_NODE_NOT_FOUND', '节点不存在')
  const updated = { ...node, ...input, updatedAt: new Date().toISOString() }
  const saved = await writeCatalog(c.env.DATA, { ...snapshot, nodes: snapshot.nodes.map((current) => current.id === id.data ? updated : current) }, updated.updatedAt)
  const warning = await recompileDelivery(c.env.DATA)
  return c.json({ node: safeNode(saved.nodes.find(({ id: nodeId }) => nodeId === id.data)!), ...(warning ? { warning } : {}) })
})

catalogRoutes.post('/groups', async (c) => {
  const input = await readJson(c, groupInputSchema)
  const snapshot = await readCatalog(c.env.DATA)
  validateReferences(snapshot, input)
  const now = new Date().toISOString()
  const group: Group = {
    id: `grp_${snapshot.nextGroupId}`,
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  const candidate = { ...snapshot, nextGroupId: snapshot.nextGroupId + 1, groups: [...snapshot.groups, group] }
  const checked = catalogSnapshotSchema.safeParse(candidate)
  if (!checked.success) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
  const saved = await writeCatalog(c.env.DATA, candidate, now)
  const warning = await recompileDelivery(c.env.DATA)
  return c.json({ group: saved.groups.find(({ id }) => id === group.id), ...(warning ? { warning } : {}) }, 201)
})

catalogRoutes.put('/groups/:groupId', async (c) => {
  const id = groupIdSchema.safeParse(c.req.param('groupId'))
  if (!id.success) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  const input = await readJson(c, groupInputSchema)
  const snapshot = await readCatalog(c.env.DATA)
  const current = snapshot.groups.find(({ id: groupId }) => groupId === id.data)
  if (!current) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  validateReferences(snapshot, input)
  const updated: Group = { ...current, ...input, updatedAt: new Date().toISOString() }
  const candidate = { ...snapshot, groups: snapshot.groups.map((group) => group.id === id.data ? updated : group) }
  if (!catalogSnapshotSchema.safeParse(candidate).success) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
  const saved = await writeCatalog(c.env.DATA, candidate, updated.updatedAt)
  const warning = await recompileDelivery(c.env.DATA)
  return c.json({ group: saved.groups.find(({ id: groupId }) => groupId === id.data), ...(warning ? { warning } : {}) })
})

catalogRoutes.delete('/groups/:groupId', async (c) => {
  const id = groupIdSchema.safeParse(c.req.param('groupId'))
  if (!id.success) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  const snapshot = await readCatalog(c.env.DATA)
  if (!snapshot.groups.some(({ id: groupId }) => groupId === id.data)) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  try {
    await readDelivery(c.env.DATA)
  } catch {
    throw apiError(500, 'DELIVERY_STATE_INVALID', '订阅状态不可用，未删除分组')
  }
  await writeCatalog(c.env.DATA, { ...snapshot, groups: snapshot.groups.filter(({ id: groupId }) => groupId !== id.data) })
  await removeGroupReference(c.env.DATA, id.data)
  const warning = await recompileDelivery(c.env.DATA)
  if (warning) c.header('X-Catalog-Recompile', 'failed')
  return c.body(null, 204)
})
