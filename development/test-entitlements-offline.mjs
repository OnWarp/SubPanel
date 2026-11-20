// SQLite + in-process HTTP coverage when workerd's localhost socket is unavailable.
// The canonical Worker suites remain `npm test`.
import assert from 'node:assert/strict'
import { timingSafeEqual } from 'node:crypto'
// Workers adds this method to SubtleCrypto; Node exposes the same primitive separately.
crypto.subtle.timingSafeEqual = (a,b) => timingSafeEqual(Buffer.from(a),Buffer.from(b))
import { DatabaseSync } from 'node:sqlite'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const root = process.cwd()
const temp = await mkdtemp(join(tmpdir(),'entitlements-test-'))
const output = join(temp,'worker.mjs')
await build({ stdin: { contents: `export { app } from './worker/app.ts'; export * from './worker/delivery/plans.ts'; export { setEmailVerificationDeliverer } from './worker/accounts/email.ts'; export { putSetting, putRegistrationMode } from './worker/db/settings-repository.ts'; export { markModuleReady, ACCOUNTS_D1_READY_KEY } from './worker/db/module-switch.ts';`,resolveDir: root },bundle: true,platform: 'node',format: 'esm',banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },outfile: output,plugins: [{ name: 'worker-bindings',setup(builder) {
  builder.onResolve({ filter: /^cloudflare:/ },(args) => ({ path: args.path,namespace: 'worker-bindings' }))
  builder.onLoad({ filter: /.*/,namespace: 'worker-bindings' },(args) => ({ contents: args.path === 'cloudflare:workers' ? 'export const env = globalThis.__entitlementEnv' : 'export function connect() { throw new Error("SMTP is not used by this test") }' }))
} }] })
const sqlite = new DatabaseSync(':memory:')
sqlite.exec('PRAGMA foreign_keys=ON')
const db = { prepare(sql) {
  const statement = sqlite.prepare(sql)
  const create = (values) => ({
    bind: (...args) => create(args),
    first: async (column) => { const row = statement.get(...values); return column ? row?.[column] ?? null : row ?? null },
    all: async () => ({ results: statement.all(...values),success: true,meta: {} }),
    batch: async () => statement.columns().length ? { results: statement.all(...values), success: true, meta: {} } : create(values).run(),
    run: async () => { const result = statement.run(...values); return { success: true,results: [],meta: { changes: Number(result.changes) } } },
  })
  return create([])
}, async batch(statements) {
  sqlite.exec('BEGIN')
  try { const result = []; for (const statement of statements) result.push(await statement.batch()); sqlite.exec('COMMIT'); return result }
  catch (error) { sqlite.exec('ROLLBACK'); throw error }
} }
const values = new Map()
const kv = { async get(key,type) { const value = values.get(key) ?? null; return type === 'json' && value !== null ? JSON.parse(value) : value },async put(key,value) { values.set(key,value) },async delete(key) { values.delete(key) },async list({ prefix = '' } = {}) { return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),list_complete: true } } }
globalThis.__entitlementEnv = { DB: db,DATA: kv }
const env = globalThis.__entitlementEnv
const w = await import(pathToFileURL(output).href)
const NOW = '2026-01-01T00:00:00.000Z'
let cookie = ''
const request = async (path,body,method = body === undefined ? 'GET' : 'POST',auth = true) => w.app.fetch(new Request(`https://subpanel.test${path}`,{ method,headers: { ...(auth ? { cookie } : {}),origin: 'https://subpanel.test',...(body === undefined ? {} : { 'content-type': 'application/json' }) },body: body === undefined ? undefined : JSON.stringify(body) }),env,{ waitUntil() {} })
try {
  await test('migration 0008 upgrades the existing schema with constraints',async () => {
    for (const file of (await readdir(resolve(root,'migrations'))).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(await readFile(resolve(root,'migrations',file),'utf8'))
    assert.equal(sqlite.prepare("SELECT value FROM system_settings WHERE key='trial_plan_id'").get().value,'null')
    assert.throws(() => sqlite.prepare("INSERT INTO plans(id,name,duration_days,created_at,updated_at) VALUES('bad','Bad',0,?,?)").run(NOW,NOW))
  })
  await test('setup, login and admin route authorization',async () => {
    assert.equal((await request('/api/setup',{ username: 'admin',password: 'correct horse battery staple' })).status,201)
    const response = await request('/api/login',{ username: 'admin',password: 'correct horse battery staple' })
    assert.equal(response.status,200); cookie = response.headers.get('set-cookie').split(';')[0]
    assert.equal((await request('/api/admin/plans',undefined,'GET',false)).status,401)
  })
  // D1 catalog/delivery flags permit real API fixtures, with account anchors written by delivery.
  await w.markModuleReady(db,'catalog_d1_ready'); await w.markModuleReady(db,'delivery_d1_ready')
  let groupIds
  let token
  await test('real HTTP catalog and subscription creation produces an empty subscription without rights',async () => {
    const sourceResponse = await request('/api/admin/catalog/sources',{ type: 'manual',name: 'Source',content: `ss://${btoa('aes-128-gcm:password')}@allowed.example.com:8388#Allowed\nhysteria2://secret@excluded.example.com:443#Excluded` })
    assert.equal(sourceResponse.status,201)
    const catalog = await (await request('/api/admin/catalog')).json()
    groupIds = []
    for (const node of catalog.nodes) {
      const response = await request('/api/admin/catalog/groups',{ name: node.displayName,sourceIds: [],includedNodeIds: [node.id],excludedNodeIds: [],nodeOrder: [] })
      assert.equal(response.status,201); groupIds.push((await response.json()).group.id)
    }
    const response = await request('/api/admin/subscriptions',{ name: 'Entitled',userId: 'usr_1',groupIds })
    assert.equal(response.status,201); token = (await response.json()).token
    const download = await request(`/sub/${token}/mihomo`)
    assert.equal(download.status,422); assert.equal((await download.json()).error.details.reason,'noPlan')
    assert.equal((await (await request('/api/account/entitlement')).json()).state,'none')
  })
  let plan
  await test('plan CRUD validates input and records every limit',async () => {
    assert.equal((await request('/api/admin/plans',{ name: 'Invalid',durationDays: 0,groupIds: [] })).status,422)
    assert.equal((await request('/api/admin/plans',{ name: 'Invalid',durationDays: 1,groupIds: ['grp_999'] })).status,404)
    const response = await request('/api/admin/plans',{ name: 'Standard',durationDays: 10,groupIds,trafficGb: 100,speedLimitMbps: 20,deviceLimit: 3 })
    assert.equal(response.status,201); plan = (await response.json()).plan
    assert.equal(plan.trafficGb,100); assert.equal(plan.deviceLimit,3)
  })
  await test('grant, pending, exact expiry boundary, stacked and expired renewal',async () => {
    const granted = await w.operateSubscriptionPlan(env,'usr_1','grant',plan.id,'',NOW)
    assert.equal(granted.current.expiresAt,'2026-01-11T00:00:00.000Z')
    assert.equal((await w.getSubscriptionPlanSummary(db,'usr_1','2025-12-31T23:59:59.999Z')).state,'pending')
    assert.equal((await w.getSubscriptionPlanSummary(db,'usr_1','2026-01-11T00:00:00.000Z')).state,'expired')
    assert.equal((await w.operateSubscriptionPlan(env,'usr_1','renew',undefined,'','2026-01-05T00:00:00.000Z')).current.expiresAt,'2026-01-21T00:00:00.000Z')
    assert.equal((await w.operateSubscriptionPlan(env,'usr_1','renew',undefined,'','2026-02-01T00:00:00.000Z')).current.expiresAt,'2026-02-11T00:00:00.000Z')
    const download = await request(`/sub/${token}/mihomo`); assert.equal(download.status,410)
  })
  await test('live renewal enables only plan groups, supported speed injection and unsupported formats',async () => {
    await w.operateSubscriptionPlan(env,'usr_1','renew')
    const catalog = await (await request('/api/admin/catalog')).json()
    const hyIndex = catalog.nodes.findIndex((node) => node.displayName === 'Excluded')
    plan = await w.savePlan(db,{ ...plan,groupIds: [groupIds[hyIndex]] },plan.id)
    const response = await request(`/sub/${token}/mihomo`)
    assert.equal(response.status,200)
    const body = await response.text(); assert.match(body,/Excluded/); assert.doesNotMatch(body,/allowed.example.com/); assert.match(body,/up: 20/); assert.match(body,/down: 20/)
    const generic = await request(`/sub/${token}/generic`); assert.equal(generic.status,200); assert.doesNotMatch(atob(await generic.text()),/allowed.example.com/)
    const status = await (await request('/api/admin/users/usr_1')).json(); assert.equal(status.entitlement.current.plan.id,plan.id)
  })
  await test('plan edits, switch and revocation take effect despite cached artifacts',async () => {
    await assert.rejects(w.operateSubscriptionPlan(env,'usr_1','grant',plan.id))
    await assert.rejects(w.deletePlan(db,plan.id))
    const other = await w.savePlan(db,{ name: 'Other',durationDays: 1,groupIds: [] })
    assert.equal((await w.operateSubscriptionPlan(env,'usr_1','switch',other.id)).current.planId,other.id)
    assert.equal((await request(`/sub/${token}/mihomo`)).status,422)
    assert.equal(sqlite.prepare("SELECT count(*) as n FROM subscriptions WHERE plan_revoked=1").get().n,0)
    await w.operateSubscriptionPlan(env,'usr_1','revoke')
    assert.equal((await (await request('/api/account/entitlement')).json()).state,'revoked')
    assert.equal((await request(`/sub/${token}/mihomo`)).status,404)
    await w.savePlan(db,{ ...plan,enabled: false },plan.id)
    await assert.rejects(w.operateSubscriptionPlan(env,'usr_1','grant',plan.id))
  })
  await test('another subscription owned by the same user has its own plan and ignores the legacy table', async () => {
    const other = await w.savePlan(db,{ name: 'Separate',durationDays: 12,groupIds,trafficGb: 42 })
    const requestBody = { name: 'Separate link',userId: 'usr_1',groupIds }
    const noPlan = await (await request('/api/admin/subscriptions',requestBody)).json()
    const expires = new Date(Date.now() + 86400000).toISOString()
    sqlite.prepare(`INSERT INTO user_entitlements_legacy
      (id,user_id,plan_id,starts_at,expires_at,status,source,created_at,updated_at)
      VALUES ('no-longer-read','usr_1',?,?,?,'active','trial',?,?)`).run(other.id,NOW,expires,NOW,NOW)
    const blocked = await request(`/sub/${noPlan.token}/mihomo`)
    assert.equal(blocked.status,422)
    assert.equal((await blocked.json()).error.details.reason,'noPlan')
    const assign = await request(`/api/admin/subscriptions/${noPlan.subscription.id}`,{ planId: other.id,expiresAt: Date.parse(expires) },'PATCH')
    assert.equal(assign.status,200)
    const assigned = (await assign.json()).subscription
    assert.equal(assigned.planId,other.id)
    assert.equal(assigned.trafficGb,42)
    assert.equal(assigned.expiresAt,Date.parse(expires))
    assert.equal((await request(`/sub/${noPlan.token}/mihomo`)).status,200)
    assert.equal((await request(`/sub/${token}/mihomo`)).status,404)
  })
  await test('a migrated subscription acquires one real token on its first authenticated view', async () => {
    const planned = await (await request('/api/admin/subscriptions',{ name: 'Migrated',userId: 'usr_1',groupIds })).json()
    const { id } = planned.subscription
    sqlite.prepare("UPDATE subscriptions SET encrypted_token='{}',token_prefix='pending_' WHERE id=?").run(id)
    const stored = () => sqlite.prepare('SELECT token_hash,encrypted_token,revision FROM subscriptions WHERE id=?').get(id)
    const before = stored()
    assert.equal((await request(`/sub/${planned.token}/generic`)).status,404)
    assert.equal((await request('/api/account/subscriptions')).status,200)
    const after = stored()
    assert.notEqual(after.token_hash,before.token_hash)
    assert.match(after.encrypted_token,/AES-GCM/)
    assert.equal(after.revision,before.revision + 1)
    assert.equal((await request('/api/account/subscriptions')).status,200)
    assert.deepEqual(stored(),after)
  })
  await test('registration grants exactly one configured trial in its transaction',async () => {
    const trial = await w.savePlan(db,{ name: 'Trial',durationDays: 30,groupIds })
    await w.putSetting(db,'trial_plan_id',trial.id); await w.putSetting(db,'trial_days',3)
    await w.markModuleReady(db,w.ACCOUNTS_D1_READY_KEY)
    await w.putSetting(db,'next_user_id',2); await w.putSetting(db,'accounts_revision',1)
    await w.putRegistrationMode(db,'open')
    let code
    w.setEmailVerificationDeliverer(async (message) => { code = message.code })
    assert.equal((await request('/api/register/send-code',{ email: 'trial@example.com' })).status,200)
    const input = { username: 'trialuser',password: 'trial user password 123',email: 'trial@example.com',code }
    const response = await request('/api/register',input)
    assert.equal(response.status,201)
    const user = (await response.json()).user
    const rights = await w.getSubscriptionPlanSummary(db,user.id)
    assert.equal(rights.current.source,'trial'); assert.equal(rights.current.planId,trial.id)
    assert.equal(Date.parse(rights.current.expiresAt) - Date.parse(rights.current.startsAt),3 * 86400000)
    assert.notEqual((await request('/api/register',input)).status,201)
    assert.equal(sqlite.prepare("SELECT count(*) as n FROM subscriptions WHERE plan_source='trial'").get().n,1)
    await assert.rejects(w.deletePlan(db,trial.id))
  })
  await test('trial insertion failure rolls back registration and verification consumption',async () => {
    let code
    w.setEmailVerificationDeliverer(async (message) => { code = message.code })
    assert.equal((await request('/api/register/send-code',{ email: 'rollback@example.com' })).status,200)
    sqlite.exec("CREATE TRIGGER reject_trial BEFORE INSERT ON subscriptions BEGIN SELECT RAISE(ABORT, 'trial failure'); END")
    const input = { username: 'rollbackuser',password: 'rollback password 123',email: 'rollback@example.com',code }
    const response = await request('/api/register',input)
    assert.equal(response.status,500)
    assert.equal(sqlite.prepare("SELECT count(*) as n FROM users WHERE username='rollbackuser'").get().n,0)
    assert.equal(sqlite.prepare("SELECT consumed_at FROM email_verifications WHERE email='rollback@example.com'").get().consumed_at,null)
    sqlite.exec('DROP TRIGGER reject_trial')
    assert.equal((await request('/api/register',input)).status,201)
  })
  await test('trial off or disabled plan produces no grant',async () => {
    await w.putSetting(db,'trial_days',null)
    assert.deepEqual(await w.trialSubscriptionStatements(env,'usr_99',NOW),[])
    await w.putSetting(db,'trial_plan_id',plan.id); await w.putSetting(db,'trial_days',3)
    assert.deepEqual(await w.trialSubscriptionStatements(env,'usr_99',NOW),[])
  })
} finally {
  sqlite.close(); await rm(temp,{ recursive: true,force: true }); delete globalThis.__entitlementEnv
}
