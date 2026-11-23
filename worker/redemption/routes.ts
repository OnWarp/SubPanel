import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { ApiError, apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { limitAttempts } from './limits.js'
import { batchInput, confirmRedemption, createBatch, previewInput, previewRedemption, redeemInput } from './service.js'

export const adminRedemptionRoutes = new Hono<AppEnv>()
export const userRedemptionRoutes = new Hono<AppEnv>()

const sizeLimit = bodyLimit({
  maxSize: 4096,
  onError: () => { throw apiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过长') },
})
adminRedemptionRoutes.use('/redemption-batches', sizeLimit)
userRedemptionRoutes.use('*', sizeLimit)

async function readRedemptionJson<S extends z.ZodType>(c: Context<AppEnv>, schema: S) {
  try {
    return await readJson(c, schema)
  } catch (error) {
    // A sender can put a credential in an unexpected JSON field name.
    if (error instanceof ApiError) throw apiError(error.status, error.code, error.message)
    throw error
  }
}

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['active', 'disabled', 'expired']).optional(),
  batchId: z.uuid().optional(),
  userId: z.string().trim().min(1).max(100).optional(),
  q: z.string().trim().max(100).default(''),
})
function query(c: Context<AppEnv>) {
  const parsed = listQuery.safeParse(c.req.query())
  if (!parsed.success) throw apiError(422, 'VALIDATION_FAILED', '列表查询参数无效')
  return parsed.data
}

async function paginate(db: D1Database, page: number, pageSize: number, sql: string, fields: string,
  order: string, bindings: string[]) {
  const [rows, count] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${fields} ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...bindings, pageSize, (page - 1) * pageSize),
    db.prepare(`SELECT count(*) AS total ${sql}`).bind(...bindings),
  ])
  return { items: rows.results, total: Number(count.results[0]?.total ?? 0), page, pageSize }
}

const batchStatus = `CASE WHEN b.enabled=0 THEN 'disabled'
  WHEN b.redeem_deadline <= unixepoch('subsec') * 1000 THEN 'expired' ELSE 'active' END`
const batchFields = `b.id, b.name, b.template_name AS templateName, b.template_version_id AS templateVersionId,
  (SELECT version_no FROM entitlement_template_versions WHERE id=b.template_version_id) AS templateVersion,
  b.quantity, b.max_uses AS maxUses, b.redeem_deadline AS redeemDeadline, ${batchStatus} AS status,
  b.note, b.created_by AS createdBy, b.created_at AS createdAt,
  coalesce((SELECT sum(used_count) FROM redemption_codes WHERE batch_id=b.id),0) AS usedCount,
  CASE WHEN (${batchStatus})='active' THEN coalesce((
    SELECT sum(max_uses-used_count) FROM redemption_codes WHERE batch_id=b.id AND revoked=0
  ),0) ELSE 0 END AS remaining`
const recordFields = `r.id, r.issued_subscription_id AS subscriptionId, r.subscription_name AS subscriptionName,
  r.expires_at AS expiresAt, r.redeemed_at AS redeemedAt`

adminRedemptionRoutes.get('/redemption-batches', async (c) => {
  const { page, pageSize, status, q } = query(c)
  return c.json(await paginate(c.env.DB, page, pageSize, `FROM redemption_batches b WHERE
    (?='' OR instr(b.name,?)>0) AND (?='' OR (${batchStatus})=?)`, batchFields,
  'b.created_at DESC, b.id DESC', [q, q, status ?? '', status ?? '']))
})

adminRedemptionRoutes.post('/redemption-batches', async (c) =>
  c.json(await createBatch(c.env, c.get('principal').id, await readRedemptionJson(c, batchInput)), 201))

adminRedemptionRoutes.get('/redemption-batches/:id', async (c) => {
  const batch = await c.env.DB.prepare(`SELECT ${batchFields} FROM redemption_batches b WHERE id=?`).bind(c.req.param('id')).first()
  if (!batch) throw apiError(404, 'REDEMPTION_BATCH_NOT_FOUND', '兑换批次不存在')
  return c.json({ batch })
})

adminRedemptionRoutes.get('/redemption-batches/:id/codes', async (c) => {
  const { page, pageSize } = query(c)
  return c.json(await paginate(c.env.DB, page, pageSize,
    'FROM redemption_codes c WHERE c.batch_id=?',
    'c.id, c.tail, c.revoked, c.used_count AS usedCount, c.max_uses AS maxUses', 'c.id', [c.req.param('id')]))
})

adminRedemptionRoutes.get('/redemption-batches/:id/audit', async (c) => {
  const { page, pageSize } = query(c)
  return c.json(await paginate(c.env.DB, page, pageSize,
    "FROM audit_logs WHERE target_type='redemption_batches' AND target_id=?",
    'id, actor_user_id AS actor, action, detail, created_at AS createdAt', 'created_at DESC, id DESC', [c.req.param('id')]))
})

adminRedemptionRoutes.get('/redemption-records', async (c) => {
  const { page, pageSize, batchId, userId } = query(c)
  const filters = []
  const params = []
  if (batchId) { filters.push('c.batch_id=?'); params.push(batchId) }
  if (userId) { filters.push('r.user_id=?'); params.push(userId) }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  return c.json(await paginate(c.env.DB, page, pageSize, `FROM redemption_records r
    JOIN redemption_codes c ON c.id=r.code_id JOIN redemption_batches b ON b.id=c.batch_id ${where}`,
  `${recordFields}, r.user_id AS userId, b.name AS batchName, c.tail`, 'r.redeemed_at DESC, r.id DESC', params))
})

adminRedemptionRoutes.post('/redemption-batches/:id/disable', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const update = db.prepare('UPDATE redemption_batches SET enabled=0 WHERE id=? AND enabled=1').bind(id)
  await auditedChange(db, update, c.get('principal').id, 'redemption.batch.disable', id)
  if (!await db.prepare('SELECT id FROM redemption_batches WHERE id=?').bind(id).first()) {
    throw apiError(404, 'REDEMPTION_BATCH_NOT_FOUND', '兑换批次不存在')
  }
  return c.json({ ok: true })
})

adminRedemptionRoutes.post('/redemption-codes/:id/revoke', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const batchId = await db.prepare('SELECT batch_id FROM redemption_codes WHERE id=?').bind(id).first<string>('batch_id')
  if (!batchId) throw apiError(404, 'REDEMPTION_CODE_NOT_FOUND', '兑换码不存在')
  const update = db.prepare('UPDATE redemption_codes SET revoked=1 WHERE id=? AND revoked=0').bind(id)
  await auditedChange(db, update, c.get('principal').id, 'redemption.code.revoke', batchId, { codeId: id })
  return c.json({ ok: true })
})

async function auditedChange(db: D1Database, update: D1PreparedStatement, actor: string, action: string,
  batchId: string, detail = {}) {
  await db.batch([update, db.prepare(`INSERT INTO audit_logs
    (id,actor_user_id,action,target_type,target_id,detail,created_at)
    SELECT ?, ?, ?, 'redemption_batches', ?, ?, ? WHERE changes()=1`)
    .bind(crypto.randomUUID(), actor, action, batchId, JSON.stringify(detail), new Date().toISOString())])
}

userRedemptionRoutes.get('/', async (c) => {
  const { page, pageSize } = query(c)
  return c.json(await paginate(c.env.DB, page, pageSize,
    'FROM redemption_records r LEFT JOIN subscriptions s ON s.id=r.subscription_id AND s.user_id=r.user_id WHERE r.user_id=?', `${recordFields}, s.id IS NOT NULL AS hasSubscription`,
    'r.redeemed_at DESC, r.id DESC', [c.get('principal').id]))
})

userRedemptionRoutes.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const { id, sessionVersion } = c.get('principal')
    await limitAttempts(c.env.DB, id, c.req.header('CF-Connecting-IP'), sessionVersion)
  }
  await next()
})

userRedemptionRoutes.post('/preview', async (c) =>
  c.json({ preview: await previewRedemption(c.env, c.get('principal').id, await readRedemptionJson(c, previewInput)) }))

userRedemptionRoutes.post('/', async (c) =>
  c.json({ subscription: await confirmRedemption(c.env, c.get('principal').id, await readRedemptionJson(c, redeemInput)) }))
