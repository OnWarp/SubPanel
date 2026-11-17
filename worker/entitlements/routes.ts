import { compileAllSubscriptions } from '../delivery/compiler.js'
import type { DataEnv } from '../db/module-switch.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { readJson } from '../platform/http.js'
import { findAccountUserById } from '../accounts/repository.js'
import { userAnchorStatement } from '../db/ensure-users.js'
import { batch } from '../db/db.js'
import { upsertSettingStatement } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
import { deletePlan, getPlan, getUserEntitlement, listPlans, listPublicPlans, operateEntitlement, planSchema, readTrialSettings, savePlan, trialSchema } from './service.js'

async function refreshDelivery(env: DataEnv): Promise<{ warning?: string }> {
  try { await compileAllSubscriptions(env); return {} }
  catch { return { warning: '权益已保存，订阅缓存更新失败；下载时仍会检查当前权益' } }
}

export const adminEntitlementRoutes = new Hono<AppEnv>()
adminEntitlementRoutes.get('/plans', async (c) => c.json({ plans: await listPlans(c.env.DB) }))
adminEntitlementRoutes.post('/plans', async (c) => {
  const plan = await savePlan(c.env.DB, await readJson(c,planSchema))
  return c.json({ plan, ...await refreshDelivery(c.env) },201)
})
adminEntitlementRoutes.put('/plans/:id', async (c) => {
  const plan = await savePlan(c.env.DB,await readJson(c,planSchema),c.req.param('id'))
  return c.json({ plan, ...await refreshDelivery(c.env) })
})
adminEntitlementRoutes.delete('/plans/:id', async (c) => { await deletePlan(c.env.DB,c.req.param('id')); return c.body(null,204) })
adminEntitlementRoutes.get('/entitlements/trial', async (c) => c.json(await readTrialSettings(c.env.DB)))
adminEntitlementRoutes.put('/entitlements/trial', async (c) => {
  const input = await readJson(c,trialSchema)
  if (input.trialPlanId) {
    const plan = await getPlan(c.env.DB,input.trialPlanId)
    if (!plan.enabled) throw apiError(409,'PLAN_DISABLED','计划已停用')
  }
  const now = new Date().toISOString()
  await batch(c.env.DB,[upsertSettingStatement(c.env.DB,'trial_plan_id',input.trialPlanId,now),upsertSettingStatement(c.env.DB,'trial_days',input.trialDays,now)])
  return c.json(input)
})
adminEntitlementRoutes.get('/users/:id/entitlement', async (c) => {
  const user = await findAccountUserById(c.env,c.req.param('id'))
  if (!user || user.deletedAt) throw apiError(404,'USER_NOT_FOUND','用户不存在')
  return c.json(await getUserEntitlement(c.env.DB,user.id))
})
const operationSchema = z.object({ action: z.enum(['grant','renew','switch','revoke']), planId: z.string().min(1).optional(), note: z.string().trim().max(2000).default('') })
adminEntitlementRoutes.post('/users/:id/entitlement', async (c) => {
  const input = await readJson(c,operationSchema)
  const user = await findAccountUserById(c.env,c.req.param('id'))
  if (!user || user.deletedAt) throw apiError(404,'USER_NOT_FOUND','用户不存在')
  await userAnchorStatement(c.env.DB,user).run()
  const entitlement = await operateEntitlement(c.env.DB,user.id,input.action,input.planId,input.note)
  return c.json({ ...entitlement, ...await refreshDelivery(c.env) })
})
export const userEntitlementRoutes = new Hono<AppEnv>()
userEntitlementRoutes.get('/entitlement', async (c) => c.json(await getUserEntitlement(c.env.DB,c.get('principal').id)))

userEntitlementRoutes.get('/plans', async (c) => c.json({ plans: await listPublicPlans(c.env.DB) }))
