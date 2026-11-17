import { z } from 'zod'
import { batch } from '../db/db.js'
import { getSetting, decodeSettingJson } from '../db/settings-repository.js'
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
export type Entitlement = { id: string; userId: string; planId: string; startsAt: string; expiresAt: string; status: 'active' | 'revoked'; source: 'admin' | 'trial'; note: string; createdAt: string; updatedAt: string; plan: Plan }
type EntitlementRow = { id: string; user_id: string; plan_id: string; starts_at: string; expires_at: string; status: 'active' | 'revoked'; source: 'admin' | 'trial'; note: string; created_at: string; updated_at: string }
export type EntitlementState = { state: 'active' | 'none' | 'expired' | 'revoked' | 'pending' | 'disabled'; current: Entitlement | null; latest: Entitlement | null }

export async function listPlans(db: D1Database): Promise<Plan[]> {
  const [plans, groups] = await Promise.all([
    db.prepare('SELECT * FROM plans ORDER BY sort_order, created_at, id').all<PlanRow>(),
    db.prepare('SELECT plan_id, group_id FROM plan_groups ORDER BY position').all<{ plan_id: string; group_id: string }>(),
  ])
  return plans.results.map((p) => ({ id: p.id, name: p.name, description: p.description, durationDays: p.duration_days, trafficGb: p.traffic_gb, speedLimitMbps: p.speed_limit_mbps, deviceLimit: p.device_limit, enabled: p.enabled === 1, sortOrder: p.sort_order, createdAt: p.created_at, updatedAt: p.updated_at, groupIds: groups.results.filter((g) => g.plan_id === p.id).map((g) => g.group_id) }))
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
    ...p.groupIds.map((g, i) => db.prepare('INSERT INTO plan_groups(plan_id,group_id,position) VALUES(?,?,?)').bind(planId,g,i)),
  ])
  return getPlan(db, planId)
}
export async function deletePlan(db: D1Database, id: string): Promise<void> {
  await getPlan(db, id)
  if (await db.prepare('SELECT id FROM user_entitlements WHERE plan_id = ? LIMIT 1').bind(id).first()) throw apiError(409, 'PLAN_IN_USE', '计划已有权益记录，请停用')
  const trial = await readTrialSettings(db)
  if (trial.trialPlanId === id) throw apiError(409, 'PLAN_IN_USE', '计划正在用于注册试用')
  try { await db.prepare('DELETE FROM plans WHERE id = ?').bind(id).run() }
  catch { throw apiError(409, 'PLAN_IN_USE', '计划已有权益记录，请停用') }
}

// The only temporal/availability decision used by delivery and all status views.
export async function getUserEntitlement(db: D1Database, userId: string, now = new Date().toISOString()): Promise<EntitlementState> {
  let rows: D1Result<EntitlementRow>
  try { rows = await db.prepare("SELECT * FROM user_entitlements WHERE user_id = ? ORDER BY (status = 'active') DESC, created_at DESC, rowid DESC LIMIT 1").bind(userId).all<EntitlementRow>() } catch (error) {
    // Fail closed during a rolling migration; never treat missing rights as access.
    if (error instanceof Error && /no such table.*user_entitlements/i.test(error.message)) return { state: 'none', current: null, latest: null }
    throw error
  }
  const row = rows.results[0]
  if (!row) return { state: 'none', current: null, latest: null }
  const plan = await getPlan(db, row.plan_id)
  const latest: Entitlement = { id: row.id, userId: row.user_id, planId: row.plan_id, startsAt: row.starts_at, expiresAt: row.expires_at, status: row.status, source: row.source, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at, plan }
  const state = row.status === 'revoked' ? 'revoked' : row.expires_at <= now ? 'expired' : row.starts_at > now ? 'pending' : !plan.enabled ? 'disabled' : 'active'
  return { state, current: state === 'active' ? latest : null, latest }
}
export function grantStatement(db: D1Database, userId: string, planId: string, days: number, source: 'admin' | 'trial', note: string, now: string, guarded = false): D1PreparedStatement {
  const expires = new Date(Date.parse(now) + days * 86400000).toISOString()
  return db.prepare(`INSERT INTO user_entitlements(id,user_id,plan_id,starts_at,expires_at,status,source,note,created_at,updated_at) SELECT ?,?,?,?,?,'active',?,?,?,?${guarded ? ' WHERE changes() = 1' : ''}`).bind(`ent_${crypto.randomUUID()}`,userId,planId,now,expires,source,note,now,now)
}
export async function operateEntitlement(db: D1Database, userId: string, action: 'grant' | 'renew' | 'switch' | 'revoke', planId?: string, note = '', now = new Date().toISOString()): Promise<EntitlementState> {
  if (!await db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first()) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  const state = await getUserEntitlement(db, userId, now)
  const existing = state.latest?.status === 'active' ? state.latest : null
  if (action === 'revoke') {
    if (!existing) throw apiError(409, 'ENTITLEMENT_MISSING', '无可收回权益')
    await db.prepare("UPDATE user_entitlements SET status='revoked',note=?,updated_at=? WHERE id=? AND status='active'").bind(note,now,existing.id).run()
  } else if (action === 'renew') {
    if (!existing) throw apiError(409, 'ENTITLEMENT_MISSING', '无可续期权益')
    const plan = await getPlan(db, existing.planId)
    if (!plan.enabled) throw apiError(409, 'PLAN_DISABLED', '计划已停用')
    const renewed = await db.prepare(`UPDATE user_entitlements SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',CASE WHEN expires_at > ? THEN expires_at ELSE ? END, ?),note=?,updated_at=? WHERE id=? AND status='active'`).bind(now,now,`+${plan.durationDays} days`,note,now,existing.id).run()
    if (renewed.meta.changes !== 1) throw apiError(409, 'ENTITLEMENT_CHANGED', '权益已变更，请刷新')
  } else {
    const plan = await getPlan(db, planId ?? '')
    if (!plan.enabled) throw apiError(409, 'PLAN_DISABLED', '计划已停用')
    if (action === 'grant' && existing) throw apiError(409, 'ENTITLEMENT_EXISTS', '已有权益，请续期或换计划')
    if (action === 'switch' && !existing) throw apiError(409, 'ENTITLEMENT_MISSING', '无可更换权益')
    try {
      const results = await batch(db, [
        ...(existing ? [db.prepare("UPDATE user_entitlements SET status='revoked',updated_at=? WHERE id=? AND status='active'").bind(now,existing.id)] : []),
        grantStatement(db,userId,plan.id,plan.durationDays,'admin',note,now,existing !== null),
      ])
      if (results.at(-1)?.meta.changes !== 1) throw apiError(409, 'ENTITLEMENT_CHANGED', '权益已变更，请刷新')
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) throw apiError(409, 'ENTITLEMENT_EXISTS', '已有权益，请刷新')
      throw error
    }
  }
  return getUserEntitlement(db,userId,now)
}
export const trialSchema = z.object({ trialPlanId: z.string().min(1).nullable(), trialDays: z.number().int().min(1).max(36500).nullable() })
export async function readTrialSettings(db: D1Database): Promise<z.infer<typeof trialSchema>> {
  const [plan, days] = await Promise.all([getSetting(db,'trial_plan_id'),getSetting(db,'trial_days')])
  return trialSchema.parse({ trialPlanId: plan === null ? null : decodeSettingJson(plan), trialDays: days === null ? null : decodeSettingJson(days) })
}
export async function trialGrantStatement(db: D1Database, userId: string, now: string): Promise<D1PreparedStatement | null> {
  const settings = await readTrialSettings(db)
  if (!settings.trialPlanId || !settings.trialDays) return null
  const plan = await getPlan(db,settings.trialPlanId)
  if (!plan.enabled) return null
  // Guard on the user insertion in the registration batch; losing requests cannot grant.
  const expires = new Date(Date.parse(now) + settings.trialDays * 86400000).toISOString()
  return db.prepare(`INSERT INTO user_entitlements(id,user_id,plan_id,starts_at,expires_at,status,source,note,created_at,updated_at)
    SELECT ?,?,?,?,?,'active','trial','',?,? WHERE changes() = 1`).bind(`ent_${crypto.randomUUID()}`,userId,plan.id,now,expires,now,now)
}
