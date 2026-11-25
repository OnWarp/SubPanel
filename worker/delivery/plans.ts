import { expiryFromDuration } from '../../shared/subscription-duration.js'
import { auditStatement } from '../admin/audit.js'
import { mutateBinding } from './bindings.js'
import { prepareUserAccess } from './user-access.js'
import { z } from 'zod'
import { batch } from '../db/db.js'
import { getSetting, decodeSettingJson } from '../db/settings-repository.js'
import { DELIVERY_D1_READY_KEY, DELIVERY_SETTING_KEYS, isModuleReady, markModuleReady, type DataEnv } from '../db/module-switch.js'
import { readDeliveryKv } from './repository.js'
import { subscriptionWindowStatus } from './expiry.js'
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

export async function listPlans(db: D1Database, id?: string): Promise<Plan[]> {
  const [plans, groups] = await batch(db, [
    id ? db.prepare('SELECT * FROM plans WHERE id=?').bind(id)
      : db.prepare('SELECT * FROM plans ORDER BY sort_order, created_at, id'),
    id ? db.prepare('SELECT plan_id, group_id FROM plan_groups WHERE plan_id=? ORDER BY position').bind(id)
      : db.prepare('SELECT plan_id, group_id FROM plan_groups ORDER BY position'),
  ])
  const planGroups = groups.results as { plan_id: string; group_id: string }[]
  return (plans.results as PlanRow[]).map((p) => ({ id: p.id, name: p.name, description: p.description, durationDays: p.duration_days, trafficGb: p.traffic_gb, speedLimitMbps: p.speed_limit_mbps, deviceLimit: p.device_limit, enabled: p.enabled === 1, sortOrder: p.sort_order, createdAt: p.created_at, updatedAt: p.updated_at, groupIds: planGroups.filter((g) => g.plan_id === p.id).map((g) => g.group_id) }))
}
// Explicit public projection: never expose group membership or management metadata.
export async function listPublicPlans(db: D1Database) {
  const rows = await db.prepare(`SELECT id,name,description,duration_days,traffic_gb,speed_limit_mbps,device_limit
    FROM plans WHERE enabled=1 ORDER BY sort_order,created_at,id`).all<Pick<PlanRow, 'id' | 'name' | 'description' | 'duration_days' | 'traffic_gb' | 'speed_limit_mbps' | 'device_limit'>>()
  return rows.results.map((p) => ({ id: p.id, name: p.name, description: p.description,
    durationDays: p.duration_days, trafficGb: p.traffic_gb, speedLimitMbps: p.speed_limit_mbps, deviceLimit: p.device_limit }))
}
export async function getPlan(db: D1Database, id: string): Promise<Plan> {
  const plan = (await listPlans(db, id))[0]
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
    bumpDeliveryRevision(db, now),
    ...p.groupIds.map((g, i) => db.prepare('INSERT INTO plan_groups(plan_id,group_id,position) VALUES(?,?,?)').bind(planId,g,i)),
  ])
  return getPlan(db, planId)
}
export async function deletePlan(db: D1Database, id: string): Promise<void> {
  await getPlan(db, id)
  const trial = await readTrialSettings(db)
  if (trial.trialPlanId === id) throw apiError(409, 'PLAN_IN_USE', '计划正在用于注册试用')
  try { await db.prepare('DELETE FROM plans WHERE id = ?').bind(id).run() }
  catch { throw apiError(409, 'PLAN_IN_USE', '计划已有订阅记录，请停用') }
}

export function subscriptionPlanState(subscription: Pick<Subscription, 'planRevoked' | 'expiresAt' | 'startsAt' | 'createdAt' | 'enabled'>, plan: Plan | null, now: number): SubscriptionPlanSummary['state'] {
  if (!plan) return 'none'
  if (subscription.planRevoked) return 'revoked'
  const window = subscriptionWindowStatus(subscription, now)
  if (window) return window
  return subscription.enabled && plan.enabled ? 'active' : 'disabled'
}

// Historical response shape retained for existing API clients.
export async function getSubscriptionPlanSummary(db: D1Database, userId: string, now = new Date().toISOString()): Promise<SubscriptionPlanSummary> {
  const { results } = await db.prepare(`SELECT b.*, mapping.plan_id,
    EXISTS (SELECT 1 FROM audit_logs a WHERE a.target_id=b.user_id AND a.action='subscription.trial'
      AND json_extract(a.detail,'$.templateId')=b.template_id) AS trial
    FROM user_template_bindings b JOIN entitlement_plan_policies mapping ON mapping.template_id=b.template_id
    WHERE b.user_id=? ORDER BY b.updated_at DESC,b.template_id`).bind(userId).all<{
      template_id: string; plan_id: string; starts_at: number; expires_at: number | null;
      status: 'active' | 'paused' | 'revoked'; created_at: string; updated_at: string; trial: number;
    }>()
  const plans = new Map((await listPlans(db)).map(plan => [plan.id, plan]))
  const candidates = results.flatMap(row => {
    const plan = plans.get(row.plan_id)
    if (!plan) return []
    const state: SubscriptionPlanSummary['state'] = row.status === 'revoked' ? 'revoked'
      : row.status === 'paused' || !plan.enabled ? 'disabled'
        : row.starts_at > Date.parse(now) ? 'pending'
          : row.expires_at !== null && row.expires_at <= Date.parse(now) ? 'expired' : 'active'
    const latest: PlanAssignment = { id: row.template_id, userId, planId: row.plan_id,
      startsAt: new Date(row.starts_at).toISOString(),
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      status: row.status === 'revoked' ? 'revoked' : 'active', source: row.trial ? 'trial' : 'admin',
      note: '', createdAt: row.created_at, updatedAt: row.updated_at, plan,
    }
    return [{ state, current: state === 'active' ? latest : null, latest }]
  })
  return candidates.find(item => item.current) ?? candidates[0] ?? { state: 'none', current: null, latest: null }
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

export async function operateSubscriptionPlan(env: DataEnv, userId: string, action: 'grant' | 'renew' | 'switch' | 'revoke', planId?: string, _note = '', now = new Date().toISOString(),
  actor = 'admin', requestId?: string, expectedRevision?: number,
) {
  return operateBoundPlan(env, userId, action, planId, now, actor, requestId, expectedRevision)
}
export const trialSchema = z.object({ trialPlanId: z.string().min(1).nullable(), trialDays: z.number().int().min(1).max(36500).nullable() })
export async function readTrialSettings(db: D1Database): Promise<z.infer<typeof trialSchema>> {
  const [plan, days] = await Promise.all([getSetting(db,'trial_plan_id'),getSetting(db,'trial_days')])
  return trialSchema.parse({ trialPlanId: plan === null ? null : decodeSettingJson(plan), trialDays: days === null ? null : decodeSettingJson(days) })
}
export async function trialSubscriptionStatements(env: DataEnv, userId: string, now: string): Promise<D1PreparedStatement[]> {
  const settings = await readTrialSettings(env.DB)
  if (!settings.trialPlanId || !settings.trialDays) return []
  const plan = await getPlan(env.DB, settings.trialPlanId)
  if (!plan.enabled) return []
  const db = env.DB
  const template = await templateForPlan(db, plan.id)
  const start = Date.parse(now)
  const expires = expiryFromDuration(start, { unit: 'day', value: settings.trialDays })
  const requestId = crypto.randomUUID()
  return [
    await prepareUserAccess(env, userId, now),
    db.prepare(`INSERT INTO user_template_bindings
      (user_id,template_id,starts_at,expires_at,status,created_at,updated_at)
      VALUES (CASE WHEN changes()=1 AND EXISTS (
        SELECT 1 FROM entitlement_templates t JOIN entitlement_plan_policies p ON p.template_id=t.id
        JOIN plans ON plans.id=p.plan_id WHERE t.id=? AND t.revision=? AND t.status='enabled'
          AND plans.id=? AND plans.enabled=1 AND plans.updated_at=?
      ) THEN ? END,?,?,?,'active',?,?)`).bind(template.id, template.revision, plan.id, plan.updatedAt,
      userId, template.id, start, expires, now, now),
    auditStatement(db, userId, 'subscription.trial', 'user', userId,
      { userId, templateId: template.id, requestId, before: null, after: { status: 'active', startsAt: start, expiresAt: expires } }, now),
  ]
}

async function templateForPlan(db: D1Database, planId: string) {
  const row = await db.prepare(`SELECT t.id,t.revision FROM entitlement_plan_policies p
    JOIN entitlement_templates t ON t.id=p.template_id
    WHERE p.plan_id=? AND t.status='enabled'`).bind(planId).first<{ id: string; revision: number }>()
  if (!row) throw apiError(409, 'PLAN_TEMPLATE_REQUIRED', '请先关联启用的授权模板')
  return row
}

async function operateBoundPlan(env: DataEnv, userId: string, action: 'grant' | 'renew' | 'switch' | 'revoke',
  planId: string | undefined, now: string, actor: string, requestId: string | undefined, expectedRevision: number | undefined,
) {
  if (requestId === undefined || expectedRevision === undefined) {
    throw apiError(422, 'BINDING_REVISION_REQUIRED', '请提供授权版本与请求编号')
  }
  const rows = await env.DB.prepare(`SELECT b.template_id,p.plan_id FROM user_template_bindings b
    JOIN entitlement_plan_policies p ON p.template_id=b.template_id
    WHERE b.user_id=? AND b.status<>'revoked'`).bind(userId).all<{ template_id: string; plan_id: string }>()
  const [existing] = rows.results
  if (rows.results.length > 1 || (action === 'grant' && existing)) {
    throw apiError(409, 'ENTITLEMENT_EXISTS', '请直接管理用户模板授权')
  }
  if (action !== 'grant' && !existing) throw apiError(409, 'ENTITLEMENT_MISSING', '没有可操作的订阅计划')
  const target = action === 'renew' || action === 'revoke' ? existing.template_id
    : (await templateForPlan(env.DB, planId ?? '')).id
  const request = { requestId, expectedRevision }
  const plan = action === 'revoke' ? null : await getPlan(env.DB, action === 'renew' ? existing.plan_id : planId ?? '')
  if (plan && !plan.enabled) throw apiError(409, 'PLAN_DISABLED', '计划已停用')
  const expiry = { type: 'duration', duration: { unit: 'day', value: plan?.durationDays ?? 1 } } as const
  const operation = action === 'revoke' ? { ...request, mode: 'revoke' } as const
    : action === 'switch' && target !== existing.template_id
      ? { ...request, mode: 'replace', oldTemplateId: existing.template_id, newTemplateId: target, expiry } as const
      : { ...request, mode: action === 'grant' ? 'assign' : 'renew', expiry } as const
  const binding = await mutateBinding(env, userId, target, operation, actor, Date.parse(now))
  return { ...(await getSubscriptionPlanSummary(env.DB, userId, now)), subscriptionId: null, binding }
}
