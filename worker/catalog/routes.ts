import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import {
  CatalogImportError,
  createSource,
  cancelSourceSync,
  previewSourceSync,
  previewImportDiff,
  deleteSource,
  refreshSource,
  recompileDelivery,
  summarizeSources,
  updateSource,
} from './import-service.js'
import { catalogSnapshotSchema, groupIdSchema, groupRulesSchema, formatOverrideSchema, nodeIdSchema, nodeSchema, sourceIdSchema, tagsSchema, type CatalogSnapshot, type Group, type Node } from './schema.js'
import { readCatalog, writeCatalog } from './repository.js'
import { RemoteFetchError } from './remote.js'
import { detectImport } from '../import/detect.js'
import type { Subscription } from '../delivery/schema.js'
import { readDelivery } from '../delivery/repository.js'
import { countTemplateGroupReferences } from '../delivery/entitlement-templates.js'

import { CLIENT_IDS, prepareClientRender, renderClient } from '../renderers/index.js'
import { previewCatalogEntitlement, selectedNodes } from '../delivery/compiler.js'
import { listPlans, type Plan } from '../delivery/plans.js'
import { resolveGroupCandidates, resolveGroupNodes } from './groups.js'
import { MAX_NODES } from './repository.js'
import { logAudit } from '../admin/audit.js'

const sourceName = z.string().trim().min(1).max(128)
const headers = z.record(z.string(), z.string()).default({})
const createSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['manual', 'file']), name: sourceName, content: z.string().min(1), enabled: z.boolean().optional(), keepOnFailure: z.boolean().optional() }),
  z.object({ type: z.literal('remote'), name: sourceName, url: z.string().min(1), headers, formatOverride: formatOverrideSchema.optional(), refreshIntervalMinutes: z.number().int().positive(), enabled: z.boolean().optional(), keepOnFailure: z.boolean().optional() }),
])
const updateSourceSchema = z.object({
  name: sourceName.optional(),
  enabled: z.boolean().optional(),
  keepOnFailure: z.boolean().optional(),
  content: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  refreshIntervalMinutes: z.number().int().positive().optional(),
  formatOverride: formatOverrideSchema.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
const previewSchema = z.object({ content: z.string().min(1), sourceId: sourceIdSchema.optional() })
const nodeName = z.string().trim().min(1).max(256).refine((name) => !/[\r\n]/u.test(name))
const nodeConnectionSchema = nodeSchema.pick({
  protocol: true, port: true, credentials: true, tls: true, transport: true, plugin: true, extensions: true,
}).extend({
  server: z.string().trim().min(1).max(2048).regex(/^[^\s,=/]+$/u),
})
const nodePatchSchema = nodeConnectionSchema.partial().extend({
  displayName: nodeName.optional(),
  enabled: z.boolean().optional(),
  retained: z.boolean().optional(),
  order: z.number().int().nonnegative().optional(),
  tags: tagsSchema.optional(),
  region: z.string().trim().max(64).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
const groupInputSchema = z.object({
  name: sourceName,
  sourceIds: z.array(sourceIdSchema),
  includedNodeIds: z.array(nodeIdSchema),
  excludedNodeIds: z.array(nodeIdSchema),
  nodeOrder: z.array(nodeIdSchema),
  rules: groupRulesSchema.optional(),
})

const MAX_CONTENT_BYTES = 5 * 1024 * 1024

function assertContentSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
    throw apiError(413, 'CONTENT_TOO_LARGE', '导入内容超过大小限制')
  }
}

function mapCatalogError(error: unknown): never {
  if (error instanceof RemoteFetchError) {
    const message = error.code === 'REMOTE_CANCELLED' ? '同步已取消'
      : error.code === 'REMOTE_TIMEOUT' ? '同步请求超时，请检查来源响应后重试'
      : error.code === 'REMOTE_HTTP_ERROR' ? '来源返回 HTTP 错误，请检查地址和鉴权设置'
      : '远程来源请求失败，请检查 HTTPS 地址和响应内容'
    throw apiError(422, error.code, message)
  }
  if (error instanceof CatalogImportError) {
    const status = error.code === 'CATALOG_SOURCE_NOT_FOUND' ? 404 : ['CATALOG_NODE_LIMIT', 'CATALOG_PREVIEW_STALE', 'CATALOG_SYNC_BUSY'].includes(error.code) ? 409 : error.code === 'CATALOG_SOURCE_TYPE_INVALID' ? 409 : 422
    const message = error.code === 'CATALOG_PREVIEW_STALE' ? '预览已过期或目录已变更，请重新预览'
      : error.code === 'CATALOG_SYNC_BUSY' ? '同步正在进行，请稍后重试'
      : error.code === 'CATALOG_NODE_LIMIT' ? '节点数量超出上限，请清理节点后重试'
      : '目录操作未完成，请检查来源和输入后重试'
    throw apiError(status, error.code, message)
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
    originNodeId: node.originNodeId,
    tags: node.tags,
    region: node.region,
    lastSeenAt: node.lastSeenAt,
    missingSince: node.missingSince,
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

catalogRoutes.use('*', async (c, next) => {
  await next()
  const method = c.req.method.toLowerCase()
  if (method === 'get' || c.res.status >= 400) return
  const path = c.req.path.slice('/api/admin/catalog/'.length)
  if (!/^(sources|nodes|groups)(\/[^/]+)?(\/(confirm-sync|cancel-sync))?$/u.test(path) || path === 'groups/preview') return
  const [entity, id, action] = path.split('/')
  try {
    await logAudit(c.env.DB, c.get('principal').id, `${method}.catalog.${entity}${action ? `.${action}` : ''}`, entity, id ?? null)
  } catch {
    // Audit storage is best effort, as for existing admin mutations.
  }
})

catalogRoutes.get('/', async (c) => {
  const snapshot = await readCatalog(c.env)
  const sources = await summarizeSources(c.env, snapshot.sources)
  return c.json({
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    sources,
    nodes: snapshot.nodes.map((node) => ({
      ...safeNode(node),
      duplicateAcrossSources: node.sourceIds.length > 1 || snapshot.nodes.some((other) => other.id !== node.id &&
        (other.sourceFingerprint ?? other.fingerprint) === (node.sourceFingerprint ?? node.fingerprint)
        && other.sourceIds.some((id) => !node.sourceIds.includes(id))),
    })),
    groups: snapshot.groups.map((group) => ({ ...group, resolvedNodeIds: resolveGroupNodes(snapshot, group.id).map(({ id }) => id) })),
  })
})

catalogRoutes.post('/preview', async (c) => {
  const input = await readJson(c, previewSchema)
  assertContentSize(input.content)
  const result = await run(async () => detectImport(input.content))
  if (result.nodes.length === 0) throw apiError(422, 'IMPORT_ZERO_NODES', '未检测到可导入节点')
  const catalog = await readCatalog(c.env)
  const source = catalog.sources.find(({ id }) => id === input.sourceId)
  if (input.sourceId && !source) throw apiError(404, 'CATALOG_SOURCE_NOT_FOUND', '来源不存在')
  if (source?.type === 'remote') throw apiError(409, 'CATALOG_SOURCE_TYPE_INVALID', '请从远程来源发起同步预览')
  return c.json({
    format: result.format,
    diff: await run(() => previewImportDiff(result, catalog, source?.id)),
    nodes: result.nodes.map(safePreviewNode),
    warnings: result.warnings,
  })
})

catalogRoutes.post('/sources', async (c) => {
  const input = await readJson(c, createSourceSchema)
  if (input.type !== 'remote') assertContentSize(input.content)
  const result = await run(() => createSource(c.env, input.type === 'remote' ? { ...input, deferSync: true } : input))
  return c.json(result, 201)
})

catalogRoutes.put('/sources/:sourceId', async (c) => {
  const id = sourceIdSchema.safeParse(c.req.param('sourceId'))
  if (!id.success) throw apiError(404, 'CATALOG_SOURCE_NOT_FOUND', '来源不存在')
  const input = await readJson(c, updateSourceSchema)
  if (input.content !== undefined) assertContentSize(input.content)
  const result = await run(() => updateSource(c.env, id.data, input))
  return c.json(result)
})

catalogRoutes.delete('/sources/:sourceId', async (c) => {
  const id = sourceIdSchema.safeParse(c.req.param('sourceId'))
  if (!id.success) throw apiError(404, 'CATALOG_SOURCE_NOT_FOUND', '来源不存在')
  const warning = await run(() => deleteSource(c.env, id.data))
  if (warning) c.header('X-Catalog-Recompile', 'failed')
  return c.body(null, 204)
})

catalogRoutes.post('/sources/:sourceId/refresh', async (c) => {
  const id = sourceIdSchema.safeParse(c.req.param('sourceId'))
  if (!id.success) throw apiError(404, 'CATALOG_SOURCE_NOT_FOUND', '来源不存在')
  const result = await run(() => previewSourceSync(c.env, id.data))
  return c.json(result)
})

catalogRoutes.post('/sources/:sourceId/preview-diff', async (c) => {
  const result = await run(() => previewSourceSync(c.env, c.req.param('sourceId')))
  return c.json(result)
})

catalogRoutes.post('/sources/:sourceId/confirm-sync', async (c) => {
  const { previewId } = await readJson(c, z.object({ previewId: z.uuid() }))
  return c.json(await run(() => refreshSource(c.env, c.req.param('sourceId'), { previewId })))
})

catalogRoutes.post('/sources/:sourceId/cancel-sync', async (c) => {
  const { previewId } = c.req.header('Content-Type') ? await readJson(c, z.object({ previewId: z.uuid().optional() })) : {}
  return c.json({ cancelled: await run(() => cancelSourceSync(c.env, c.req.param('sourceId'), previewId)) })
})

catalogRoutes.get('/sources/:sourceId/sync-runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, started_at, finished_at, status, details FROM catalog_sync_runs WHERE source_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 20',
  ).bind(c.req.param('sourceId')).all<{ id: string; started_at: string; finished_at: string; status: string; details: string }>()
  return c.json({ runs: results.map(({ details, ...run }) => ({ ...run, details: JSON.parse(details) })) })
})

function affectedGroupSubscriptions(
  before: CatalogSnapshot,
  after: CatalogSnapshot,
  groupId: string,
  subscriptions: Subscription[],
  plans: Plan[],
) {
  const planById = new Map(plans.map((plan) => [plan.id, plan]))
  return subscriptions.filter((subscription) => {
    if (!subscription.groupIds.includes(groupId)) return false
    const plan = subscription.planId && subscription.userId !== null ? planById.get(subscription.planId) : undefined
    if (subscription.planId && subscription.userId !== null && !plan?.groupIds.includes(groupId)) return false
    const intersection = {
      groupIds: plan ? subscription.groupIds.filter((id) => plan.groupIds.includes(id)) : subscription.groupIds,
      nodeIds: subscription.planId ? undefined : subscription.nodeIds,
    }
    const oldIds = selectedNodes(before, intersection).map(({ id }) => id)
    const newIds = selectedNodes(after, intersection).map(({ id }) => id)
    return oldIds.length !== newIds.length || oldIds.some((id, index) => id !== newIds[index])
  })
}

const clientSchema = z.enum(CLIENT_IDS)
const nodeCreateSchema = nodeConnectionSchema.partial().extend({
  originNodeId: nodeIdSchema.optional(),
  enabled: z.boolean().optional(),
  retained: z.boolean().optional(),
  tags: tagsSchema.optional(),
  region: z.string().trim().max(64).optional(),
  displayName: nodeName,
})

function requireRenderable(node: Node) {
  if (!CLIENT_IDS.some((client) => prepareClientRender(client, [{ ...node, enabled: true }]).outputNodes > 0)) {
    throw apiError(422, 'NODE_CONNECTION_INVALID', '请检查协议所需的连接参数')
  }
}

catalogRoutes.post('/nodes', async (c) => {
  const input = await readJson(c, nodeCreateSchema)
  const snapshot = await readCatalog(c.env)
  if (snapshot.nodes.length >= MAX_NODES) throw apiError(409, 'CATALOG_NODE_LIMIT', '已达到节点数量上限')
  const original = snapshot.nodes.find((node) => node.id === input.originNodeId)
  if (input.originNodeId && !original) throw apiError(404, 'CATALOG_NODE_NOT_FOUND', '节点不存在')
  const now = new Date().toISOString()
  const id = `node_${snapshot.nextNodeId}`
  const result = nodeSchema.safeParse({
    ...original, credentials: original?.credentials ?? {}, extensions: original?.extensions ?? {}, ...input,
    id, displayNameOverride: input.displayName, sourceFingerprint: undefined, fingerprint: `manual:${id}`,
    sourceIds: [], rawVariants: [], lastSeenAt: undefined, missingSince: undefined,
    enabled: input.enabled ?? true, retained: input.retained ?? true, order: Math.max(0, ...snapshot.nodes.map((node) => node.order)) + 1,
    createdAt: now, updatedAt: now,
  })
  if (!result.success) throw apiError(422, 'NODE_CONNECTION_INVALID', '请检查协议所需的连接参数')
  const node = result.data
  requireRenderable(node)
  await writeCatalog(c.env, { ...snapshot, nextNodeId: snapshot.nextNodeId + 1, nodes: [...snapshot.nodes, node] }, now)
  return c.json({ node: safeNode(node), warning: await recompileDelivery(c.env) }, 201)
})

catalogRoutes.post('/nodes/:nodeId/details', async (c) => {
  const node = (await readCatalog(c.env)).nodes.find(({ id }) => id === c.req.param('nodeId'))
  if (!node) throw apiError(404, 'CATALOG_NODE_NOT_FOUND', '节点不存在')
  c.header('Cache-Control', 'no-store')
  return c.json({ credentials: node.credentials, tls: node.tls, transport: node.transport, plugin: node.plugin,
    extensions: node.extensions, rawVariants: node.rawVariants })
})

catalogRoutes.post('/nodes/:nodeId/test-output', async (c) => {
  const { client } = await readJson(c, z.object({ client: clientSchema }))
  const node = (await readCatalog(c.env)).nodes.find(({ id }) => id === c.req.param('nodeId'))
  if (!node) throw apiError(404, 'CATALOG_NODE_NOT_FOUND', '节点不存在')
  c.header('Cache-Control', 'no-store')
  return c.json(renderClient(client, [{ ...node, enabled: true }]))
})

catalogRoutes.patch('/nodes/:nodeId', async (c) => {
  const id = nodeIdSchema.safeParse(c.req.param('nodeId'))
  if (!id.success) throw apiError(404, 'CATALOG_NODE_NOT_FOUND', '节点不存在')
  const input = await readJson(c, nodePatchSchema)
  const snapshot = await readCatalog(c.env)
  const node = snapshot.nodes.find(({ id: nodeId }) => nodeId === id.data)
  if (!node) throw apiError(404, 'CATALOG_NODE_NOT_FOUND', '节点不存在')
  const updated = { ...node, ...input, displayNameOverride: input.displayName ?? node.displayNameOverride, updatedAt: new Date().toISOString() }
  if (Object.keys(nodeConnectionSchema.shape).some((key) => key in input)) requireRenderable(updated)
  const saved = await writeCatalog(c.env, { ...snapshot, nodes: snapshot.nodes.map((current) => current.id === id.data ? updated : current) }, updated.updatedAt)
  const warning = await recompileDelivery(c.env)
  return c.json({ node: safeNode(saved.nodes.find(({ id: nodeId }) => nodeId === id.data)!), ...(warning ? { warning } : {}) })
})

catalogRoutes.post('/groups/preview', async (c) => {
  const { input, groupId, subscriptionId, client } = await readJson(c, z.object({
    input: groupInputSchema, groupId: groupIdSchema.optional(),
    subscriptionId: z.string().max(128).optional(), client: clientSchema,
  }))
  const [snapshot, delivery, plans] = await Promise.all([readCatalog(c.env), readDelivery(c.env), listPlans(c.env.DB)])
  validateReferences(snapshot, input)
  if (groupId && !snapshot.groups.some((group) => group.id === groupId)) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  const id = groupId ?? `grp_${snapshot.nextGroupId}`
  const now = new Date().toISOString()
  const group = { id, createdAt: now, updatedAt: now, ...input } satisfies Group
  const candidate = { ...snapshot, groups: [...snapshot.groups.filter((group) => group.id !== id), group],
    nextGroupId: groupId ? snapshot.nextGroupId : snapshot.nextGroupId + 1 }
  if (!catalogSnapshotSchema.safeParse(candidate).success) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
  const matching = resolveGroupCandidates(candidate, group)
  const nodes = resolveGroupNodes(candidate, group.id)
  const prepared = prepareClientRender(client, nodes).render()
  const skipped = new Set(prepared.diagnostics.filter((item) => item.outcome === 'skipped').map((item) => item.nodeId))
  const subscriptions = affectedGroupSubscriptions(snapshot, candidate, id, delivery.subscriptions, plans)
  const subscription = delivery.subscriptions.find((sub) => sub.id === subscriptionId)
  if (subscriptionId && !subscription) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  return c.json({
    matched: matching.length, disabled: matching.length - nodes.length,
    incompatible: nodes.length - prepared.outputNodes, outputNodes: prepared.outputNodes,
    nodes: nodes.filter((node) => !skipped.has(node.id)).map(({ id, displayName }) => ({ id, displayName })),
    affectedSubscriptions: subscriptions.length,
    entitlement: subscription ? await previewCatalogEntitlement(c.env, subscription, client, candidate) : undefined,
  })
})

catalogRoutes.post('/groups', async (c) => {
  const input = await readJson(c, groupInputSchema)
  const snapshot = await readCatalog(c.env)
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
  const saved = await writeCatalog(c.env, candidate, now)
  return c.json({ group: saved.groups.find(({ id }) => id === group.id) }, 201)
})

catalogRoutes.put('/groups/:groupId', async (c) => {
  const id = groupIdSchema.safeParse(c.req.param('groupId'))
  if (!id.success) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  const input = await readJson(c, groupInputSchema)
  const snapshot = await readCatalog(c.env)
  const current = snapshot.groups.find(({ id: groupId }) => groupId === id.data)
  if (!current) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  validateReferences(snapshot, input)
  const updated: Group = { ...current, ...input, rules: input.rules ?? {}, updatedAt: new Date().toISOString() }
  const candidate = { ...snapshot, groups: snapshot.groups.map((group) => group.id === id.data ? updated : group) }
  if (!catalogSnapshotSchema.safeParse(candidate).success) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败')
  const saved = await writeCatalog(c.env, candidate, updated.updatedAt)
  return c.json({ group: saved.groups.find(({ id: groupId }) => groupId === id.data) })
})

catalogRoutes.delete('/groups/:groupId', async (c) => {
  const id = groupIdSchema.safeParse(c.req.param('groupId'))
  if (!id.success) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  const snapshot = await readCatalog(c.env)
  if (!snapshot.groups.some(({ id: groupId }) => groupId === id.data)) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  const [delivery, plans, templates] = await Promise.all([
    readDelivery(c.env), listPlans(c.env.DB), countTemplateGroupReferences(c.env.DB, id.data),
  ])
  const subscriptions = delivery.subscriptions.filter((sub) => sub.groupIds.includes(id.data)).length
  const activePlans = plans.filter((plan) => plan.enabled && plan.groupIds.includes(id.data)).length
  if (subscriptions || templates || activePlans) {
    throw apiError(409, 'GROUP_IN_USE', `分组仍被 ${subscriptions} 个订阅、${templates} 个订阅模板和 ${activePlans} 个启用计划引用，请先更换或移除引用`, {
      subscriptions, templates, activePlans,
    })
  }
  await writeCatalog(c.env, { ...snapshot, groups: snapshot.groups.filter(({ id: groupId }) => groupId !== id.data) })
  return c.body(null, 204)
})
