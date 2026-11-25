import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { createEntitlementTemplate } from '../../../worker/delivery/entitlement-templates'
import { readUserAccess } from '../../../worker/delivery/user-access'
import { getSubscriptionPlanSummary, operateSubscriptionPlan, savePlan, deletePlan, listPlans } from '../../../worker/delivery/plans'
import { setEmailVerificationDeliverer } from '../../../worker/accounts/email'
import { putSetting, putRegistrationMode } from '../../../worker/db/settings-repository'
import { bindFixtureTemplate, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

const NOW = '2026-01-01T00:00:00.000Z'
const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`,init)
let cookie: string
beforeEach(async () => {
  await setupContractedAdmin()
  cookie = await login()
})
afterEach(() => setEmailVerificationDeliverer(null))
async function linkPlan(planId: string, groupIds: string[] = []) {
  if (!groupIds.length) {
    await env.DB.prepare("INSERT OR IGNORE INTO groups (id,name,created_at,updated_at) VALUES ('grp_999','Plan fixture',?,?)").bind(NOW, NOW).run()
    groupIds = ['grp_999']
  }
  const template = await createEntitlementTemplate(env.DB, {
    name: 'Plan authorization', description: '', allowRedemption: false,
    config: { groupIds, nodeIds: [], duration: { unit: 'month', value: 1 }, quotaBytes: null,
      resetPolicy: 'none', limits: { speedLimitMbps: 0 } },
  }, 'usr_1')
  expect((await admin(`/api/admin/plans/${planId}/entitlement-template`, { templateId: template.id }, 'PUT')).status).toBe(200)
}
async function makePlan(days = 30, linked = true) {
  const plan = await savePlan(env.DB, { name: 'Standard', groupIds: [], durationDays: days, trafficGb: 100, speedLimitMbps: 20, deviceLimit: 3 })
  if (linked) await linkPlan(plan.id)
  return plan
}
async function operationInput() {
  return { requestId: crypto.randomUUID(), expectedRevision: (await readUserAccess(env.DB, { userId: 'usr_1' }))?.revision ?? 0 }
}
async function operate(action: 'grant' | 'renew' | 'switch' | 'revoke', planId?: string, _note = '', now?: string) {
  const { requestId, expectedRevision } = await operationInput()
  return operateSubscriptionPlan(env, 'usr_1', action, planId, '', now, 'usr_1', requestId, expectedRevision)
}
const admin = (path: string, body: unknown, method = 'POST') => fetchApi(path,withCookie(cookie,jsonRequest(body,{ method })))

describe('central entitlement decisions and operations', () => {
  it('reports none, active, exact-boundary expiry, revoked and pending', async () => {
    expect((await getSubscriptionPlanSummary(env.DB,'usr_1',NOW)).state).toBe('none')
    const plan = await makePlan(1)
    const granted = await operate('grant',plan.id,'note',NOW)
    expect(granted.current).toMatchObject({ source: 'admin',startsAt: NOW,expiresAt: '2026-01-02T00:00:00.000Z' })
    expect((await getSubscriptionPlanSummary(env.DB,'usr_1','2025-12-31T23:59:59.999Z')).state).toBe('pending')
    expect((await getSubscriptionPlanSummary(env.DB,'usr_1','2026-01-02T00:00:00.000Z')).state).toBe('expired')
    await operate('revoke',undefined,'',NOW)
    expect((await getSubscriptionPlanSummary(env.DB,'usr_1',NOW)).state).toBe('revoked')
  })
  it('stacks renewal on future expiry and on now after expiry', async () => {
    const plan = await makePlan(10)
    await operate('grant',plan.id,'',NOW)
    const first = await operate('renew',undefined,'','2026-01-05T00:00:00.000Z')
    expect(first.current?.expiresAt).toBe('2026-01-21T00:00:00.000Z')
    const second = await operate('renew',undefined,'','2026-02-01T00:00:00.000Z')
    expect(second.current?.expiresAt).toBe('2026-02-11T00:00:00.000Z')
  })
  it('serializes concurrent renewals without losing days', async () => {
    const plan = await makePlan(1)
    await operate('grant',plan.id,'',NOW)
    const { expectedRevision } = await operationInput()
    const renew = () => operateSubscriptionPlan(env, 'usr_1', 'renew', undefined, '', NOW, 'usr_1', crypto.randomUUID(), expectedRevision)
    const outcomes = await Promise.allSettled([renew(), renew()])
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    await operate('renew', undefined, '', NOW)
    expect((await getSubscriptionPlanSummary(env.DB,'usr_1',NOW)).current?.expiresAt).toBe('2026-01-04T00:00:00.000Z')
  })
  it('switches the plan by replacing the previous binding and rejects duplicate grants', async () => {
    const plan = await makePlan()
    await operate('grant',plan.id,'',NOW)
    await expect(operate('grant',plan.id,'',NOW)).rejects.toThrow()
    const other = await makePlan(7)
    const changed = await operate('switch',other.id,'changed',NOW)
    expect(changed.current?.planId).toBe(other.id)
    const rows = await env.DB.prepare("SELECT p.plan_id FROM user_template_bindings b JOIN entitlement_plan_policies p ON p.template_id=b.template_id WHERE b.user_id=? AND b.status='active'").bind('usr_1').all<{ plan_id: string }>()
    expect(rows.results).toEqual([{ plan_id: other.id }])
  })
  it('disables plan operations and preserves referenced plans', async () => {
    const plan = await makePlan()
    await operate('grant',plan.id,'',NOW)
    await savePlan(env.DB,{ ...plan,enabled: false },plan.id)
    expect((await getSubscriptionPlanSummary(env.DB,'usr_1',NOW)).state).toBe('disabled')
    await expect(operate('renew',undefined,'',NOW)).rejects.toThrow()
    await expect(deletePlan(env.DB,plan.id)).rejects.toThrow()
    await operate('revoke',undefined,'',NOW)
    await expect(deletePlan(env.DB,plan.id)).rejects.toThrow()
  })
  it('validates limits, group references and empty operations', async () => {
    await expect(savePlan(env.DB,{ name: 'Bad',groupIds: [],durationDays: 0 })).rejects.toThrow()
    await expect(savePlan(env.DB,{ name: 'Bad',groupIds: ['grp_999'],durationDays: 1 })).rejects.toThrow()
    await expect(operate('renew')).rejects.toThrow()
    await expect(operate('switch','missing')).rejects.toThrow()
    await expect(operateSubscriptionPlan(env,'usr_999','grant','missing')).rejects.toThrow()
  })
})

async function deliveryFixture() {
  const source = await admin('/api/admin/catalog/sources',{ type: 'manual',name: 'Source',content: `ss://${btoa('aes-128-gcm:password')}@allowed.example.com:8388#Allowed\nhysteria2://secret@excluded.example.com:443#Excluded` })
  expect(source.status).toBe(201)
  const catalog = await (await fetchApi('/api/admin/catalog',withCookie(cookie))).json() as { nodes: Array<{ id: string; displayName: string }> }
  const ids: string[] = []
  for (const node of catalog.nodes) {
    const result = await admin('/api/admin/catalog/groups',{ name: node.displayName,sourceIds: [],includedNodeIds: [node.id],excludedNodeIds: [],nodeOrder: [] })
    expect(result.status).toBe(201)
    ids.push(((await result.json()) as { group: { id: string } }).group.id)
  }
  return ids
}
async function download(client: string) {
  const response = await fetchApi('/api/user/subscription', withCookie(cookie))
  expect(response.status).toBe(200)
  const { subscriptionUrl } = await response.json<{ subscriptionUrl: string }>()
  return fetchApi(`${new URL(subscriptionUrl).pathname}/${client}`)
}
describe('live unified subscription gating', () => {
  it('delivers groups without a plan and keeps empty output semantics', async () => {
    expect((await download('generic')).status).toBe(404)
    const groupIds = await deliveryFixture()
    await bindFixtureTemplate('usr_1', { name: 'Manual authorization', groupIds })
    const response = await download('mihomo')
    expect(response.status).toBe(200)
    expect(parseYaml(await response.text()).proxies).toHaveLength(2)
    expect(await (await fetchApi('/api/account/entitlement', withCookie(cookie))).json()).toMatchObject({ state: 'none' })
  })
  it('removes expired and revoked plan nodes from delivery', async () => {
    const groupIds = await deliveryFixture()
    const plan = await savePlan(env.DB, { name: 'Expiring', groupIds, durationDays: 1 })
    await linkPlan(plan.id, groupIds)
    await operate('grant', plan.id, '', NOW)
    expect((await getSubscriptionPlanSummary(env.DB, 'usr_1')).state).toBe('expired')
    expect((await download('mihomo')).status).toBe(410)
    await operate('renew')
    const live = await download('mihomo')
    expect(live.status).toBe(200)
    expect(parseYaml(await live.text()).proxies).toHaveLength(2)
    await operate('revoke')
    expect((await download('mihomo')).status).toBe(404)
  })
})

describe('admin routes and registration trials', () => {
  it('exposes only enabled public plan fields in management order and requires authentication', async () => {
    expect((await fetchApi('/api/account/plans')).status).toBe(401)
    const later = await savePlan(env.DB,{ name: 'Later', groupIds: [], durationDays: 30, sortOrder: 20 })
    const first = await savePlan(env.DB,{ name: 'First', description: 'Public description', groupIds: [], durationDays: 7, sortOrder: -1 })
    await savePlan(env.DB,{ name: 'Hidden', groupIds: [], durationDays: 1, enabled: false })
    const result = await fetchApi('/api/account/plans',withCookie(cookie))
    expect(result.status).toBe(200)
    const body = await result.json() as { plans: Array<Record<string, unknown>> }
    expect(body.plans.map((plan) => plan.id)).toEqual([first.id,later.id])
    expect(Object.keys(body.plans[0]).sort()).toEqual(['id','name','description','durationDays','trafficGb','speedLimitMbps','deviceLimit'].sort())
    expect(body.plans[0]).toMatchObject({ description: 'Public description', durationDays: 7 })
    expect((await fetchApi('/api/account/plans',withCookie(cookie,jsonRequest({}, { method: 'POST' })))).status).toBe(404)
    await savePlan(env.DB,{ ...first, enabled: false },first.id)
    expect(await (await fetchApi('/api/account/plans',withCookie(cookie))).json()).toMatchObject({ plans: [{ id: later.id }] })
  })
  it('protects plan management and supports CRUD and entitlement actions', async () => {
    expect((await fetchApi('/api/admin/plans')).status).toBe(401)
    const created = await admin('/api/admin/plans',{ name: 'Plan',durationDays: 30,groupIds: [] })
    expect(created.status).toBe(201)
    const plan = ((await created.json()) as { plan: { id: string } }).plan
    await linkPlan(plan.id)
    expect((await admin(`/api/admin/users/usr_1/entitlement`,{ ...await operationInput(), action: 'grant',planId: plan.id })).status).toBe(200)
    const detail = await fetchApi('/api/admin/users/usr_1',withCookie(cookie))
    expect(await detail.json()).toMatchObject({ entitlement: { state: 'active' } })
    expect((await admin(`/api/admin/users/usr_1/entitlement`,{ ...await operationInput(), action: 'renew' })).status).toBe(200)
    expect((await admin(`/api/admin/users/usr_1/entitlement`,{ ...await operationInput(), action: 'revoke' })).status).toBe(200)
    expect((await admin(`/api/admin/plans/${plan.id}`,{},'DELETE')).status).toBe(409)
    const unused = await makePlan(30, false)
    await deletePlan(env.DB,unused.id)
    expect((await listPlans(env.DB)).some((p) => p.id === unused.id)).toBe(false)
  })
  it('grants a configured trial atomically on successful registration', async () => {
    const plan = await makePlan(30)
    await putSetting(env.DB,'trial_plan_id',plan.id); await putSetting(env.DB,'trial_days',3)
    await putSetting(env.DB,'next_user_id',2); await putSetting(env.DB,'accounts_revision',1)
    await putRegistrationMode(env.DB,'open')
    let code = ''
    setEmailVerificationDeliverer(async (message) => { code = message.code })
    expect((await fetchApi('/api/register/send-code',jsonRequest({ email: 'trial@example.com' }))).status).toBe(200)
    const registration = await fetchApi('/api/register',jsonRequest({ username: 'trialuser',password: 'trial user password 123',email: 'trial@example.com',code }))
    expect(registration.status).toBe(201)
    const user = ((await registration.json()) as { user: { id: string } }).user
    const rights = await getSubscriptionPlanSummary(env.DB,user.id)
    expect(rights.current).toMatchObject({ source: 'trial',planId: plan.id })
    expect(Date.parse(rights.current!.expiresAt!) - Date.parse(rights.current!.startsAt)).toBe(3 * 86400000)
    const again = await fetchApi('/api/register',jsonRequest({ username: 'trialother',password: 'trial user password 123',email: 'trial@example.com',code }))
    expect(again.status).not.toBe(201)
    expect((await env.DB.prepare("SELECT count(*) AS count FROM user_template_bindings WHERE user_id=?").bind(user.id).first<{ count: number }>())?.count).toBe(1)
  })
  it('disables trial when either setting is empty', async () => {
    const { trialSubscriptionStatements } = await import('../../../worker/delivery/plans')
    expect(await trialSubscriptionStatements(env,'usr_1',NOW)).toEqual([])
    const plan = await makePlan()
    await putSetting(env.DB,'trial_plan_id',plan.id)
    expect(await trialSubscriptionStatements(env,'usr_1',NOW)).toEqual([])
    await putSetting(env.DB,'trial_days',3)
    await savePlan(env.DB,{ ...plan,enabled: false },plan.id)
    expect(await trialSubscriptionStatements(env,'usr_1',NOW)).toEqual([])
  })
})
