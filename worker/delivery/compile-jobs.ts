import { unifiedOperationsEnabled } from './user-access.js'
import { sha256Base64Url } from '../platform/hash.js'
import { batchConfirmation, batchInput, enqueueBatch, reviewBatch, runBatchItem, type Operation } from './subscription-batch.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { batch } from '../db/db.js'
import { readCatalogFromD1 } from '../catalog/d1-repository.js'
import { DELIVERY_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError, ApiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { CLIENT_IDS, type RenderClient } from '../renderers/index.js'
import { inspectSubscriptionArtifact, loadSubscriptionArtifact } from './artifacts.js'
import { readDeliverySubscription } from './d1-repository.js'

const scopeSchema = z.object({
  platform: z.enum(CLIENT_IDS),
  planId: z.string().min(1).max(128).optional(),
  groupId: z.string().regex(/^grp_[1-9]\d*$/u).optional(),
})
type Scope = z.infer<typeof scopeSchema>
type Job = {
  id: string; actor_user_id: string; platform: RenderClient; plan_id: string | null; group_id: string | null;
  operation_json: string | null; cursor: string; status: string; lease: string | null; lease_until: number | null;
}
const pageSize = 4
const leaseMs = 120_000

function scopeFilter(scope: { plan_id: string | null; group_id: string | null }) {
  const conditions: string[] = []
  const values: string[] = []
  if (scope.plan_id) {
    conditions.push('s.plan_id = ?')
    values.push(scope.plan_id)
  }
  if (scope.group_id) {
    conditions.push('s.id IN (SELECT subscription_id FROM subscription_groups WHERE group_id = ?)')
    values.push(scope.group_id)
  }
  return { sql: conditions.length ? ' AND ' + conditions.join(' AND ') : '', values }
}

const jobFields = `id, platform, json_extract(operation_json,'$.input.action') AS action, plan_id AS planId, group_id AS groupId, status, total,
  compiled, cache_hits AS cacheHits, skipped, failures, (compiled+cache_hits+skipped+failures) AS processed,
  last_failure_id AS lastFailureId,
  error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt, run_ms AS durationMs,
  (lease IS NOT NULL AND lease_until > ?) AS busy`

async function getJob(db: D1Database, id: string) {
  const job = await db.prepare(`SELECT ${jobFields} FROM compile_jobs WHERE id=?`).bind(Date.now(), id).first()
  if (!job) throw apiError(404, 'COMPILE_JOB_NOT_FOUND', '编译任务不存在')
  return job
}

async function createJob(env: DataEnv, scope: Scope, actor: string) {
  if (!await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)) {
    throw apiError(409, 'SUBSCRIPTION_STORAGE_NOT_READY', '请先完成订阅 D1 迁移')
  }
  const planId = scope.planId ?? null
  const groupId = scope.groupId ?? null
  const filter = scopeFilter({ plan_id: planId, group_id: groupId })
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await batch(env.DB, [
    env.DB.prepare(`INSERT INTO compile_jobs
      (id, actor_user_id, platform, plan_id, group_id, total, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, count(*), ?, ? FROM subscriptions s WHERE 1=1${filter.sql}`)
      .bind(id, actor, scope.platform, planId, groupId, now, now, ...filter.values),
    env.DB.prepare(`INSERT INTO compile_job_items (job_id, subscription_id)
      SELECT ?, s.id FROM subscriptions s WHERE 1=1${filter.sql}`).bind(id, ...filter.values),
  ])
  return getJob(env.DB, id)
}

function rejectRetiredAction(action: unknown) {
  if (action === 'copy' || action === 'transfer') throw apiError(410, 'SUBSCRIPTION_BATCH_ACTION_REMOVED', '订阅批量操作已移除')
}

async function runPage(env: DataEnv, id: string) {
  const db = env.DB
  const started = Date.now()
  const lease = crypto.randomUUID()
  const job = await db.prepare(`UPDATE compile_jobs SET lease=?, lease_until=?, status='running', updated_at=?
    WHERE id=? AND status IN ('queued','running')
      AND coalesce(json_extract(operation_json,'$.input.action'),'') NOT IN ('copy','transfer') AND (lease_until IS NULL OR lease_until <= ?)
    RETURNING *`).bind(lease, started + leaseMs, new Date(started).toISOString(), id, started).first<Job>()
  if (!job) {
    const existing = await getJob(db, id)
    rejectRetiredAction(existing.action)
    throw apiError(409, 'COMPILE_JOB_UNAVAILABLE', '任务正在执行或已结束')
  }

  if (job.operation_json) return runBatchPage(env, job, lease, started)

  const counts = { compiled: 0, hits: 0, skipped: 0, failures: 0 }
  let cursor = job.cursor
  let failureId: string | null = null
  let errorCode: string | null = null
  let more = false
  let pageFailed = false
  try {
    const page = (await db.prepare(`SELECT subscription_id AS id FROM compile_job_items
      WHERE job_id=? AND subscription_id > ? ORDER BY subscription_id LIMIT ?`)
      .bind(id, job.cursor, pageSize + 1).all<{ id: string }>()).results
    more = page.length > pageSize
    const catalog = page.length ? await readCatalogFromD1(db) : undefined
    for (const row of page.slice(0, pageSize)) {
      const active = await db.prepare("SELECT 1 FROM compile_jobs WHERE id=? AND lease=? AND status='running'")
        .bind(id, lease).first()
      if (!active) return getJob(db, id)
      try {
        const subscription = await readDeliverySubscription(db, { id: row.id })
        if (!subscription || (job.plan_id && subscription.planId !== job.plan_id)
          || (job.group_id && !subscription.groupIds.includes(job.group_id))) {
          counts.skipped++
        } else {
          const result = await loadSubscriptionArtifact(env, subscription, job.platform, new Date().toISOString(), { catalog })
          if (result.outcome === 'hit') counts.hits++
          else if (result.outcome === 'miss') counts.compiled++
          else counts.skipped++
        }
      } catch (error) {
        counts.failures++
        failureId = row.id
        errorCode = error instanceof ApiError ? error.code : 'COMPILE_ITEM_FAILED'
      }
      cursor = row.id
    }
  } catch {
    errorCode = 'COMPILE_PAGE_FAILED'
    pageFailed = true
  }

  await db.prepare(`UPDATE compile_jobs SET cursor=?, compiled=compiled+?, cache_hits=cache_hits+?,
    skipped=skipped+?, failures=failures+?, last_failure_id=coalesce(?,last_failure_id), error_code=coalesce(?,error_code),
    run_ms=run_ms+?, status=CASE WHEN ? THEN 'failed' WHEN ? THEN 'running'
      WHEN failures+? > 0 THEN 'failed' ELSE 'completed' END, lease=NULL, lease_until=NULL, updated_at=?
    WHERE id=? AND lease=? AND status='running'`).bind(cursor, counts.compiled, counts.hits, counts.skipped,
      counts.failures, failureId, errorCode, Date.now() - started, pageFailed ? 1 : 0, more ? 1 : 0,
      counts.failures, new Date().toISOString(), id, lease).run()
  return getJob(db, id)
}

async function runBatchPage(env: DataEnv, job: Job, lease: string, started: number) {
  const db = env.DB
  let pageFailed = false
  try {
    const operation = JSON.parse(job.operation_json!) as Operation
    const page = await db.prepare(`SELECT subscription_id AS id, reviewed_state FROM compile_job_items
      WHERE job_id=? AND outcome IS NULL ORDER BY subscription_id LIMIT ?`)
      .bind(job.id, pageSize).all<{ id: string; reviewed_state: string | null }>()
    for (const item of page.results) {
      if (!await db.prepare("SELECT 1 FROM compile_jobs WHERE id=? AND lease=? AND status='running'")
        .bind(job.id, lease).first()) break
      await runBatchItem(env, { id: job.id, lease, actor: job.actor_user_id }, item, operation)
    }
  } catch {
    pageFailed = true
  }
  await db.prepare(`WITH items AS (
      SELECT count(*) FILTER (WHERE outcome='applied') AS applied,
        count(*) FILTER (WHERE outcome='failed') AS failed,
        count(*) FILTER (WHERE outcome IS NULL) AS remaining,
        coalesce(max(subscription_id) FILTER (WHERE outcome IS NOT NULL), '') AS cursor
      FROM compile_job_items WHERE job_id=?
    ), last_error AS (
      SELECT subscription_id, error_code FROM compile_job_items
      WHERE job_id=? AND outcome='failed' ORDER BY subscription_id DESC LIMIT 1
    )
    UPDATE compile_jobs SET compiled=items.applied, failures=items.failed, cursor=items.cursor,
      last_failure_id=(SELECT subscription_id FROM last_error),
      error_code=CASE WHEN ? THEN 'SUBSCRIPTION_BATCH_PAGE_FAILED' ELSE (SELECT error_code FROM last_error) END,
      status=CASE WHEN status='cancelled' THEN status WHEN ? THEN 'failed'
        WHEN items.remaining>0 THEN 'running' WHEN items.failed>0 THEN 'failed' ELSE 'completed' END,
      run_ms=run_ms+?, lease=NULL, lease_until=NULL, updated_at=?
    FROM items WHERE id=? AND (lease=? OR status='cancelled')`)
    .bind(job.id, job.id, Number(pageFailed), Number(pageFailed), Date.now() - started, new Date().toISOString(), job.id, lease).run()
  return getJob(db, job.id)
}

export const compileJobRoutes = new Hono<AppEnv>()
compileJobRoutes.get('/', async c => c.json({ jobs: (await c.env.DB.prepare(
  `SELECT ${jobFields} FROM compile_jobs WHERE (?=0 OR operation_json IS NOT NULL)
   ORDER BY created_at DESC, id DESC LIMIT 50`,
).bind(Date.now(), Number(c.req.query('kind') === 'subscription-batch')).all()).results }))
compileJobRoutes.post('/', async c => c.json({ job: await createJob(
  c.env, await readJson(c, scopeSchema), c.get('principal').id,
) }, 201))
compileJobRoutes.get('/batch/capabilities', async c => c.json({ unified: await unifiedOperationsEnabled(c.env.DB) }))
compileJobRoutes.post('/batch/preview', async c => c.json((await reviewBatch(
  c.env, await readJson(c, batchInput), c.get('principal').id,
)).preview))
compileJobRoutes.post('/batch', async c => {
  const { previewId, fingerprint, ...input } = await readJson(c, batchConfirmation)
  const actor = c.get('principal').id
  const db = c.env.DB
  const id = `batch-${await sha256Base64Url(JSON.stringify([actor, previewId, fingerprint]))}`
  const exists = () => db.prepare('SELECT 1 FROM compile_jobs WHERE id=?').bind(id).first()
  if (await exists()) return c.json({ job: await getJob(db, id) })
  const reviewed = await reviewBatch(c.env, input, actor, previewId)
  if (reviewed.preview.fingerprint !== fingerprint) throw apiError(409, 'BATCH_PREVIEW_STALE', '预览已过期，请重新预览')
  try {
    await enqueueBatch(db, actor, id, reviewed)
  } catch (error) {
    if (!await exists()) throw error
  }
  return c.json({ job: await getJob(db, id) }, 201)
})
compileJobRoutes.get('/:id/items', async c => {
  const id = c.req.param('id')
  await getJob(c.env.DB, id)
  const { results } = await c.env.DB.prepare(`SELECT subscription_id AS id,outcome,error_code AS errorCode,copy_id AS copyId
    FROM compile_job_items WHERE job_id=? AND EXISTS (SELECT 1 FROM compile_jobs WHERE id=? AND operation_json IS NOT NULL)
    ORDER BY subscription_id`).bind(id,id).all()
  return c.json({ items: results })
})
compileJobRoutes.get('/artifacts/:subscriptionId/:platform', async c => {
  const platform = scopeSchema.shape.platform.safeParse(c.req.param('platform'))
  if (!platform.success) throw apiError(404, 'SUBSCRIPTION_CLIENT_NOT_FOUND', '订阅格式不存在')
  const subscription = await readDeliverySubscription(c.env.DB, { id: c.req.param('subscriptionId') })
  if (!subscription) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  const state = await inspectSubscriptionArtifact(c.env, subscription, platform.data, new Date().toISOString())
  return c.json({ status: state.outcome === 'hit' ? 'current' : state.outcome === 'miss' ? 'needsCompilation' : 'blocked' })
})
compileJobRoutes.get('/:id', async c => c.json({ job: await getJob(c.env.DB, c.req.param('id')) }))
compileJobRoutes.post('/:id/run', async c => c.json({ job: await runPage(c.env, c.req.param('id')) }))
compileJobRoutes.post('/:id/cancel', async c => {
  const id = c.req.param('id')
  const result = await c.env.DB.prepare(`UPDATE compile_jobs SET status='cancelled', lease=NULL, lease_until=NULL, updated_at=?,
      compiled=CASE WHEN operation_json IS NULL THEN compiled ELSE (
        SELECT count(*) FROM compile_job_items WHERE job_id=? AND outcome='applied') END,
      failures=CASE WHEN operation_json IS NULL THEN failures ELSE (
        SELECT count(*) FROM compile_job_items WHERE job_id=? AND outcome='failed') END
    WHERE id=? AND status IN ('queued','running')`).bind(new Date().toISOString(), id, id, id).run()
  const job = await getJob(c.env.DB, id)
  if (!result.meta.changes && job.status !== 'cancelled') throw apiError(409, 'COMPILE_JOB_UNAVAILABLE', '任务已结束')
  return c.json({ job })
})
compileJobRoutes.post('/:id/retry', async c => {
  const job = await getJob(c.env.DB, c.req.param('id'))
  rejectRetiredAction(job.action)
  if (!['failed', 'cancelled', 'completed'].includes(String(job.status))) {
    throw apiError(409, 'COMPILE_JOB_UNAVAILABLE', '任务尚未结束')
  }
  if (job.action) {
    const db = c.env.DB
    const row = await db.prepare('SELECT operation_json FROM compile_jobs WHERE id=?').bind(job.id).first<{ operation_json: string }>()
    const items = await db.prepare("SELECT subscription_id AS id FROM compile_job_items WHERE job_id=? AND outcome IS NOT 'applied'")
      .bind(job.id).all<{ id: string }>()
    if (!items.results.length) throw apiError(409, 'BATCH_NOTHING_TO_RETRY', '所有项目已完成')
    const operation = (JSON.parse(row!.operation_json) as Operation).input
    const input = { ids: items.results.map(item => item.id), operation }
    // Re-run uses a new preview so changed subscriptions and targets are reviewed again.
    return c.json({ input, ...(await reviewBatch(c.env, input, c.get('principal').id)).preview })
  }
  const scope = scopeSchema.parse({ platform: job.platform, planId: job.planId ?? undefined, groupId: job.groupId ?? undefined })
  return c.json({ job: await createJob(c.env, scope, c.get('principal').id) }, 201)
})
