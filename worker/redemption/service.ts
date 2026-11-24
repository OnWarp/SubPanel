import { z } from 'zod'
import { formatCode, normalizeCode } from '../../shared/redemption-code.js'
import { auditStatement } from '../admin/audit.js'
import { mutateBinding } from '../delivery/bindings.js'
import { readUserAccess, unifiedOperationsEnabled } from '../delivery/user-access.js'
import { durationSchema, entitlementConfigSchema, getRedemptionVersion } from '../delivery/entitlement-templates.js'
import { createSubscription, DeliveryError } from '../delivery/service.js'
import type { Subscription } from '../delivery/schema.js'
import type { DataEnv } from '../db/module-switch.js'
import { ApiError, apiError } from '../platform/api-error.js'
import { codeDigest, generateCode, issuePreview, matchesCodeTag, readKeyring, receiptVerifier, verifyPreview } from './credentials.js'
import { limitGeneration, recordFailure } from './limits.js'

export const batchInput = z.object({
  name: z.string().trim().min(1).max(128),
  templateVersionId: z.uuid().optional(),
  templateId: z.uuid().optional(),
  quantity: z.number().int().min(1).max(500),
  maxUses: z.number().int().min(1).max(100).default(1),
  redeemDeadline: z.number().int().positive().max(8.64e15),
  note: z.string().trim().max(1000).default(''),
  idempotencyKey: z.uuid(),
}).strict().refine(input => Boolean(input.templateId) !== Boolean(input.templateVersionId), '请选择授权模板')

export const previewInput = z.object({ code: z.string() }).strict()
export const redeemInput = previewInput.extend({
  previewProof: z.string().regex(/^\d{13}\.[A-Za-z0-9_-]{43}$/u),
  idempotencyKey: z.uuid(),
}).strict()

type RedemptionEnv = DataEnv & { REDEMPTION_HMAC_KEYS?: string }
type Candidate = {
  id: string
  batch_id: string
  digest_key_version: string
  code_digest: string
  template_version_id: string
  template_name: string
  template_id: string | null
  duration_json: string | null
  available: number
}

const codeAvailable = `c.revoked = 0 AND c.used_count < c.max_uses AND b.enabled = 1
  AND b.redeem_deadline > unixepoch('subsec') * 1000`
const invalidCode = () => apiError(422, 'REDEMPTION_CODE_UNAVAILABLE', '兑换码不可用，请检查后重试')

export async function createBatch(env: RedemptionEnv, actor: string, input: z.infer<typeof batchInput>) {
  const { DB: db } = env
  if (input.redeemDeadline <= Date.now()) throw apiError(422, 'REDEMPTION_DEADLINE_INVALID', '兑换截止时间必须晚于现在')
  await limitGeneration(db, actor)
  const { active, keys } = await readKeyring(env.REDEMPTION_HMAC_KEYS)
  const key = keys.get(active)!
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const unified = await unifiedOperationsEnabled(db)
  if (input.templateId && !unified) throw apiError(409, 'REDEMPTION_TEMPLATE_UNAVAILABLE', '请选择可发放的模板版本')
  const versionId = input.templateVersionId ?? await db.prepare(`SELECT id FROM entitlement_template_versions
    WHERE template_id=? ORDER BY version_no DESC LIMIT 1`).bind(input.templateId).first<string>('id')
  if (!versionId) throw apiError(409, 'REDEMPTION_TEMPLATE_UNAVAILABLE', '请选择启用且允许兑换发放的模板')
  const codes = new Set<string>()
  const statements = [db.prepare(`INSERT INTO redemption_batches
    (id, name, template_version_id, template_name, quantity, max_uses, redeem_deadline, note, created_by, created_at, request_key, template_id, duration_json)
    SELECT ?, ?, ?, (SELECT t.name FROM entitlement_templates t JOIN entitlement_template_versions v ON v.template_id=t.id
      WHERE v.id=? AND t.status='enabled' AND t.allow_redemption=1
        AND (NOT ? OR v.version_no=(SELECT max(version_no) FROM entitlement_template_versions WHERE template_id=t.id))
        AND NOT EXISTS (SELECT 1 FROM json_each(v.config_json, '$.groupIds') g
          WHERE NOT EXISTS (SELECT 1 FROM groups WHERE id=g.value))
        AND NOT EXISTS (SELECT 1 FROM json_each(v.config_json, '$.nodeIds') n
          WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE id=n.value AND enabled=1))),
      ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? THEN (SELECT template_id FROM entitlement_template_versions WHERE id=?) END,
      CASE WHEN ? THEN (SELECT json_extract(config_json,'$.duration') FROM entitlement_template_versions WHERE id=?) END`).bind(id, input.name, versionId, versionId, Number(unified),
    input.quantity, input.maxUses, input.redeemDeadline, input.note, actor, now, input.idempotencyKey,
    Number(unified), versionId, Number(unified), versionId)]

  for (let offset = 0; offset < input.quantity; offset += 50) {
    const persisted = await Promise.all(Array.from({ length: Math.min(50, input.quantity - offset) }, async () => {
      let canonical = await generateCode(key)
      while (codes.has(canonical)) canonical = await generateCode(key)
      codes.add(canonical)
      return [crypto.randomUUID(), await codeDigest(key, canonical), canonical.slice(-4)]
    }))
    statements.push(db.prepare(`INSERT INTO redemption_codes (id, batch_id, digest_key_version, code_digest, tail, max_uses)
      SELECT json_extract(value, '$[0]'), ?, ?, json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?
      FROM json_each(?)`).bind(id, active, input.maxUses, JSON.stringify(persisted)))
  }

  statements.push(
    auditStatement(db, actor, 'redemption.batch.create', 'redemption_batches', id, { quantity: input.quantity }, now),
    auditStatement(db, actor, 'redemption.batch.release', 'redemption_batches', id, { quantity: input.quantity }, now),
  )
  try {
    await db.batch(statements)
  } catch (error) {
    if (error instanceof Error && error.message.includes('redemption_batches.template_name')) {
      throw apiError(409, 'REDEMPTION_TEMPLATE_UNAVAILABLE', '请选择启用且允许兑换发放的模板版本')
    }
    if (error instanceof Error && error.message.includes('redemption_batches.created_by, redemption_batches.request_key')) {
      throw apiError(409, 'REDEMPTION_BATCH_ALREADY_CREATED', '此请求已生成批次，完整兑换码仅在首次响应中提供')
    }
    throw error
  }
  return { id, codes: [...codes].map(formatCode) }
}

async function normalizeOrReject(db: D1Database, code: string) {
  const normalized = normalizeCode(code)
  if (!normalized) {
    await recordFailure(db)
    throw invalidCode()
  }
  return normalized
}

async function findCandidate(env: RedemptionEnv, normalized: string, user: string) {
  const { keys } = await readKeyring(env.REDEMPTION_HMAC_KEYS)
  const digests = await Promise.all([...keys].map(async ([version, key]) => [version, await codeDigest(key, normalized)]))
  const matches = digests.map(() => '(c.digest_key_version=? AND c.code_digest=?)').join(' OR ')
  const code = await env.DB.prepare(`SELECT c.id, c.batch_id, c.digest_key_version, c.code_digest,
    b.template_version_id, b.template_name, b.template_id, b.duration_json, (${codeAvailable} AND NOT EXISTS (
      SELECT 1 FROM all_redemption_records WHERE code_id=c.id AND user_id=?
    )) AS available
    FROM redemption_codes c JOIN redemption_batches b ON b.id=c.batch_id WHERE ${matches}`)
    .bind(user, ...digests.flat()).first<Candidate>()
  const key = code && keys.get(code.digest_key_version)
  if (!code || !key || !await matchesCodeTag(key, normalized)) {
    await recordFailure(env.DB)
    throw invalidCode()
  }
  return { code, key }
}

export async function previewRedemption(env: RedemptionEnv, user: string, input: z.infer<typeof previewInput>) {
  const { code, key } = await findCandidate(env, await normalizeOrReject(env.DB, input.code), user)
  if (!code.available) {
    await recordFailure(env.DB)
    throw invalidCode()
  }
  const { name, config } = code.template_id
    ? await currentRedemptionTemplate(env, user, code.template_id)
    : await getRedemptionVersion(env.DB, code.template_version_id, code.template_name)
  return {
    name,
    duration: code.duration_json ? durationSchema.parse(JSON.parse(code.duration_json)) : config.duration,
    quotaBytes: config.quotaBytes,
    nodePolicy: config.groupIds.length ? config.nodeIds.length ? 'mixed' : 'groups' : 'nodes',
    previewProof: await issuePreview(key, user, code.code_digest),
  }
}

const receiptSelect = `coalesce(issued_subscription_id,id) AS id, subscription_name AS name, expires_at AS expiresAt`
type Receipt = { id: string; name: string; expiresAt: number | null; codeId: string; verifier: string; templateId?: string }

function readReceipt(db: D1Database, user: string, requestKey: string) {
  return db.prepare(`SELECT ${receiptSelect}, code_id AS codeId, replay_verifier AS verifier, CASE WHEN issued_subscription_id IS NULL THEN template_id END AS templateId
    FROM all_redemption_records WHERE user_id=? AND idempotency_key=?`).bind(user, requestKey).first<Receipt>()
}

function receiptDto({ id, name, expiresAt, templateId }: Receipt) {
  return { id, name, expiresAt, ...(templateId ? { templateId } : {}) }
}

function replay(row: Receipt | null, code: Candidate) {
  if (!row) return null
  if (row.codeId !== code.id) throw apiError(409, 'REDEMPTION_IDEMPOTENCY_CONFLICT', '此请求已用于其他兑换，请重新预览')
  return receiptDto(row)
}

function redemptionStatements(db: D1Database, code: Candidate, user: string, requestKey: string, verifier: string, subscription: Subscription) {
  const { id, name, expiresAt, createdAt } = subscription
  const recordId = crypto.randomUUID()
  return [
    db.prepare(`UPDATE redemption_codes AS c SET used_count=used_count+1 WHERE c.id=?
      AND EXISTS (SELECT 1 FROM redemption_batches b WHERE b.id=c.batch_id AND ${codeAvailable})
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM all_redemption_records WHERE code_id=c.id AND user_id=?)
      AND NOT EXISTS (SELECT 1 FROM all_redemption_records WHERE user_id=? AND idempotency_key=?)`).bind(code.id, user, user, user, requestKey),
    // Read the immediately preceding UPDATE's affected rows inside the transaction.
    // A zero-row claim must fail a constraint rather than commit unrelated writes.
    db.prepare(`INSERT INTO redemption_records
      (id, code_id, user_id, subscription_id, issued_subscription_id, subscription_name, expires_at, redeemed_at, idempotency_key, replay_verifier)
      VALUES (?, CASE WHEN changes()=1 THEN ? END, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(recordId, code.id, user, id, id, name, expiresAt, createdAt, requestKey, verifier),
    auditStatement(db, user, 'redemption.confirm', 'redemption_batches', code.batch_id,
      { recordId, codeId: code.id, subscriptionId: id }, createdAt),
  ]
}

export async function confirmRedemption(env: RedemptionEnv, user: string, input: z.infer<typeof redeemInput>) {
  const normalized = await normalizeOrReject(env.DB, input.code)
  const previous = () => readReceipt(env.DB, user, input.idempotencyKey)
  const [original, verifier] = await Promise.all([previous(), receiptVerifier(normalized, input.previewProof)])
  if (original && await verifier.matches(original.verifier)) return receiptDto(original)
  const { code, key } = await findCandidate(env, normalized, user)
  const existing = replay(original, code)
  if (existing) return existing
  if (!code.available || !await verifyPreview(key, user, code.code_digest, input.previewProof)) {
    await recordFailure(env.DB)
    throw invalidCode()
  }

  const digest = await verifier.sign()
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (code.template_id) {
        return await redeemBinding(env, user, input.idempotencyKey, digest, code)
      }
      const { subscription } = await createSubscription(env, { userId: user, templateVersionId: code.template_version_id }, {
        actorUserId: user,
        redemption: {
          templateName: code.template_name,
          statements: (subscription) => redemptionStatements(env.DB, code, user, input.idempotencyKey, digest, subscription),
        },
      })
      return { id: subscription.id, name: subscription.name, expiresAt: subscription.expiresAt }
    } catch (error) {
      const concurrent = replay(await previous(), code)
      if (concurrent) return concurrent
      if (error instanceof ApiError && ['SUBSCRIPTION_CONFLICT', 'BINDING_CONFLICT'].includes(error.code) && attempt < 7) {
        const current = await findCandidate(env, normalized, user)
        if (current.code.available) continue
        await recordFailure(env.DB)
        throw invalidCode()
      }
      if (error instanceof Error && /NOT NULL constraint failed: (binding_)?redemption_records\.code_id/.test(error.message)) {
        await recordFailure(env.DB)
        throw invalidCode()
      }
      if ((error instanceof DeliveryError && ['GROUP_NOT_FOUND', 'USER_NOT_FOUND'].includes(error.code))
        || (error instanceof ApiError && ['SUBSCRIPTION_NODE_UNAVAILABLE', 'SUBSCRIPTION_REFERENCE_CHANGED'].includes(error.code))) {
        throw apiError(409, 'REDEMPTION_ENTITLEMENT_UNAVAILABLE', '暂时无法发放订阅，请联系管理员')
      }
      throw error
    }
  }
}

async function currentRedemptionTemplate(env: RedemptionEnv, user: string, templateId: string) {
  if (!await unifiedOperationsEnabled(env.DB)) throw invalidCode()
  const row = await env.DB.prepare(`SELECT t.name,v.config_json FROM entitlement_templates t
    JOIN entitlement_template_versions v ON v.template_id=t.id
    WHERE t.id=? AND t.status='enabled' AND t.allow_redemption=1 AND v.schema_version=1
      AND NOT EXISTS (SELECT 1 FROM user_template_bindings WHERE user_id=? AND template_id=t.id AND status<>'active')
    ORDER BY v.version_no DESC LIMIT 1`).bind(templateId, user).first<{ name: string; config_json: string }>()
  if (!row) throw invalidCode()
  return { name: row.name, config: entitlementConfigSchema.parse(JSON.parse(row.config_json)) }
}

async function redeemBinding(env: RedemptionEnv, user: string, requestKey: string, verifier: string, code: Candidate) {
  const db = env.DB
  const templateId = code.template_id!
  const access = await readUserAccess(db, { userId: user })
  const { name } = await currentRedemptionTemplate(env, user, templateId)
  const duration = durationSchema.parse(JSON.parse(code.duration_json!))
  const id = crypto.randomUUID()
  await mutateBinding(env, user, templateId, {
    mode: 'redeem', expectedRevision: access?.revision ?? 0, requestId: `redeem:${id}`,
    expiry: { type: 'duration', duration },
  }, user, Date.now(), ([change], timestamp) => [
    db.prepare(`UPDATE redemption_codes AS c SET used_count=used_count+1 WHERE c.id=?
      AND EXISTS (SELECT 1 FROM redemption_batches b JOIN entitlement_templates t ON t.id=b.template_id
        WHERE b.id=c.batch_id AND t.id=? AND t.status='enabled' AND t.allow_redemption=1 AND ${codeAvailable})
      AND NOT EXISTS (SELECT 1 FROM all_redemption_records WHERE code_id=c.id AND user_id=?)
      AND NOT EXISTS (SELECT 1 FROM all_redemption_records WHERE user_id=? AND idempotency_key=?)
      AND (SELECT count(*) FROM system_settings WHERE key IN ('unified_subscription_ready','unified_subscription_public_ready')
        AND value='true')=2`).bind(code.id, templateId, user, user, requestKey),
    db.prepare(`INSERT INTO binding_redemption_records
      (id,code_id,user_id,template_id,subscription_name,previous_expires_at,expires_at,redeemed_at,idempotency_key,replay_verifier)
      VALUES (?,CASE WHEN changes()=1 THEN ? END,?,?,?,?,?,?,?,?)`)
      .bind(id, code.id, user, templateId, name, change.before?.expires_at ?? null,
        change.after.expires_at, timestamp, requestKey, verifier),
    auditStatement(db, user, 'redemption.confirm', 'redemption_batches', code.batch_id,
      { recordId: id, requestId: requestKey, userId: user, templateId, ...change }, timestamp),
  ])
  const receipt = await readReceipt(db, user, requestKey)
  if (receipt) return replay(receipt, code)!
  throw apiError(409, 'REDEMPTION_RECEIPT_UNAVAILABLE', '兑换回执暂不可用')
}
