import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { getUserEntitlement, operateEntitlement, savePlan, deletePlan, listPlans } from '../../../worker/entitlements/service'
import { userAnchorStatement } from '../../../worker/db/ensure-users'
import { readAccounts } from '../../../worker/accounts/repository'
import { setEmailVerificationDeliverer } from '../../../worker/accounts/email'
import { ACCOUNTS_D1_READY_KEY, markModuleReady } from '../../../worker/db/module-switch'
import { putSetting, putRegistrationMode } from '../../../worker/db/settings-repository'
import { clearAccountsStorage } from '../../../worker/accounts/d1-repository'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const NOW = '2026-01-01T00:00:00.000Z'
const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`,init)
let cookie: string
beforeEach(async () => {
  await resetData(); await enableD1Modules(); await clearAccountsStorage(env.DB); await setupAdmin(); cookie = await login()
  await env.DB.prepare('DELETE FROM user_entitlements').run()
  await env.DB.prepare('DELETE FROM plans').run()
  await putSetting(env.DB,'trial_plan_id',null); await putSetting(env.DB,'trial_days',null)
  await userAnchorStatement(env.DB,(await readAccounts(env)).users[0]).run()
})
afterEach(() => setEmailVerificationDeliverer(null))
const makePlan = (days = 30) => savePlan(env.DB,{ name: 'Standard',groupIds: [],durationDays: days,trafficGb: 100,speedLimitMbps: 20,deviceLimit: 3 })
const admin = (path: string, body: unknown, method = 'POST') => fetchApi(path,withCookie(cookie,jsonRequest(body,{ method })))

describe('central entitlement decisions and operations', () => {
  it('reports none, active, exact-boundary expiry, revoked and pending', async () => {
    expect((await getUserEntitlement(env.DB,'usr_1',NOW)).state).toBe('none')
    const plan = await makePlan(1)
    const granted = await operateEntitlement(env.DB,'usr_1','grant',plan.id,'note',NOW)
    expect(granted.current).toMatchObject({ source: 'admin',note: 'note',startsAt: NOW,expiresAt: '2026-01-02T00:00:00.000Z' })
    expect((await getUserEntitlement(env.DB,'usr_1','2025-12-31T23:59:59.999Z')).state).toBe('pending')
    expect((await getUserEntitlement(env.DB,'usr_1','2026-01-02T00:00:00.000Z')).state).toBe('expired')
    await operateEntitlement(env.DB,'usr_1','revoke',undefined,'',NOW)
    expect((await getUserEntitlement(env.DB,'usr_1',NOW)).state).toBe('revoked')
  })
  it('stacks renewal on future expiry and on now after expiry', async () => {
    const plan = await makePlan(10)
    await operateEntitlement(env.DB,'usr_1','grant',plan.id,'',NOW)
    const first = await operateEntitlement(env.DB,'usr_1','renew',undefined,'','2026-01-05T00:00:00.000Z')
    expect(first.current?.expiresAt).toBe('2026-01-21T00:00:00.000Z')
    const second = await operateEntitlement(env.DB,'usr_1','renew',undefined,'','2026-02-01T00:00:00.000Z')
    expect(second.current?.expiresAt).toBe('2026-02-11T00:00:00.000Z')
  })
  it('serializes concurrent renewals without losing days', async () => {
    const plan = await makePlan(1)
    await operateEntitlement(env.DB,'usr_1','grant',plan.id,'',NOW)
    await Promise.all([operateEntitlement(env.DB,'usr_1','renew',undefined,'',NOW),operateEntitlement(env.DB,'usr_1','renew',undefined,'',NOW)])
    expect((await getUserEntitlement(env.DB,'usr_1',NOW)).current?.expiresAt).toBe('2026-01-04T00:00:00.000Z')
  })
  it('replaces a plan with an audited revoked row and rejects duplicate grants', async () => {
    const plan = await makePlan()
    await operateEntitlement(env.DB,'usr_1','grant',plan.id,'',NOW)
    await expect(operateEntitlement(env.DB,'usr_1','grant',plan.id,'',NOW)).rejects.toThrow()
    const other = await makePlan(7)
    const changed = await operateEntitlement(env.DB,'usr_1','switch',other.id,'changed',NOW)
    expect(changed.current?.planId).toBe(other.id)
    const rows = await env.DB.prepare('SELECT status FROM user_entitlements WHERE user_id = ?').bind('usr_1').all<{ status: string }>()
    expect(rows.results.map((r) => r.status).sort()).toEqual(['active','revoked'])
  })
  it('disables access with the plan and preserves referenced plans', async () => {
    const plan = await makePlan()
    await operateEntitlement(env.DB,'usr_1','grant',plan.id,'',NOW)
    await savePlan(env.DB,{ ...plan,enabled: false },plan.id)
    expect((await getUserEntitlement(env.DB,'usr_1',NOW)).state).toBe('disabled')
    await expect(operateEntitlement(env.DB,'usr_1','renew',undefined,'',NOW)).rejects.toThrow()
    await expect(deletePlan(env.DB,plan.id)).rejects.toThrow()
    await operateEntitlement(env.DB,'usr_1','revoke',undefined,'',NOW)
    await expect(deletePlan(env.DB,plan.id)).rejects.toThrow()
  })
  it('validates limits, group references and empty operations', async () => {
    await expect(savePlan(env.DB,{ name: 'Bad',groupIds: [],durationDays: 0 })).rejects.toThrow()
    await expect(savePlan(env.DB,{ name: 'Bad',groupIds: ['grp_999'],durationDays: 1 })).rejects.toThrow()
    await expect(operateEntitlement(env.DB,'usr_1','renew')).rejects.toThrow()
    await expect(operateEntitlement(env.DB,'usr_1','switch','missing')).rejects.toThrow()
    await expect(operateEntitlement(env.DB,'usr_999','grant','missing')).rejects.toThrow()
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
  const response = await admin('/api/admin/subscriptions',{ userId: 'usr_1',name: 'Rights',groupIds: ids,defaultClient: 'mihomo' })
  expect(response.status).toBe(201)
  return { token: ((await response.json()) as { token: string }).token,ids,catalog }
}
const proxies = async (token: string) => {
  const response = await fetchApi(`/sub/${token}/mihomo`)
  expect(response.status).toBe(200)
  return (parseYaml(await response.text()) as { proxies: Array<Record<string, unknown>> }).proxies
}
describe('live subscription gating', () => {
  it('gates compiled artifacts as well as public downloads', async () => {
    const { token,ids } = await deliveryFixture()
    const { readDelivery } = await import('../../../worker/delivery/repository')
    const { compileSubscription } = await import('../../../worker/delivery/compiler')
    const subscription = (await readDelivery(env)).subscriptions[0]
    expect((await compileSubscription(env,subscription)).every((a) => a.outputNodes === 0)).toBe(true)
    const plan = await savePlan(env.DB,{ name: 'Compilation',groupIds: [ids[0]],durationDays: 30 })
    await operateEntitlement(env.DB,'usr_1','grant',plan.id)
    const artifacts = await compileSubscription(env,subscription)
    expect(artifacts.find((a) => a.client === 'mihomo')?.outputNodes).toBe(1)
    expect((await proxies(token)).length).toBe(1)
  })
  it('returns format-native empty subscriptions without rights and reports none', async () => {
    const { token } = await deliveryFixture()
    expect(await proxies(token)).toEqual([])
    expect(await (await fetchApi(`/sub/${token}/generic`)).text()).toBe('')
    const status = await fetchApi('/api/account/entitlement',withCookie(cookie))
    expect(await status.json()).toMatchObject({ state: 'none',current: null })
  })
  it('returns empty for expired and revoked rights despite populated cached artifacts', async () => {
    const { token,ids } = await deliveryFixture()
    const plan = await savePlan(env.DB,{ name: 'Expired',groupIds: ids,durationDays: 1 })
    await operateEntitlement(env.DB,'usr_1','grant',plan.id,'',NOW)
    expect(await proxies(token)).toEqual([])
    expect((await getUserEntitlement(env.DB,'usr_1')).state).toBe('expired')
    await operateEntitlement(env.DB,'usr_1','renew')
    expect((await proxies(token)).length).toBe(2)
    await operateEntitlement(env.DB,'usr_1','revoke')
    expect(await proxies(token)).toEqual([])
  })
  it('filters by plan groups, injects supported speed fields and reacts to plan edits', async () => {
    const { token,ids,catalog } = await deliveryFixture()
    const hyIndex = catalog.nodes.findIndex((n) => n.displayName === 'Excluded')
    const plan = await savePlan(env.DB,{ name: 'Limited',groupIds: [ids[hyIndex]],durationDays: 30,speedLimitMbps: 20 })
    await operateEntitlement(env.DB,'usr_1','grant',plan.id)
    expect(await proxies(token)).toEqual([expect.objectContaining({ name: 'Excluded',up: 20,down: 20 })])
    const generic = await fetchApi(`/sub/${token}/generic`)
    expect(generic.status).toBe(200)
    expect(atob(await generic.text())).not.toContain('allowed.example.com')
    await savePlan(env.DB,{ ...plan,groupIds: [] },plan.id)
    expect(await proxies(token)).toEqual([])
    await savePlan(env.DB,{ ...plan,enabled: false },plan.id)
    expect(await proxies(token)).toEqual([])
  })
})

describe('admin routes and registration trials', () => {
  it('protects plan management and supports CRUD and entitlement actions', async () => {
    expect((await fetchApi('/api/admin/plans')).status).toBe(401)
    const created = await admin('/api/admin/plans',{ name: 'Plan',durationDays: 30,groupIds: [] })
    expect(created.status).toBe(201)
    const plan = ((await created.json()) as { plan: { id: string } }).plan
    expect((await admin(`/api/admin/users/usr_1/entitlement`,{ action: 'grant',planId: plan.id })).status).toBe(200)
    const detail = await fetchApi('/api/admin/users/usr_1',withCookie(cookie))
    expect(await detail.json()).toMatchObject({ entitlement: { state: 'active' } })
    expect((await admin(`/api/admin/users/usr_1/entitlement`,{ action: 'renew' })).status).toBe(200)
    expect((await admin(`/api/admin/users/usr_1/entitlement`,{ action: 'revoke' })).status).toBe(200)
    expect((await admin(`/api/admin/plans/${plan.id}`,{},'DELETE')).status).toBe(409)
    const unused = await makePlan()
    await deletePlan(env.DB,unused.id)
    expect((await listPlans(env.DB)).some((p) => p.id === unused.id)).toBe(false)
  })
  it('grants a configured trial atomically on successful registration', async () => {
    const plan = await makePlan(30)
    await putSetting(env.DB,'trial_plan_id',plan.id); await putSetting(env.DB,'trial_days',3)
    await markModuleReady(env.DB,ACCOUNTS_D1_READY_KEY)
    await putSetting(env.DB,'next_user_id',2); await putSetting(env.DB,'accounts_revision',1)
    await putRegistrationMode(env.DB,'open')
    let code = ''
    setEmailVerificationDeliverer(async (message) => { code = message.code })
    expect((await fetchApi('/api/register/send-code',jsonRequest({ email: 'trial@example.com' }))).status).toBe(200)
    const registration = await fetchApi('/api/register',jsonRequest({ username: 'trialuser',password: 'trial user password 123',email: 'trial@example.com',code }))
    expect(registration.status).toBe(201)
    const user = ((await registration.json()) as { user: { id: string } }).user
    const rights = await getUserEntitlement(env.DB,user.id)
    expect(rights.current).toMatchObject({ source: 'trial',planId: plan.id })
    expect(Date.parse(rights.current!.expiresAt) - Date.parse(rights.current!.startsAt)).toBe(3 * 86400000)
    const again = await fetchApi('/api/register',jsonRequest({ username: 'trialother',password: 'trial user password 123',email: 'trial@example.com',code }))
    expect(again.status).not.toBe(201)
    expect((await env.DB.prepare("SELECT count(*) AS count FROM user_entitlements WHERE source='trial'").first<{ count: number }>())?.count).toBe(1)
  })
  it('disables trial when either setting is empty', async () => {
    const { trialGrantStatement } = await import('../../../worker/entitlements/service')
    expect(await trialGrantStatement(env.DB,'usr_1',NOW)).toBeNull()
    const plan = await makePlan()
    await putSetting(env.DB,'trial_plan_id',plan.id)
    expect(await trialGrantStatement(env.DB,'usr_1',NOW)).toBeNull()
    await putSetting(env.DB,'trial_days',3)
    await savePlan(env.DB,{ ...plan,enabled: false },plan.id)
    expect(await trialGrantStatement(env.DB,'usr_1',NOW)).toBeNull()
  })
})
