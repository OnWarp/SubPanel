import { z } from 'zod'
import { formatCode, normalizeCode } from '../../shared/redemption-code.js'
import { auditStatement } from '../admin/audit.js'
import type { DataEnv } from '../db/module-switch.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { apiError } from '../platform/api-error.js'
import { instanceDisplayStatus, planUserEnabled, readPlanUser, type PlanInstance } from './entitlements.js'
import { codeDigest, generateCode, matchesCodeTag, readKeyring } from '../redemption/credentials.js'
import { limitPlanCodeGeneration, limitPlanRedeem, planRedeemLimits, recordPlanRedeemFailure } from './redeem-limits.js'
import { redeemCodes, type RedeemCodeRow, type RedemptionRow, type SubscriptionTokenRow, type UserPlanRow } from './repository.js'
import { revealPlanToken } from './tokens.js'
import {
  checkWindow, commit, conflict, durationEnd, invalidDuration, notAssignable, planBatchAborted,
  prepareInstanceGrant, requireInBatch,
} from './service.js'

type RedeemEnv = DataEnv & { REDEMPTION_HMAC_KEYS?: string }
const remark = z.string().max(2000).nullable()
const instant = z.number().int()

export const generateRedeemInput = z.object({
  planId: z.string().min(1).max(512),
  quantity: z.number().int().min(1).max(planRedeemLimits.quantity).default(1),
  maxUses: z.number().int().min(1).max(1000).default(1),
  perUserLimit: z.number().int().min(1).max(1000).default(1),
  durationMode: z.enum(['snapshot', 'inherit', 'fixed', 'permanent']).default('snapshot'),
  durationSeconds: z.number().int().positive().optional(),
  validFrom: instant.nullable().optional(),
  validUntil: instant.nullable().optional(),
  remark: remark.optional(),
}).strict().superRefine((input, context) => {
  if (input.durationMode === 'fixed' && input.durationSeconds === undefined) {
    context.addIssue({ code: 'custom', path: ['durationSeconds'], message: '固定时长需要秒数' })
  }
  if (input.durationMode !== 'fixed' && input.durationSeconds !== undefined) {
    context.addIssue({ code: 'custom', path: ['durationSeconds'], message: '仅固定时长接受秒数' })
  }
})

export const updateRedeemInput = z.object({
  enabled: z.boolean().optional(),
  remark: remark.optional(),
}).strict().refine(input => input.enabled !== undefined || input.remark !== undefined)

export type GeneratedCode = { id: string; code: string; tail: string }
export type MaskedCode = {
  id: string
  masked: string
  tail: string
  planId: string
  durationMode: RedeemCodeRow['duration_mode']
  durationSeconds: number | null
  validFrom: number | null
  validUntil: number | null
  maxUses: number
  usedCount: number
  perUserLimit: number
  enabled: boolean
  remark: string | null
  batchId: string | null
}

const codeInvalid = () => apiError(422, 'CODE_INVALID', '兑换码不可用')
const codeExhausted = () => apiError(409, 'CODE_EXHAUSTED', '兑换次数已用完')
const codeUserLimit = () => apiError(409, 'CODE_USER_LIMIT', '已达到个人兑换次数')
const idempotencyConflict = () => apiError(409, 'CONFLICT', '此请求已用于其他兑换')

export function maskRedeemCode(row: RedeemCodeRow): MaskedCode {
  return {
    id: row.id, masked: `••••${row.tail}`, tail: row.tail, planId: row.plan_id,
    durationMode: row.duration_mode, durationSeconds: row.duration_seconds,
    validFrom: row.valid_from, validUntil: row.valid_until, maxUses: row.max_uses, usedCount: row.used_count,
    perUserLimit: row.per_user_limit, enabled: row.enabled === 1, remark: row.remark, batchId: row.batch_id,
  }
}

function codeWindow(from: number | null, until: number | null, now: number) {
  checkWindow(now, null)
  if (from !== null) checkWindow(0, from + 1)
  if (until !== null && from !== null && until <= from) throw invalidDuration()
  if (until !== null && until <= now) throw invalidDuration()
}

function grantExpiry(code: RedeemCodeRow, planSeconds: number | null, now: number) {
  if (code.duration_mode === 'permanent') return null
  if (code.duration_mode === 'fixed') {
    if (code.duration_seconds === null) throw invalidDuration()
    return durationEnd(now, code.duration_seconds)
  }
  return planSeconds === null ? null : durationEnd(now, planSeconds)
}

function snapshotDuration(planSeconds: number | null, input: z.infer<typeof generateRedeemInput>) {
  if (input.durationMode === 'inherit') return { mode: 'plan_default' as const, seconds: null }
  if (input.durationMode === 'permanent') return { mode: 'permanent' as const, seconds: null }
  if (input.durationMode === 'fixed') return { mode: 'fixed' as const, seconds: input.durationSeconds! }
  return planSeconds === null
    ? { mode: 'permanent' as const, seconds: null }
    : { mode: 'fixed' as const, seconds: planSeconds }
}

export async function generateRedeemCodes(env: RedeemEnv, actor: string, input: z.infer<typeof generateRedeemInput>, now = Date.now()) {
  const { DB: db } = env
  codeWindow(input.validFrom ?? null, input.validUntil ?? null, now)
  await limitPlanCodeGeneration(db, actor)
  const plan = await db.prepare(`SELECT id, version, duration_seconds FROM plan_definitions
    WHERE id=? AND enabled=1 AND archived_at IS NULL`).bind(input.planId).first<{ id: string; version: number; duration_seconds: number | null }>()
  if (!plan) throw notAssignable()
  const duration = snapshotDuration(plan.duration_seconds, input)
  const { active, keys } = await readKeyring(env.REDEMPTION_HMAC_KEYS)
  const key = keys.get(active)!
  const batchId = crypto.randomUUID()
  const seen = new Set<string>()
  const issued: { id: string; canonical: string; tail: string; digest: string }[] = []
  for (let offset = 0; offset < input.quantity; offset += 1) {
    let canonical = await generateCode(key)
    while (seen.has(canonical)) canonical = await generateCode(key)
    seen.add(canonical)
    issued.push({ id: crypto.randomUUID(), canonical, tail: canonical.slice(-4), digest: await codeDigest(key, canonical) })
  }
  const stamp = new Date(now).toISOString()
  const statements = [
    requireInBatch(db, 'EXISTS (SELECT 1 FROM plan_definitions WHERE id=? AND version=? AND enabled=1 AND archived_at IS NULL)',
      plan.id, plan.version),
    db.prepare(`INSERT INTO redeem_codes
      (id, code_digest, digest_key_version, tail, plan_id, duration_mode, duration_seconds, valid_from, valid_until,
       max_uses, used_count, per_user_limit, enabled, remark, batch_id)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?, json_extract(value, '$[2]'),
        ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?
      FROM json_each(?)`).bind(active, input.planId, duration.mode, duration.seconds, input.validFrom ?? null,
      input.validUntil ?? null, input.maxUses, input.perUserLimit, input.remark ?? null, batchId,
      JSON.stringify(issued.map(code => [code.id, code.digest, code.tail]))),
    db.prepare(`INSERT INTO system_settings(key, value, updated_at)
      SELECT 'plan_write_conflict', NULL, '' WHERE changes() <> ?`).bind(input.quantity),
    auditStatement(db, actor, 'plan.redeem_code.create', 'redeem_code', batchId,
      { planId: input.planId, quantity: input.quantity, maxUses: input.maxUses, perUserLimit: input.perUserLimit, durationMode: duration.mode }, stamp),
  ]
  try {
    await db.batch(statements)
  } catch (error) {
    if (planBatchAborted(error)) throw notAssignable()
    if (error instanceof Error && error.message.includes('redeem_codes.digest_key_version')) {
      throw conflict()
    }
    throw error
  }
  return { batchId, codes: issued.map(code => ({ id: code.id, code: formatCode(code.canonical), tail: code.tail })) }
}

export async function listRedeemCodes(db: D1Database, page: { limit: number; offset: number; planId?: string; search?: string;
  status?: 'active' | 'disabled' | 'expired' | 'exhausted' }, now = Date.now()) {
  const planId = page.planId ?? null
  const search = page.search ? page.search : null
  const status = page.status ?? null
  const rows = await db.prepare(`SELECT c.id, c.tail, c.plan_id, c.duration_mode, c.duration_seconds, c.valid_from, c.valid_until,
    c.max_uses, c.used_count, c.per_user_limit, c.enabled, c.remark, c.batch_id, p.name AS plan_name
    FROM redeem_codes c LEFT JOIN plan_definitions p ON p.id=c.plan_id
    WHERE (? IS NULL OR c.plan_id=?)
    AND (? IS NULL OR instr(lower(coalesce(p.name, '')), lower(?))>0 OR instr(c.tail, ?)>0 OR instr(lower(coalesce(c.remark, '')), lower(?))>0)
    AND (? IS NULL OR ?=CASE
      WHEN c.enabled=0 THEN 'disabled'
      WHEN c.valid_until IS NOT NULL AND c.valid_until<=? THEN 'expired'
      WHEN c.used_count>=c.max_uses THEN 'exhausted'
      ELSE 'active' END)
    ORDER BY c.id LIMIT ? OFFSET ?`)
    .bind(planId, planId, search, search, search, search, status, status, now, page.limit, page.offset)
    .all<RedeemCodeRow & { plan_name: string | null }>()
  return rows.results.map(row => ({ ...maskRedeemCode(row), planName: row.plan_name }))
}

export async function updateRedeemCode(db: D1Database, id: string, input: z.infer<typeof updateRedeemInput>, actor: string) {
  const row = await redeemCodes.get(db, id)
  if (!row) throw subscriptionNotFound()
  const enabled = input.enabled === undefined ? row.enabled : Number(input.enabled) as 0 | 1
  const note = input.remark === undefined ? row.remark : input.remark
  await commit(db, [
    requireInBatch(db, 'EXISTS (SELECT 1 FROM redeem_codes WHERE id=?)', id),
    db.prepare('UPDATE redeem_codes SET enabled=?, remark=? WHERE id=?').bind(enabled, note, id),
    auditStatement(db, actor, 'plan.redeem_code.update', 'redeem_code', id, { enabled: enabled === 1 }),
  ])
  return maskRedeemCode({ ...row, enabled, remark: note })
}

export async function archiveRedeemCode(db: D1Database, id: string, actor: string) {
  const row = await redeemCodes.get(db, id)
  if (!row) throw subscriptionNotFound()
  const history = await db.prepare('SELECT 1 AS present FROM redemptions WHERE code_id=? LIMIT 1').bind(id).first()
  const retain = history !== null || row.used_count > 0
  if (!retain) {
    try {
      await commit(db, [
        requireInBatch(db, `EXISTS (SELECT 1 FROM redeem_codes WHERE id=? AND used_count=0)
          AND NOT EXISTS (SELECT 1 FROM redemptions WHERE code_id=?)`, id, id),
        db.prepare('DELETE FROM redeem_codes WHERE id=? AND used_count=0').bind(id),
        auditStatement(db, actor, 'plan.redeem_code.delete', 'redeem_code', id),
      ])
      return { archived: false as const }
    } catch (error) {
      if (!planBatchAborted(error)) throw error
    }
  }
  await commit(db, [
    requireInBatch(db, 'EXISTS (SELECT 1 FROM redeem_codes WHERE id=?)', id),
    db.prepare('UPDATE redeem_codes SET enabled=0 WHERE id=?').bind(id),
    auditStatement(db, actor, 'plan.redeem_code.archive', 'redeem_code', id),
  ], () => subscriptionNotFound())
  return { archived: true as const, code: maskRedeemCode({ ...row, enabled: 0 }) }
}

export async function listCodeRedemptions(db: D1Database, codeId: string, page: { limit: number; offset: number }) {
  if (!await redeemCodes.get(db, codeId)) throw subscriptionNotFound()
  const rows = await db.prepare(`SELECT r.id, r.code_id, r.user_id, r.user_plan_id, r.redeemed_at, r.request_id,
    u.username AS username, i.status AS instance_status, i.expires_at AS expires_at, p.name AS plan_name
    FROM redemptions r
    LEFT JOIN users u ON u.id=r.user_id
    LEFT JOIN user_plans i ON i.id=r.user_plan_id
    LEFT JOIN plan_definitions p ON p.id=i.plan_id
    WHERE r.code_id=? ORDER BY r.redeemed_at, r.id LIMIT ? OFFSET ?`)
    .bind(codeId, page.limit, page.offset)
    .all<Pick<RedemptionRow, 'id' | 'code_id' | 'user_id' | 'user_plan_id' | 'redeemed_at' | 'request_id'> & {
      username: string | null; instance_status: string | null; expires_at: number | null; plan_name: string | null
    }>()
  return rows.results.map(row => ({
    id: row.id, codeId: row.code_id, userId: row.user_id, userPlanId: row.user_plan_id,
    redeemedAt: row.redeemed_at, requestId: row.request_id,
    username: row.username, instanceStatus: row.instance_status, expiresAt: row.expires_at, planName: row.plan_name,
  }))
}

export type LoadedCode = RedeemCodeRow & { plan_duration_seconds: number | null; plan_name: string; plan_enabled: number }

export async function findRedeemCode(env: RedeemEnv, normalized: string) {
  const { keys } = await readKeyring(env.REDEMPTION_HMAC_KEYS)
  const digests = await Promise.all([...keys].map(async ([version, key]) => [version, await codeDigest(key, normalized)] as const))
  const matches = digests.map(() => '(c.digest_key_version=? AND c.code_digest=?)').join(' OR ')
  const found = await env.DB.prepare(`SELECT c.*, p.duration_seconds AS plan_duration_seconds, p.name AS plan_name, p.enabled AS plan_enabled
    FROM redeem_codes c JOIN plan_definitions p ON p.id=c.plan_id WHERE ${matches}`)
    .bind(...digests.flat()).all<LoadedCode>()
  if (found.results.length !== 1) return null
  const row = found.results[0]
  const key = keys.get(row.digest_key_version)
  if (!key || !await matchesCodeTag(key, normalized)) return null
  return row
}

function codeOpen(code: LoadedCode, now: number) {
  return code.enabled === 1
    && (code.valid_from === null || code.valid_from <= now)
    && (code.valid_until === null || code.valid_until > now)
}

async function userRedemptionCount(db: D1Database, codeId: string, userId: string) {
  const count = await db.prepare('SELECT count(*) AS count FROM redemptions WHERE code_id=? AND user_id=?')
    .bind(codeId, userId).first<number>('count')
  return count ?? 0
}

export type RedeemedGrant = {
  replayed: boolean
  redemptionId: string
  token: string | null
  instance: UserPlanRow
  planName: string
  planEnabled: number
}

type SavedRedeem = {
  id: string
  code_id: string
  user_plan_id: string
  plan_id: string
  starts_at: number
  expires_at: number | null
  status: UserPlanRow['status']
  source: UserPlanRow['source']
  source_id: string | null
  remark: string | null
  created_at: string
  updated_at: string
  version: number
  plan_name: string
  plan_enabled: number
  user_id: string
}

function savedInstance(row: SavedRedeem): UserPlanRow {
  return {
    id: row.user_plan_id, user_id: row.user_id, plan_id: row.plan_id, starts_at: row.starts_at, expires_at: row.expires_at,
    status: row.status, source: row.source, source_id: row.source_id, remark: row.remark,
    created_at: row.created_at, updated_at: row.updated_at, version: row.version,
  }
}

async function readSaved(db: D1Database, userId: string, requestId: string) {
  return db.prepare(`SELECT r.id, r.code_id, r.user_plan_id, i.user_id, i.plan_id, i.starts_at, i.expires_at, i.status,
    i.source, i.source_id, i.remark, i.created_at, i.updated_at, i.version, p.name AS plan_name, p.enabled AS plan_enabled
    FROM redemptions r JOIN user_plans i ON i.id=r.user_plan_id JOIN plan_definitions p ON p.id=i.plan_id
    WHERE r.user_id=? AND r.request_id=?`).bind(userId, requestId).first<SavedRedeem>()
}

async function revealGrant(env: RedeemEnv, userId: string, requestId: string, replayed: boolean, knownToken?: string): Promise<RedeemedGrant> {
  const saved = await readSaved(env.DB, userId, requestId)
  if (!saved?.user_plan_id) throw conflict()
  const tokenRow = await env.DB.prepare(`SELECT * FROM subscription_tokens
    WHERE user_plan_id=? AND scope='package' AND revoked_at IS NULL`).bind(saved.user_plan_id).first<SubscriptionTokenRow>()
  const token = knownToken ?? (tokenRow ? await revealPlanToken(env, tokenRow) : null)
  return {
    replayed, redemptionId: saved.id, token, instance: savedInstance(saved),
    planName: saved.plan_name, planEnabled: saved.plan_enabled,
  }
}

const claimSql = `UPDATE redeem_codes SET used_count=used_count+1
  WHERE id=? AND enabled=1 AND used_count<max_uses
    AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>?)
    AND (SELECT count(*) FROM redemptions WHERE code_id=redeem_codes.id AND user_id=?)<per_user_limit
    AND EXISTS (SELECT 1 FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM plan_definitions WHERE id=redeem_codes.plan_id AND enabled=1 AND archived_at IS NULL
      AND (owner_user_id IS NULL OR owner_user_id=?))`

export async function redeemStatements(env: RedeemEnv, userId: string, code: LoadedCode, requestId: string, now: number) {
  const expires = grantExpiry(code, code.plan_duration_seconds, now)
  const stamp = new Date(now).toISOString()
  const redemptionId = crypto.randomUUID()
  const grant = await prepareInstanceGrant(env, {
    userId, planId: code.plan_id, startsAt: now, expiresAt: expires, source: 'redeem', sourceId: code.id,
    remark: null, actor: userId, action: 'plan.instance.redeem',
    detail: { userId, planId: code.plan_id, codeId: code.id, redemptionId }, stamp,
  })
  const { DB: db } = env
  return {
    grant, redemptionId,
    statements: [
      db.prepare(claimSql).bind(code.id, now, now, userId, userId, userId),
      db.prepare(`INSERT INTO system_settings(key, value, updated_at)
        SELECT 'plan_write_conflict', NULL, '' WHERE changes()<>1`),
      ...grant.statements,
      db.prepare(`INSERT INTO redemptions (id, code_id, user_id, user_plan_id, redeemed_at, request_id, issued_subscription_id)
        VALUES (?,?,?,?,?,?,?)`).bind(redemptionId, code.id, userId, grant.row.id, stamp, requestId, grant.tokenId),
    ],
  }
}

async function rejectClosed(db: D1Database, userId: string, code: LoadedCode | null, now: number): Promise<never> {
  if (!planUserEnabled(await readPlanUser(db, userId))) throw subscriptionNotFound()
  if (!code || !codeOpen(code, now)) {
    await recordPlanRedeemFailure(db)
    throw codeInvalid()
  }
  if (code.used_count >= code.max_uses) throw codeExhausted()
  if (await userRedemptionCount(db, code.id, userId) >= code.per_user_limit) throw codeUserLimit()
  const assignable = await db.prepare(`SELECT 1 AS present FROM plan_definitions WHERE id=? AND enabled=1 AND archived_at IS NULL
    AND (owner_user_id IS NULL OR owner_user_id=?)`).bind(code.plan_id, userId).first()
  if (!assignable) throw notAssignable()
  throw conflict()
}

function replayRace(error: unknown) {
  return error instanceof Error && error.message.includes('redemptions.user_id')
}

export async function redeemForUser(env: RedeemEnv, userId: string, rawCode: string, requestId: string,
  address: string | undefined, sessionVersion: number, now = Date.now()): Promise<RedeemedGrant> {
  await limitPlanRedeem(env.DB, userId, address, sessionVersion)
  const normalized = normalizeCode(rawCode)
  if (!normalized) {
    await recordPlanRedeemFailure(env.DB)
    throw codeInvalid()
  }
  const existing = await readSaved(env.DB, userId, requestId)
  const code = await findRedeemCode(env, normalized)
  if (existing) {
    if (!code || existing.code_id !== code.id) throw idempotencyConflict()
    return revealGrant(env, userId, requestId, true)
  }
  if (!code || !codeOpen(code, now) || !planUserEnabled(await readPlanUser(env.DB, userId))
    || code.used_count >= code.max_uses || await userRedemptionCount(env.DB, code.id, userId) >= code.per_user_limit) {
    await rejectClosed(env.DB, userId, code, now)
  }
  const assignable = await env.DB.prepare(`SELECT 1 AS present FROM plan_definitions WHERE id=? AND enabled=1 AND archived_at IS NULL
    AND (owner_user_id IS NULL OR owner_user_id=?)`).bind(code!.plan_id, userId).first()
  if (!assignable) throw notAssignable()
  const prepared = await redeemStatements(env, userId, code!, requestId, now)
  try {
    await env.DB.batch(prepared.statements)
  } catch (error) {
    const saved = await readSaved(env.DB, userId, requestId)
    if (saved && code && saved.code_id === code.id) return revealGrant(env, userId, requestId, true)
    if (saved || replayRace(error)) throw idempotencyConflict()
    if (planBatchAborted(error)) await rejectClosed(env.DB, userId, await findRedeemCode(env, normalized), now)
    throw error
  }
  return {
    replayed: false, redemptionId: prepared.redemptionId, token: prepared.grant.raw,
    instance: prepared.grant.row, planName: code!.plan_name, planEnabled: code!.plan_enabled,
  }
}

export function instanceView(grant: RedeemedGrant, nodeCount: number, now = Date.now()) {
  const row: PlanInstance = { ...grant.instance, name: grant.planName, plan_enabled: grant.planEnabled }
  return {
    replayed: grant.replayed,
    redemptionId: grant.redemptionId,
    ...(grant.token ? { token: grant.token } : {}),
    instance: {
      id: row.id, planId: row.plan_id, name: row.name, status: instanceDisplayStatus(row, now),
      startsAt: row.starts_at, expiresAt: row.expires_at, source: row.source, nodeCount,
    },
  }
}
