import { auditStatement } from '../admin/audit.js'
import { requireUnifiedSubscription } from './user-access.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { readJson } from '../platform/http.js'
import { findAccountUserById } from '../accounts/repository.js'
import { userAnchorStatement } from '../db/ensure-users.js'
import { batch } from '../db/db.js'
import { upsertSettingStatement } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { deletePlan, getPlan, getSubscriptionPlanSummary, listPlans, listPublicPlans, operateSubscriptionPlan, planSchema, readTrialSettings, savePlan, trialSchema } from './plans.js'
import { attachTrafficUsage, measuredTrafficForSubscription } from './traffic-usage.js'

export const adminPlanRoutes = new Hono<AppEnv>()
adminPlanRoutes.get('/plans', async (c) => c.json({ plans: await listPlans(c.env.DB) }))
adminPlanRoutes.post('/plans', async (c) => {
  const plan = await savePlan(c.env.DB, await readJson(c,planSchema))
  return c.json({ plan },201)
})
adminPlanRoutes.put('/plans/:id', async (c) => {
  const plan = await savePlan(c.env.DB,await readJson(c,planSchema),c.req.param('id'))
  return c.json({ plan })
})
adminPlanRoutes.put('/plans/:id/entitlement-template', async c => {
  const db = c.env.DB
  await requireUnifiedSubscription(db)
  const plan = await getPlan(db, c.req.param('id'))
  const { templateId } = await readJson(c, z.strictObject({ templateId: z.uuid() }))
  const template = await db.prepare(`SELECT id FROM entitlement_templates t
    WHERE t.id=? AND t.status='enabled' AND NOT EXISTS (
      SELECT 1 FROM private_entitlement_templates WHERE template_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM user_template_bindings WHERE template_id=t.id)
      AND EXISTS (SELECT 1 FROM entitlement_template_versions WHERE template_id=t.id)`).bind(templateId).first()
  if (!template) throw apiError(409, 'PLAN_TEMPLATE_UNAVAILABLE', '请选择尚未分配的共享授权模板')
  const now = new Date().toISOString()
  try {
    await db.batch([
      db.prepare(`INSERT INTO entitlement_plan_policies(template_id,plan_id)
        VALUES (CASE WHEN NOT EXISTS (SELECT 1 FROM user_template_bindings WHERE template_id=?)
          THEN ? END,?)`).bind(templateId,templateId,plan.id),
      auditStatement(db, c.get('principal').id, 'subscription.plan_policy.link', 'plan', plan.id,
        { templateId, requestId: crypto.randomUUID() }, now),
    ])
  } catch (error) {
    if (error instanceof Error && error.message.includes('constraint failed')) {
      throw apiError(409, 'PLAN_TEMPLATE_CONFLICT', '模板或计划已关联')
    }
    throw error
  }
  return c.json({ templateId, planId: plan.id })
})
adminPlanRoutes.delete('/plans/:id', async (c) => { await deletePlan(c.env.DB,c.req.param('id')); return c.body(null,204) })
for (const path of ['/subscriptions/trial', '/entitlements/trial'] as const) {
  adminPlanRoutes.get(path, async (c) => c.json(await readTrialSettings(c.env.DB)))
  adminPlanRoutes.put(path, async (c) => {
    const input = await readJson(c,trialSchema)
    if (input.trialPlanId) {
      const plan = await getPlan(c.env.DB,input.trialPlanId)
      if (!plan.enabled) throw apiError(409,'PLAN_DISABLED','计划已停用')
    }
    const now = new Date().toISOString()
    await batch(c.env.DB,[upsertSettingStatement(c.env.DB,'trial_plan_id',input.trialPlanId,now),upsertSettingStatement(c.env.DB,'trial_days',input.trialDays,now)])
    return c.json(input)
  })
}
const operationSchema = z.object({ action: z.enum(['grant','renew','switch','revoke']), planId: z.string().min(1).optional(), note: z.string().trim().max(2000).default(''), requestId: z.uuid().optional(), expectedRevision: z.number().int().nonnegative().optional() })
for (const path of ['/users/:id/subscription-plan', '/users/:id/entitlement'] as const) {
  adminPlanRoutes.get(path, async (c) => {
    const user = await findAccountUserById(c.env,c.req.param('id'))
    if (!user || user.deletedAt) throw apiError(404,'USER_NOT_FOUND','用户不存在')
    return c.json(await getSubscriptionPlanSummary(c.env.DB,user.id))
  })
  adminPlanRoutes.post(path, async (c) => {
    const input = await readJson(c,operationSchema)
    const user = await findAccountUserById(c.env,c.req.param('id'))
    if (!user || user.deletedAt) throw apiError(404,'USER_NOT_FOUND','用户不存在')
    await userAnchorStatement(c.env.DB,user).run()
    const assignment = await operateSubscriptionPlan(c.env,user.id,input.action,input.planId,input.note,undefined,c.get('principal').id,input.requestId,input.expectedRevision)
    return c.json(assignment)
  })
}
export const userPlanRoutes = new Hono<AppEnv>()
userPlanRoutes.get('/entitlement', async (c) => {
  const summary = await getSubscriptionPlanSummary(c.env.DB, c.get('principal').id)
  const subscriptionId = summary.current?.id ?? summary.latest?.id ?? null
  const trafficGb = summary.current?.plan.trafficGb ?? summary.latest?.plan.trafficGb ?? 0
  return c.json(attachTrafficUsage(summary, trafficGb, measuredTrafficForSubscription(subscriptionId)))
})

userPlanRoutes.get('/plans', async (c) => c.json({ plans: await listPublicPlans(c.env.DB) }))
