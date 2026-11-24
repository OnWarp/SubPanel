import { mutateBinding, planBinding, bindingInput } from './bindings.js'
import { unifiedOperationsEnabled } from './user-access.js'
import { auditStatement } from '../admin/audit.js'
import { z } from 'zod'
import { batch } from '../db/db.js'
import { DELIVERY_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError, ApiError } from '../platform/api-error.js'
import { sha256Base64Url } from '../platform/hash.js'
import { CLIENT_IDS } from '../renderers/index.js'
import { bindingWrite, requirePublished } from '../templates/repository.js'
import { readDeliverySubscription } from './d1-repository.js'
import { bumpDeliveryRevision, getPlan } from './plans.js'

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
type Item = { id: string; state: string | null }

const reviewedState = `json_array(s.revision, b.revision, cb.revision)`
const reviewedJoins = `LEFT JOIN subscription_template_bindings b ON b.subscription_id=s.id
  LEFT JOIN conversion_bindings cb ON cb.subscription_id=s.id AND cb.platform='singbox'`

function targetQuery(action: Action): { sql: string; values: string[] } | undefined {
  if (isUnified(action)) return {
    sql: 'SELECT CAST(revision AS TEXT) AS version FROM entitlement_templates WHERE id=?', values: [action.templateId],
  }
  if (action.action === 'plan') return {
    sql: 'SELECT updated_at AS version FROM plans WHERE id=? AND enabled=1', values: [action.planId],
  }
  if (action.action !== 'binding' || action.templateBinding.mode === 'base') return
  if (action.templateBinding.mode === 'specific') return {
    sql: 'SELECT published_id AS version FROM subscription_templates WHERE id=? AND archived=0 AND published_id IS NOT NULL',
    values: [action.templateBinding.templateId],
  }
  return {
    sql: `SELECT json_array(d.revision,t.published_id) AS version FROM subscription_template_default d
      LEFT JOIN subscription_templates t ON t.id=d.template_id WHERE d.id=1`,
    values: [],
  }
}

async function targetVersion(db: D1Database, action: Action) {
  const query = targetQuery(action)
  if (!query) return null
  const row = await db.prepare(query.sql).bind(...query.values).first<{ version: string }>()
  if (!row) throw apiError(409, 'BATCH_TARGET_UNAVAILABLE', '目标计划或配置不可用，请重新选择')
  return row.version
}

export async function reviewBatch(env: DataEnv, input: Input, actor: string, previewId: string = crypto.randomUUID()) {
  if (!await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)) {
    throw apiError(409, 'SUBSCRIPTION_STORAGE_NOT_READY', '请先完成订阅 D1 迁移')
  }
  const ids = [...new Set(input.ids)].sort()
  const action = input.operation
  const unified = await unifiedOperationsEnabled(env.DB)
  if (unified !== isUnified(action)) throw apiError(422, 'BATCH_ACTION_UNAVAILABLE', '当前批量操作不可用')
  if (isUnified(action)) return reviewUnifiedBatch(env, action, ids, actor, previewId)
  if (!ids.every(id => idSchema.safeParse(id).success)) throw apiError(422, 'BATCH_ITEM_INVALID', '请选择订阅')
  const [found, target] = await Promise.all([
    env.DB.prepare(`SELECT s.id, ${reviewedState} AS state, s.enabled, s.plan_id, b.mode, b.template_id, cb.mode AS singbox_override FROM subscriptions s ${reviewedJoins}
      WHERE s.id IN (SELECT value FROM json_each(?)) ORDER BY s.id`).bind(JSON.stringify(ids)).all<{ id: string; state: string; enabled: number; plan_id: string | null; mode: string | null;
        template_id: string | null; singbox_override: string | null }>(),
    targetVersion(env.DB, action),
  ])
  const states = new Map(found.results.map(row => [row.id, row.state]))
  const items: Item[] = ids.map(id => ({ id, state: states.get(id) ?? null }))
  const affected = found.results.filter(row => {
    switch (action.action) {
      case 'enable': return row.enabled === 0
      case 'disable': return row.enabled === 1
      case 'plan': return row.plan_id !== action.planId
      case 'binding': return (row.mode ?? 'inherit') !== action.templateBinding.mode
        || (action.templateBinding.mode === 'specific' && row.template_id !== action.templateBinding.templateId)
    }
  })
  const platforms = !affected.length ? []
    : action.action === 'binding' ? (affected.some(row => !row.singbox_override) ? ['mihomo', 'singbox'] : ['mihomo']) : CLIENT_IDS
  const operation: Operation = { input: action, target }
  const fingerprint = await sha256Base64Url(JSON.stringify([actor, previewId, operation, items]))
  return { items, operation, preview: {
    previewId, fingerprint, selected: ids.length, affected: affected.length, missing: ids.length - found.results.length,
    platforms,
  } }
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
  const db = env.DB
  const now = new Date().toISOString()
  const action = operation.input
  const { id } = item
  if (isUnified(action)) return applyUnifiedItem(env, job, item, action, operation.target, now)
  if (await unifiedOperationsEnabled(db)) throw apiError(409, 'BATCH_ACTION_UNAVAILABLE', '请重新创建用户授权任务')
  if (item.reviewed_state === null) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  const current = await readDeliverySubscription(db, { id })
  if (!current) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  const [revision, mihomoRevision] = JSON.parse(item.reviewed_state) as [number, number | null, number | null]
  if (current.revision !== revision || await targetVersion(db, action) !== operation.target) {
    throw apiError(409, 'BATCH_PREVIEW_STALE', '订阅或目标已修改，请重新预览')
  }
  // Keep the checks, the mutation and its outcome in the same D1 transaction.
  // A NULL value violates the settings constraint and aborts the entire batch.
  const guard = db.prepare(`INSERT INTO system_settings(key,value,updated_at)
    SELECT 'subscription_batch_conflict',NULL,? WHERE NOT (${leaseGuard} AND EXISTS (
      SELECT 1 FROM subscriptions s ${reviewedJoins}
      WHERE s.id=? AND ${reviewedState}=? AND (s.user_id IS NULL OR EXISTS (
        SELECT 1 FROM users u WHERE u.id=s.user_id AND u.deleted_at IS NULL
      ))
    ) AND EXISTS (SELECT 1 FROM compile_job_items WHERE job_id=? AND subscription_id=? AND outcome IS NULL))`)
    .bind(now, job.id, job.lease, Date.now(), id, item.reviewed_state, job.id, id)
  const target = targetQuery(action)
  const targetGuard = target ? [db.prepare(`INSERT INTO system_settings(key,value,updated_at)
    SELECT 'subscription_batch_conflict',NULL,? WHERE NOT EXISTS (SELECT 1 FROM (${target.sql}) WHERE version=?)`)
    .bind(now, ...target.values, operation.target)] : []

  const statements: D1PreparedStatement[] = []
  switch (action.action) {
    case 'enable':
    case 'disable':
      statements.push(db.prepare('UPDATE subscriptions SET enabled=?,revision=revision+1,updated_at=? WHERE id=? AND enabled<>?')
        .bind(Number(action.action === 'enable'), now, id, Number(action.action === 'enable')))
      break
    case 'plan': {
      const plan = await getPlan(db, action.planId)
      statements.push(db.prepare(`UPDATE subscriptions SET plan_id=?,traffic_gb=?,speed_limit_mbps=?,device_limit=?,
        plan_revoked=0,plan_source='admin',plan_note='',last_reminded_at=NULL,revision=revision+1,updated_at=?
        WHERE id=? AND plan_id IS NOT ?`).bind(plan.id, plan.trafficGb, plan.speedLimitMbps, plan.deviceLimit, now, id, plan.id))
      break
    }
    case 'binding': {
      const choice = action.templateBinding
      if (choice.mode === 'specific') await requirePublished(db, choice.templateId)
      statements.push(bindingWrite(db, id, { ...choice, expectedRevision: mihomoRevision ?? 1 }, now, true))
      break
    }
  }
  await batch(db, [
    guard, ...targetGuard, ...statements, bumpDeliveryRevision(db, now),
    db.prepare(`UPDATE compile_job_items SET outcome='applied'
      WHERE job_id=? AND subscription_id=?`).bind(job.id, id),
  ])
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
