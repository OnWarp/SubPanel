import { mutateBinding, planBinding, bindingInput } from './bindings.js'
import { unifiedOperationsEnabled } from './user-access.js'
import { auditStatement } from '../admin/audit.js'
import { z } from 'zod'
import { batch } from '../db/db.js'
import { DELIVERY_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError, ApiError } from '../platform/api-error.js'
import { sha256Base64Url } from '../platform/hash.js'
import { CLIENT_IDS } from '../renderers/index.js'

const idSchema = z.string().regex(/^sub_[1-9]\d*$/u).max(32)
const binding = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('specific'), templateId: z.string().min(1).max(128) }),
  z.object({ mode: z.enum(['inherit', 'base']) }),
])
const unifiedAction = z.strictObject({
  action: z.enum(['assign', 'renew', 'pause', 'revoke']),
  templateId: z.string().min(1).max(128),
  days: z.number().int().min(1).max(36500).optional(),
})

export const batchAction = z.discriminatedUnion('action', [
  unifiedAction,
  z.object({ action: z.enum(['enable', 'disable']) }),
  z.object({ action: z.literal('plan'), planId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('binding'), templateBinding: binding }),
])
export const batchInput = z.object({ ids: z.array(z.union([idSchema, z.string().regex(/^usr_[1-9]\d*$/u).max(32)])).min(1).max(1000), operation: batchAction })
export const batchConfirmation = batchInput.extend({ previewId: z.uuid(), fingerprint: z.string().length(43) })
type Action = z.infer<typeof batchAction>
type UnifiedAction = z.infer<typeof unifiedAction>
const isUnified = (action: Action): action is UnifiedAction => 'templateId' in action
type Input = z.infer<typeof batchInput>
export type Operation = { input: Action; target: string | null }
async function targetVersion(db: D1Database, action: UnifiedAction) {
  const row = await db.prepare('SELECT CAST(revision AS TEXT) AS version FROM entitlement_templates WHERE id=?')
    .bind(action.templateId).first<{ version: string }>()
  if (!row) throw apiError(409, 'BATCH_TARGET_UNAVAILABLE', '目标计划或配置不可用，请重新选择')
  return row.version
}

export async function reviewBatch(env: DataEnv, input: Input, actor: string, previewId: string = crypto.randomUUID()) {
  if (!await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)) {
    throw apiError(409, 'SUBSCRIPTION_STORAGE_NOT_READY', '请先完成订阅 D1 迁移')
  }
  const ids = [...new Set(input.ids)].sort()
  const action = input.operation
  if (!await unifiedOperationsEnabled(env.DB) || !isUnified(action)) {
    throw apiError(422, 'BATCH_ACTION_UNAVAILABLE', '当前批量操作不可用')
  }
  return reviewUnifiedBatch(env, action, ids, actor, previewId)
}

export async function enqueueBatch(db: D1Database, actor: string, id: string, reviewed: Awaited<ReturnType<typeof reviewBatch>>) {
  const now = new Date().toISOString()
  await batch(db, [
    db.prepare(`INSERT INTO compile_jobs (id,actor_user_id,platform,total,created_at,updated_at,operation_json)
      VALUES (?,?,'generic',?,?,?,?)`).bind(id, actor, reviewed.items.length, now, now, JSON.stringify(reviewed.operation)),
    db.prepare(`INSERT INTO compile_job_items (job_id,subscription_id,reviewed_state)
      SELECT ?, json_extract(value,'$.id'), json_extract(value,'$.state') FROM json_each(?)`)
      .bind(id, JSON.stringify(reviewed.items)),
    auditStatement(db, actor, 'subscription_batch.created', 'compile_job', id, {
      action: reviewed.operation.input.action, affected: reviewed.preview.affected, selected: reviewed.preview.selected,
      missing: reviewed.preview.missing, platforms: reviewed.preview.platforms,
    }, now),
  ])
}

type BatchItem = { id: string; reviewed_state: string | null }
type Lease = { id: string; lease: string; actor: string }
const leaseGuard = `EXISTS (SELECT 1 FROM compile_jobs WHERE id=? AND lease=? AND status='running' AND lease_until > ?)`

async function applyItem(env: DataEnv, job: Lease, item: BatchItem, operation: Operation) {
  const now = new Date().toISOString()
  const action = operation.input
  if (!isUnified(action)) throw apiError(410, 'BATCH_ACTION_UNAVAILABLE', '旧批量任务已停用')
  return applyUnifiedItem(env, job, item, action, operation.target, now)
}

export async function runBatchItem(env: DataEnv, job: Lease, item: BatchItem, operation: Operation) {
  try {
    await applyItem(env, job, item, operation)
  } catch (error) {
    const code = error instanceof ApiError ? error.code
      : error instanceof Error && error.message.includes('NOT NULL constraint failed: system_settings.value')
        ? 'BATCH_PREVIEW_STALE' : 'SUBSCRIPTION_BATCH_ITEM_FAILED'
    await env.DB.prepare(`UPDATE compile_job_items SET outcome='failed',error_code=?
      WHERE job_id=? AND subscription_id=? AND outcome IS NULL AND ${leaseGuard}`)
      .bind(code, job.id, item.id, job.id, job.lease, Date.now()).run()
  }
}

function unifiedOperation(action: UnifiedAction, expectedRevision: number, requestId: string) {
  return bindingInput.parse({
    mode: action.action, expectedRevision, requestId,
    ...(['assign', 'renew'].includes(action.action) && action.days !== undefined
      ? { expiry: { type: 'duration', duration: { unit: 'day', value: action.days } } } : {}),
  })
}

async function reviewUnifiedBatch(env: DataEnv, action: UnifiedAction, ids: string[], actor: string, previewId: string) {
  if (ids.length > 32 || !ids.every(id => /^usr_[1-9]\d*$/.test(id))) {
    throw apiError(422, 'BATCH_ITEM_INVALID', '请选择最多 32 位用户')
  }
  const target = await targetVersion(env.DB, action)
  const found = await env.DB.prepare(`SELECT u.id,coalesce(a.revision,0) AS revision
    FROM users u LEFT JOIN user_subscription_access a ON a.user_id=u.id
    WHERE u.enabled=1 AND u.deleted_at IS NULL AND u.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all<{ id: string; revision: number }>()
  const revisions = new Map(found.results.map(row => [row.id, row.revision]))
  const items = ids.map(id => ({ id, state: revisions.has(id) ? String(revisions.get(id)) : null }))
  let affected = 0
  const changes = []
  for (const { id, state } of items) {
    if (state === null) continue
    try {
      const result = await planBinding(env.DB, id, action.templateId,
        unifiedOperation(action, Number(state), previewId), Date.now())
      affected++
      changes.push({ userId: id, changes: result.changes })
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      changes.push({ userId: id, errorCode: error.code })
    }
  }
  const operation: Operation = { input: action, target }
  const fingerprint = await sha256Base64Url(JSON.stringify([actor, previewId, operation, items]))
  return { operation, items, preview: {
    previewId, fingerprint, selected: ids.length, affected, missing: ids.length - found.results.length,
    platforms: affected ? CLIENT_IDS : [], changes,
  } }
}

async function applyUnifiedItem(env: DataEnv, job: Lease, item: BatchItem, action: UnifiedAction, target: string | null, now: string) {
  if (!await unifiedOperationsEnabled(env.DB)) throw apiError(409, 'BATCH_ACTION_UNAVAILABLE', '批量授权暂不可用')
  if (item.reviewed_state === null) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  const db = env.DB
  await mutateBinding(env, item.id, action.templateId,
    unifiedOperation(action, Number(item.reviewed_state), job.id), job.actor, Date.parse(now), changes => [
      db.prepare(`INSERT INTO system_settings(key,value,updated_at)
        SELECT 'subscription_batch_conflict',NULL,? WHERE NOT (
          ${leaseGuard} AND EXISTS (SELECT 1 FROM entitlement_templates WHERE id=? AND revision=?)
          AND EXISTS (SELECT 1 FROM compile_job_items WHERE job_id=? AND subscription_id=? AND outcome IS NULL))`)
        .bind(now, job.id, job.lease, Date.now(), action.templateId, Number(target), job.id, item.id),
      db.prepare(`UPDATE compile_job_items SET outcome='applied' WHERE job_id=? AND subscription_id=?`).bind(job.id,item.id),
      auditStatement(db, job.actor, 'subscription_batch.binding', 'user', item.id,
        { userId: item.id, templateId: action.templateId, requestId: job.id, changes }, now),
    ])
}
