import { z } from 'zod'
import { groupIdSchema, MAX_NODES, nodeIdSchema } from '../catalog/schema.js'
import { batch, type AppDatabase } from '../db/db.js'
import { apiError } from '../platform/api-error.js'

export const bytesPerGiB = 1024 ** 3
export const durationSchema = z.object({
  value: z.number().int().min(1).max(36_500),
  unit: z.enum(['day', 'week', 'month', 'year']),
}).strict()

function uniqueIds(schema: typeof nodeIdSchema) {
  return z.array(schema).max(MAX_NODES).refine((ids) => new Set(ids).size === ids.length, '重复选择')
}

export const directNodeIdsSchema = uniqueIds(nodeIdSchema)
export const entitlementConfigSchema = z.object({
  duration: durationSchema,
  quotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  resetPolicy: z.literal('none'),
  groupIds: uniqueIds(groupIdSchema),
  nodeIds: directNodeIdsSchema,
  limits: z.object({
    speedLimitMbps: z.number().int().nonnegative().max(1_000_000),
  }).strict(),
}).strict().refine((config) => config.groupIds.length + config.nodeIds.length > 0, '请选择节点或动态分组')

export const templateStatusSchema = z.enum(['enabled', 'disabled', 'archived'])
export const templateInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2000).default(''),
  allowRedemption: z.boolean().default(false),
  config: entitlementConfigSchema,
}).strict()

export const templatePatchSchema = z.object({
  name: templateInputSchema.shape.name.optional(),
  description: z.string().trim().max(2000).optional(),
  allowRedemption: z.boolean().optional(),
  config: entitlementConfigSchema.optional(),
  status: templateStatusSchema.optional(),
  expectedRevision: z.number().int().positive(),
}).strict()

type TemplateInput = z.infer<typeof templateInputSchema>
type TemplatePatch = z.infer<typeof templatePatchSchema>
type Status = z.infer<typeof templateStatusSchema>
type VersionRow = {
  version_id: string
  version_no: number
  schema_version: number
  config_json: string
  version_created_by: string
  version_created_at: string
}
type TemplateRow = VersionRow & {
  id: string
  name: string
  description: string
  status: Status
  allow_redemption: number
  revision: number
  created_by: string
  created_at: string
  updated_at: string
  subscription_count: number
}

const versionColumns = `v.id AS version_id, v.version_no, v.schema_version, v.config_json,
  v.created_by AS version_created_by, v.created_at AS version_created_at`
const currentVersionJoin = `JOIN entitlement_template_versions v ON v.template_id = t.id
  AND v.version_no = (SELECT max(version_no) FROM entitlement_template_versions WHERE template_id = t.id)`
const templateSelect = `SELECT t.*, ${versionColumns}, (
  SELECT count(*) FROM entitlement_template_versions history
  JOIN subscription_template_origins o ON o.version_id = history.id
  WHERE history.template_id = t.id
) AS subscription_count FROM entitlement_templates t ${currentVersionJoin}`

function versionDto(row: VersionRow) {
  if (row.schema_version !== 1) throw new Error('Unsupported entitlement template schema')
  return {
    id: row.version_id,
    number: row.version_no,
    schemaVersion: row.schema_version,
    config: entitlementConfigSchema.parse(JSON.parse(row.config_json)),
    createdBy: row.version_created_by,
    createdAt: row.version_created_at,
  }
}

function templateDto(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    allowRedemption: row.allow_redemption === 1,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subscriptionCount: row.subscription_count,
    currentVersion: versionDto(row),
  }
}

export async function listEntitlementTemplates(db: AppDatabase, status?: Status) {
  const statement = status ? db.prepare(`${templateSelect} WHERE t.status = ? ORDER BY t.updated_at DESC, t.id`).bind(status)
    : db.prepare(`${templateSelect} ORDER BY t.updated_at DESC, t.id`)
  return (await statement.all<TemplateRow>()).results.map(templateDto)
}

export async function getEntitlementTemplate(db: AppDatabase, id: string) {
  const row = await db.prepare(`${templateSelect} WHERE t.id = ?`).bind(id).first<TemplateRow>()
  if (!row) throw apiError(404, 'ENTITLEMENT_TEMPLATE_NOT_FOUND', '订阅模板不存在')
  return templateDto(row)
}

export async function listEntitlementVersions(db: AppDatabase, id: string) {
  await getEntitlementTemplate(db, id)
  const { results } = await db.prepare(`SELECT ${versionColumns},
    (SELECT count(*) FROM subscription_template_origins WHERE version_id = v.id) AS subscription_count
    FROM entitlement_template_versions v WHERE v.template_id = ? ORDER BY v.version_no DESC`)
    .bind(id).all<VersionRow & { subscription_count: number }>()
  return results.map((row) => ({ ...versionDto(row), subscriptionCount: row.subscription_count }))
}

export function versionUnavailable(): never {
  throw apiError(409, 'ENTITLEMENT_VERSION_UNAVAILABLE', '模板已更新、停用或归档，请重新选择模板')
}

export async function getIssuableVersion(db: AppDatabase, id: string) {
  const row = await db.prepare(`SELECT t.name, ${versionColumns} FROM entitlement_templates t
    ${currentVersionJoin} WHERE v.id = ? AND t.status = 'enabled'`).bind(id).first<VersionRow & { name: string }>()
  if (!row) versionUnavailable()
  return { ...versionDto(row), name: row.name }
}

export async function countTemplateGroupReferences(db: AppDatabase, id: string) {
  const result = await db.prepare(`SELECT count(*) AS total FROM entitlement_templates t ${currentVersionJoin}
    JOIN json_each(v.config_json, '$.groupIds') AS selected
    WHERE t.status <> 'archived' AND selected.value = ?`).bind(id).first<number>('total')
  return result ?? 0
}

async function assertAvailableNodes(db: AppDatabase, nodes: string[]) {
  const row = await db.prepare(`SELECT count(*) AS total FROM nodes WHERE enabled = 1
    AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(nodes)).first<number>('total')
  if (row !== nodes.length) throw apiError(422, 'ENTITLEMENT_NODE_UNAVAILABLE', '请选择当前可用的节点')
}

function addVersion(db: AppDatabase, id: string, number: number, config: TemplateInput['config'], actor: string, now: string, guarded = false) {
  return db.prepare(`INSERT INTO entitlement_template_versions
    (id, template_id, version_no, schema_version, config_json, created_by, created_at)
    SELECT ?, ?, ?, 1, ?, ?, ? WHERE ${guarded ? 'changes() = 1' : 'true'}`)
    .bind(crypto.randomUUID(), id, number, JSON.stringify(config), actor, now)
}

function mapVersionError(error: unknown): never {
  if (error instanceof Error && error.message.includes('ENTITLEMENT_GROUP_MISSING')) {
    throw apiError(422, 'ENTITLEMENT_GROUP_MISSING', '所选分组已删除，请重新选择')
  }
  if (error instanceof Error && error.message.includes('ENTITLEMENT_NODE_MISSING')) {
    throw apiError(422, 'ENTITLEMENT_NODE_UNAVAILABLE', '请选择当前可用的节点')
  }
  throw error
}

export async function createEntitlementTemplate(db: AppDatabase, input: TemplateInput, actor: string, status: 'enabled' | 'disabled' = 'enabled') {
  await assertAvailableNodes(db, input.config.nodeIds)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await batch(db, [
    db.prepare(`INSERT INTO entitlement_templates (id, name, description, status, allow_redemption, revision, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).bind(id, input.name, input.description, status, Number(input.allowRedemption), actor, now, now),
    addVersion(db, id, 1, input.config, actor, now),
  ]).catch(mapVersionError)
  return getEntitlementTemplate(db, id)
}

export async function updateEntitlementTemplate(db: AppDatabase, id: string, input: TemplatePatch, actor: string) {
  const current = await getEntitlementTemplate(db, id)
  if (current.revision !== input.expectedRevision) throw apiError(409, 'ENTITLEMENT_TEMPLATE_CONFLICT', '模板已更新，请刷新后重试')
  if (current.status === 'archived') throw apiError(409, 'ENTITLEMENT_TEMPLATE_ARCHIVED', '模板已归档')
  const configChanged = input.config && JSON.stringify(input.config) !== JSON.stringify(current.currentVersion.config)
  const now = new Date().toISOString()
  const status = input.status ?? current.status
  if (configChanged && input.config) await assertAvailableNodes(db, input.config.nodeIds)
  const [result] = await batch(db, [
    db.prepare(`UPDATE entitlement_templates SET name = ?, description = ?, status = ?, allow_redemption = ?,
      revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .bind(input.name ?? current.name, input.description ?? current.description, status,
        Number(input.allowRedemption ?? current.allowRedemption), now, id, current.revision),
    ...(configChanged && input.config ? [addVersion(db, id, current.currentVersion.number + 1, input.config, actor, now, true)] : []),
  ]).catch(mapVersionError)
  if (result.meta.changes !== 1) throw apiError(409, 'ENTITLEMENT_TEMPLATE_CONFLICT', '模板已更新，请刷新后重试')
  return getEntitlementTemplate(db, id)
}
