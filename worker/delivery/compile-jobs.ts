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
  id: string; platform: RenderClient; plan_id: string | null; group_id: string | null;
  cursor: string; status: string; lease: string | null; lease_until: number | null;
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

const jobFields = `id, platform, plan_id AS planId, group_id AS groupId, status, total,
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

async function runPage(env: DataEnv, id: string) {
  const db = env.DB
  const started = Date.now()
  const lease = crypto.randomUUID()
  const job = await db.prepare(`UPDATE compile_jobs SET lease=?, lease_until=?, status='running', updated_at=?
    WHERE id=? AND status IN ('queued','running') AND (lease_until IS NULL OR lease_until <= ?)
    RETURNING *`).bind(lease, started + leaseMs, new Date(started).toISOString(), id, started).first<Job>()
  if (!job) {
    await getJob(db, id)
    throw apiError(409, 'COMPILE_JOB_UNAVAILABLE', '任务正在执行或已结束')
  }

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

export const compileJobRoutes = new Hono<AppEnv>()
compileJobRoutes.get('/', async c => c.json({ jobs: (await c.env.DB.prepare(
  `SELECT ${jobFields} FROM compile_jobs ORDER BY created_at DESC, id DESC LIMIT 50`,
).bind(Date.now()).all()).results }))
compileJobRoutes.post('/', async c => c.json({ job: await createJob(
  c.env, await readJson(c, scopeSchema), c.get('principal').id,
) }, 201))
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
  const result = await c.env.DB.prepare(`UPDATE compile_jobs SET status='cancelled', lease=NULL, lease_until=NULL, updated_at=?
    WHERE id=? AND status IN ('queued','running')`).bind(new Date().toISOString(), id).run()
  const job = await getJob(c.env.DB, id)
  if (!result.meta.changes && job.status !== 'cancelled') throw apiError(409, 'COMPILE_JOB_UNAVAILABLE', '任务已结束')
  return c.json({ job })
})
compileJobRoutes.post('/:id/retry', async c => {
  const job = await getJob(c.env.DB, c.req.param('id'))
  if (!['failed', 'cancelled', 'completed'].includes(String(job.status))) {
    throw apiError(409, 'COMPILE_JOB_UNAVAILABLE', '任务尚未结束')
  }
  const scope = scopeSchema.parse({ platform: job.platform, planId: job.planId ?? undefined, groupId: job.groupId ?? undefined })
  return c.json({ job: await createJob(c.env, scope, c.get('principal').id) }, 201)
})
