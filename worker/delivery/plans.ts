import { z } from 'zod'
import { batch } from '../db/db.js'
import { getSetting, decodeSettingJson } from '../db/settings-repository.js'
import { DELIVERY_D1_READY_KEY, DELIVERY_SETTING_KEYS, isModuleReady, markModuleReady, type DataEnv } from '../db/module-switch.js'
import { readDeliveryKv } from './repository.js'
import { readDeliveryFromD1 } from './d1-repository.js'
import { effectiveStartsAt } from './expiry.js'
import { randomToken } from '../platform/crypto.js'
import { createToken } from './service.js'
import type { Subscription } from './schema.js'
import { apiError } from '../platform/api-error.js'

export const planSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2000).default(''),
  groupIds: z.array(z.string().regex(/^grp_[1-9]\d*$/)).max(500).transform((ids) => [...new Set(ids)]),
  durationDays: z.number().int().min(1).max(36500),
  trafficGb: z.number().finite().min(0).max(1e9).default(0),
  speedLimitMbps: z.number().int().min(0).max(1000000).default(0),
  deviceLimit: z.number().int().min(0).max(1000000).default(0),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(-1000000).max(1000000).default(0),
})
export type PlanInput = z.input<typeof planSchema>
export type Plan = z.output<typeof planSchema> & { id: string; createdAt: string; updatedAt: string }
type PlanRow = { id: string; name: string; description: string; duration_days: number; traffic_gb: number; speed_limit_mbps: number; device_limit: number; enabled: number; sort_order: number; created_at: string; updated_at: string }
export type PlanAssignment = { id: string; userId: string; planId: string; startsAt: string; expiresAt: string | null; status: 'active' | 'revoked'; source: 'admin' | 'trial'; note: string; createdAt: string; updatedAt: string; plan: Plan }
export type SubscriptionPlanSummary = { state: 'active' | 'none' | 'expired' | 'revoked' | 'pending' | 'disabled'; current: PlanAssignment | null; latest: PlanAssignment | null }

export async function listPlans(db: D1Database): Promise<Plan[]> {
  const [plans, groups] = await Promise.all([
    db.prepare('SELECT * FROM plans ORDER BY sort_order, created_at, id').all<PlanRow>(),
    db.prepare('SELECT plan_id, group_id FROM plan_groups ORDER BY position').all<{ plan_id: string; group_id: string }>(),
  ])
  return plans.results.map((p) => ({ id: p.id, name: p.name, description: p.description, durationDays: p.duration_days, trafficGb: p.traffic_gb, speedLimitMbps: p.speed_limit_mbps, deviceLimit: p.device_limit, enabled: p.enabled === 1, sortOrder: p.sort_order, createdAt: p.created_at, updatedAt: p.updated_at, groupIds: groups.results.filter((g) => g.plan_id === p.id).map((g) => g.group_id) }))
}
// Explicit public projection: never expose group membership or management metadata.
export async function listPublicPlans(db: D1Database) {
  const rows = await db.prepare(`SELECT id,name,description,duration_days,traffic_gb,speed_limit_mbps,device_limit
    FROM plans WHERE enabled=1 ORDER BY sort_order,created_at,id`).all<Pick<PlanRow, 'id' | 'name' | 'description' | 'duration_days' | 'traffic_gb' | 'speed_limit_mbps' | 'device_limit'>>()
  return rows.results.map((p) => ({ id: p.id, name: p.name, description: p.description,
    durationDays: p.duration_days, trafficGb: p.traffic_gb, speedLimitMbps: p.speed_limit_mbps, deviceLimit: p.device_limit }))
}
export async function getPlan(db: D1Database, id: string): Promise<Plan> {
  const plan = (await listPlans(db)).find((p) => p.id === id)
  if (!plan) throw apiError(404, 'PLAN_NOT_FOUND', '计划不存在')
  return plan
}
export async function savePlan(db: D1Database, input: PlanInput, id?: string): Promise<Plan> {
  const p = planSchema.parse(input)
  if (id) await getPlan(db, id)
  for (const group of p.groupIds) {
    if (!await db.prepare('SELECT id FROM groups WHERE id = ?').bind(group).first()) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  }
  const planId = id ?? `plan_${crypto.randomUUID()}`
  const now = new Date().toISOString()
  await batch(db, [
    db.prepare(`INSERT INTO plans(id,name,description,duration_days,traffic_gb,speed_limit_mbps,device_limit,enabled,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,duration_days=excluded.duration_days,traffic_gb=excluded.traffic_gb,speed_limit_mbps=excluded.speed_limit_mbps,device_limit=excluded.device_limit,enabled=excluded.enabled,sort_order=excluded.sort_order,updated_at=excluded.updated_at`).bind(planId,p.name,p.description,p.durationDays,p.trafficGb,p.speedLimitMbps,p.deviceLimit,p.enabled ? 1 : 0,p.sortOrder,now,now),
    db.prepare('DELETE FROM plan_groups WHERE plan_id = ?').bind(planId),
    db.prepare(`UPDATE subscriptions SET traffic_gb=?, speed_limit_mbps=?, device_limit=?, revision=revision+1
      WHERE plan_id=?`).bind(p.trafficGb,p.speedLimitMbps,p.deviceLimit,planId),
    bumpDeliveryRevision(db, now),
    ...p.groupIds.map((g, i) => db.prepare('INSERT INTO plan_groups(plan_id,group_id,position) VALUES(?,?,?)').bind(planId,g,i)),
  ])
  return getPlan(db, planId)
}
export async function deletePlan(db: D1Database, id: string): Promise<void> {
  await getPlan(db, id)
  if (await db.prepare('SELECT id FROM subscriptions WHERE plan_id = ? LIMIT 1').bind(id).first()) throw apiError(409, 'PLAN_IN_USE', '计划已有订阅记录，请停用')
  const trial = await readTrialSettings(db)
  if (trial.trialPlanId === id) throw apiError(409, 'PLAN_IN_USE', '计划正在用于注册试用')
  try { await db.prepare('DELETE FROM plans WHERE id = ?').bind(id).run() }
  catch { throw apiError(409, 'PLAN_IN_USE', '计划已有订阅记录，请停用') }
}

export function subscriptionPlanState(subscription: Subscription, plan: Plan | null, now: number): SubscriptionPlanSummary['state'] {
  if (!plan) return 'none'
  if (subscription.planRevoked) return 'revoked'
  if (subscription.expiresAt !== null && subscription.expiresAt <= now) return 'expired'
  if (effectiveStartsAt(subscription) > now) return 'pending'
  return subscription.enabled && plan.enabled ? 'active' : 'disabled'
}

// Historical response shape retained for existing API clients.
export async function getSubscriptionPlanSummary(db: D1Database, userId: string, now = new Date().toISOString()): Promise<SubscriptionPlanSummary> {
  const subscriptions = (await readDeliveryFromD1(db)).subscriptions.filter(s => s.userId === userId && s.planId)
  const plans = new Map((await listPlans(db)).map(plan => [plan.id, plan]))
  const candidates = subscriptions.map(subscription => {
    const plan = plans.get(subscription.planId!)!
    return { subscription, plan, state: subscriptionPlanState(subscription, plan, Date.parse(now)) }
  })
  const match = candidates.find(candidate => candidate.state === 'active') ??
    candidates.sort((a, b) => Number(!!a.subscription.planRevoked) - Number(!!b.subscription.planRevoked)
      || b.subscription.updatedAt.localeCompare(a.subscription.updatedAt))[0]
  if (!match) return { state: 'none', current: null, latest: null }
  const { subscription: row, plan, state } = match
  const latest: PlanAssignment = {
    id: row.id, userId, planId: plan.id,
    startsAt: new Date(effectiveStartsAt(row)).toISOString(),
    expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
    status: row.planRevoked ? 'revoked' : 'active', source: row.planSource ?? 'admin',
    note: row.planNote ?? '', createdAt: row.createdAt, updatedAt: row.updatedAt,
    plan: { ...plan, trafficGb: row.trafficGb ?? 0, speedLimitMbps: row.speedLimitMbps ?? 0, deviceLimit: row.deviceLimit ?? 0 },
  }
  return { state, latest, current: state === 'active' ? latest : null }
}

export function bumpDeliveryRevision(db: D1Database, now: string, guarded = false) {
  return db.prepare(`INSERT INTO system_settings (key, value, updated_at)
    SELECT ?, '1', ? ${guarded ? 'WHERE changes() = 1' : ''}
    ON CONFLICT(key) DO UPDATE SET value = cast(value AS INTEGER) + 1, updated_at = excluded.updated_at`)
    .bind(DELIVERY_SETTING_KEYS.revision, now)
}

export async function requirePlanStorage(env: DataEnv) {
  if (await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)) return
  if ((await readDeliveryKv(env.DATA)).subscriptions.length) {
    throw apiError(409, 'SUBSCRIPTION_STORAGE_NOT_READY', '请先完成订阅 D1 迁移')
  }
  await markModuleReady(env.DB, DELIVERY_D1_READY_KEY)
}

function insertPlannedSubscription(env: DataEnv, userId: string, plan: Plan, days: number, source: 'admin' | 'trial', note: string, now: string, token: Awaited<ReturnType<typeof createToken>>) {
  const { tokenHash, tokenPrefix, encryptedToken } = token
  const start = Date.parse(now)
  return env.DB.prepare(`INSERT INTO subscriptions (
      id,user_id,name,token_hash,token_prefix,encrypted_token,enabled,default_client,revision,
      starts_at,expires_at,created_at,updated_at,plan_id,traffic_gb,speed_limit_mbps,device_limit,plan_source,plan_note
    ) SELECT 'sub_' || max(
      coalesce((SELECT max(cast(substr(id, 5) AS INTEGER)) + 1 FROM subscriptions),1),
      coalesce((SELECT cast(value AS INTEGER) FROM system_settings WHERE key='next_subscription_id'),1)
    ), ?,p.name,?,?,?,1,'mihomo',1,?,?,?,?,p.id,p.traffic_gb,p.speed_limit_mbps,p.device_limit,?,?
    FROM plans p WHERE p.id=? AND p.enabled=1
    AND ${source === 'trial' ? 'changes() = 1' : 'NOT EXISTS (SELECT 1 FROM subscriptions WHERE user_id=? AND plan_id IS NOT NULL AND plan_revoked=0)'}
    `).bind(userId, tokenHash, tokenPrefix, JSON.stringify(encryptedToken), start,
      start + days * 86400000, now, now, source, note, plan.id,
      ...(source === 'admin' ? [userId] : []))
}

function copyPlanGroups(db: D1Database, tokenHash: string) {
  return db.prepare(`INSERT INTO subscription_groups (subscription_id, group_id, position)
    SELECT s.id, pg.group_id, pg.position FROM subscriptions s JOIN plan_groups pg ON pg.plan_id=s.plan_id
    WHERE s.token_hash=?`).bind(tokenHash)
}

export async function operateSubscriptionPlan(env: DataEnv, userId: string, action: 'grant' | 'renew' | 'switch' | 'revoke', planId?: string, note = '', now = new Date().toISOString()) {
  const db = env.DB
  if (!await db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first()) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  await requirePlanStorage(env)
  const state = await getSubscriptionPlanSummary(db, userId, now)
  const existing = state.latest?.status === 'active' ? state.latest : null
  if (action === 'grant' && existing) throw apiError(409, 'ENTITLEMENT_EXISTS', '已有订阅计划，请续期或换计划')
  if (action !== 'grant' && !existing) throw apiError(409, 'ENTITLEMENT_MISSING', '没有可操作的订阅计划')
  const plan = action === 'revoke' ? null : await getPlan(db, action === 'renew' ? existing!.planId : planId ?? '')
  if (plan && !plan.enabled) throw apiError(409, 'PLAN_DISABLED', '计划已停用')
  const time = Date.parse(now)
  const days = (plan?.durationDays ?? 0) * 86400000
  const candidate = existing?.id ?? (await readDeliveryFromD1(db)).subscriptions
    .filter(s => s.userId === userId && !s.planId)
    .sort((a,b) => Number(b.enabled) - Number(a.enabled) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]?.id
  if (!candidate) {
    const grant = await plannedSubscriptionStatements(env, userId, plan!, plan!.durationDays, 'admin', note, now)
    const [result] = await batch(db, grant)
    if (result.meta.changes !== 1) throw apiError(409, 'ENTITLEMENT_EXISTS', '已有订阅计划，请刷新')
  } else {
    const statement = action === 'revoke'
      ? db.prepare("UPDATE subscriptions SET enabled=0, plan_revoked=1, plan_note=?, revision=revision+1, updated_at=? WHERE id=? AND user_id=? AND plan_id=? AND plan_revoked=0")
        .bind(note, now, candidate, userId, existing!.planId)
      : action === 'renew'
      ? db.prepare(`UPDATE subscriptions SET expires_at=max(coalesce(expires_at,?),?)+?,
          enabled=CASE WHEN expires_at <= ? THEN 1 ELSE enabled END,
          plan_note=?, revision=revision+1, updated_at=? WHERE id=? AND user_id=? AND plan_id=? AND plan_revoked=0`)
        .bind(time, time, days, time, note, now, candidate, userId, existing!.planId)
      : db.prepare(`UPDATE subscriptions SET plan_id=?, traffic_gb=?, speed_limit_mbps=?, device_limit=?,
          starts_at=?, expires_at=?, plan_note=?, plan_source='admin', last_reminded_at=NULL, revision=revision+1, updated_at=?
          WHERE id=? AND user_id=? AND plan_id IS ? AND plan_revoked=0
          AND (? IS NOT NULL OR NOT EXISTS (SELECT 1 FROM subscriptions WHERE user_id=? AND plan_id IS NOT NULL AND plan_revoked=0))`)
        .bind(plan!.id, plan!.trafficGb, plan!.speedLimitMbps, plan!.deviceLimit, time, time+days, note, now,
          candidate, userId, existing?.planId ?? null, existing?.planId ?? null, userId)
    const [result] = await batch(db, [statement, bumpDeliveryRevision(db, now, true)])
    if (result.meta.changes !== 1) throw apiError(409, 'ENTITLEMENT_CHANGED', '订阅已变更，请刷新')
  }
  const summary = await getSubscriptionPlanSummary(db, userId, now)
  return { ...summary, subscriptionId: candidate ?? summary.latest?.id ?? null }
}
export const trialSchema = z.object({ trialPlanId: z.string().min(1).nullable(), trialDays: z.number().int().min(1).max(36500).nullable() })
export async function readTrialSettings(db: D1Database): Promise<z.infer<typeof trialSchema>> {
  const [plan, days] = await Promise.all([getSetting(db,'trial_plan_id'),getSetting(db,'trial_days')])
  return trialSchema.parse({ trialPlanId: plan === null ? null : decodeSettingJson(plan), trialDays: days === null ? null : decodeSettingJson(days) })
}
async function plannedSubscriptionStatements(env: DataEnv, userId: string, plan: Plan, days: number, source: 'admin' | 'trial', note: string, now: string) {
  const token = await createToken(env.DATA, randomToken())
  return [
    insertPlannedSubscription(env, userId, plan, days, source, note, now, token),
    bumpDeliveryRevision(env.DB, now, true),
    copyPlanGroups(env.DB, token.tokenHash),
    env.DB.prepare(`INSERT INTO system_settings (key,value,updated_at)
      SELECT 'next_subscription_id', cast(substr(id,5) AS INTEGER)+1, ? FROM subscriptions WHERE token_hash=?
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(now, token.tokenHash),
  ]
}

export async function trialSubscriptionStatements(env: DataEnv, userId: string, now: string): Promise<D1PreparedStatement[]> {
  const settings = await readTrialSettings(env.DB)
  if (!settings.trialPlanId || !settings.trialDays) return []
  const plan = await getPlan(env.DB, settings.trialPlanId)
  if (!plan.enabled) return []
  await requirePlanStorage(env)
  return plannedSubscriptionStatements(env, userId, plan, settings.trialDays, 'trial', '', now)
}
