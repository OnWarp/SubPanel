import { unifiedOperationsEnabled } from './user-access.js'
import { sha256Base64Url } from '../platform/hash.js'
import { batchConfirmation, batchInput, enqueueBatch, reviewBatch, runBatchItem, type Operation } from './subscription-batch.js'
import { Hono } from 'hono'
import type { AppEnv } from '../app-env.js'
import { type DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { type RenderClient } from '../renderers/index.js'

type Job = {
  id: string; actor_user_id: string; platform: RenderClient; plan_id: string | null; group_id: string | null;
  operation_json: string | null; cursor: string; status: string; lease: string | null; lease_until: number | null;
}
const pageSize = 4
const leaseMs = 120_000

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

function rejectRetiredAction(action: unknown) {
  if (action === 'copy' || action === 'transfer') throw apiError(410, 'SUBSCRIPTION_BATCH_ACTION_REMOVED', '订阅批量操作已移除')
}

async function runPage(env: DataEnv, id: string) {
  const db = env.DB
  const started = Date.now()
  const lease = crypto.randomUUID()
  const job = await db.prepare(`UPDATE compile_jobs SET lease=?, lease_until=?, status='running', updated_at=?
    WHERE id=? AND status IN ('queued','running')
      AND json_type(operation_json, '$.input.templateId')='text'
      AND coalesce(json_extract(operation_json,'$.input.action'),'') NOT IN ('copy','transfer') AND (lease_until IS NULL OR lease_until <= ?)
    RETURNING *`).bind(lease, started + leaseMs, new Date(started).toISOString(), id, started).first<Job>()
  if (!job) {
    const existing = await getJob(db, id)
    rejectRetiredAction(existing.action)
    throw apiError(409, 'COMPILE_JOB_UNAVAILABLE', '任务正在执行或已结束')
  }

  return runBatchPage(env, job, lease, started)
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
  throw apiError(410, 'COMPILE_JOB_RETIRED', '旧编译任务已停用')
})
