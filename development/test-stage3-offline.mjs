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
const temp = await mkdtemp(join(tmpdir(),'stage3-test-'))
const output = join(temp,'worker.mjs')
await build({ stdin: { contents: `export { userAnchorStatement } from './worker/db/ensure-users.ts'; export { readAccounts, writeAccounts } from './worker/accounts/repository.ts'; export * from './worker/admin/service.ts'; export * from './worker/admin/templates.ts'; export * from './worker/admin/audit.ts'; export * from './worker/accounts/email.ts'; export { app } from './worker/app.ts'; export * from './worker/entitlements/service.ts'; export { setEmailVerificationDeliverer } from './worker/accounts/email.ts'; export { putSetting, putRegistrationMode } from './worker/db/settings-repository.ts'; export { markModuleReady, ACCOUNTS_D1_READY_KEY } from './worker/db/module-switch.ts';`,resolveDir: root },bundle: true,platform: 'node',format: 'esm',banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },outfile: output,plugins: [{ name: 'worker-bindings',setup(builder) {
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
    run: async () => { const result = statement.run(...values); return { success: true,results: [],meta: { changes: Number(result.changes) } } },
  })
  return create([])
}, async batch(statements) {
  sqlite.exec('BEGIN')
  try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result }
  catch (error) { sqlite.exec('ROLLBACK'); throw error }
} }
const values = new Map()
const kv = { async get(key,type) { const value = values.get(key) ?? null; return type === 'json' && value !== null ? JSON.parse(value) : value },async put(key,value) { values.set(key,value) },async delete(key) { values.delete(key) },async list({ prefix = '' } = {}) { return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),list_complete: true } } }
globalThis.__entitlementEnv = { DB: db,DATA: kv }
const env = globalThis.__entitlementEnv
const w = await import(pathToFileURL(output).href)
const NOW = '2026-01-01T00:00:00.000Z'
let cookie = ''
const request = async (path,body,method = body === undefined ? 'GET' : 'POST',auth = true) => w.app.fetch(new Request(`https://subpanel.test${path}`,{ method,headers: { ...(auth ? { cookie } : {}),origin: 'https://subpanel.test',...(body === undefined ? {} : { 'content-type': 'application/json' }) },body: body === undefined ? undefined : JSON.stringify(body) }),env)
try {
 await test('0010 upgrades legacy audit rows and preserves actor after deletion',async()=>{
 const files=(await readdir(resolve(root,'migrations'))).filter(f=>f.endsWith('.sql')).sort()
 for(const file of files.filter(f=>!f.startsWith('0010'))) sqlite.exec(await readFile(resolve(root,'migrations',file),'utf8'))
 sqlite.exec(`INSERT INTO audit_logs(created_at,action,entity_type,detail) VALUES('${NOW}','legacy','users','{}')`)
 sqlite.exec(await readFile(resolve(root,'migrations/0010_stage3_admin.sql'),'utf8'))
 assert.equal(sqlite.prepare("SELECT target_type FROM audit_logs WHERE action='legacy'").get().target_type,'users')
 assert.equal((await w.templateContent(db,'broadcast',{subject:'Hi',body:'<script>'})).html,'<p>&lt;script&gt;</p>')
 })
 await test('admin authentication and mutation audit hooks',async()=>{
 assert.equal((await request('/api/setup',{username:'admin',password:'correct horse battery staple'})).status,201)
 const login=await request('/api/login',{username:'admin',password:'correct horse battery staple'})
 cookie=login.headers.get('set-cookie').split(';')[0]
 await w.userAnchorStatement(db,(await w.readAccounts(env)).users[0]).run()
 assert.equal((await request('/api/admin/jobs/expiry-reminders',undefined,'POST',false)).status,401)
 const response=await request('/api/admin/plans',{name:'Test',groupIds:[],durationDays:2})
 assert.equal(response.status,201)
 const logs=await (await request('/api/admin/audit-logs?action=post.plans&pageSize=1')).json()
 assert.equal(logs.pagination.total,1);assert.equal(logs.logs.length,1)
 const actor=logs.logs[0].actor_user_id
 assert.equal((await (await request(`/api/admin/audit-logs?actor=${actor}&pageSize=1&page=2`)).json()).logs.length,0)
 assert.equal((await (await request('/api/admin/audit-logs?actor=missing')).json()).pagination.total,0)
 })
 await test('audit metadata records settings and entitlement actions without secrets',async()=>{
 assert.equal((await request('/api/admin/system/reminders',{reminder_days:3},'PUT')).status,200)
 const invitation=await request('/api/admin/invites',{username:'invitee'})
 assert.equal(invitation.status,201)
 const created=await invitation.json()
 assert.ok(created.invite.id)
 const accounts=await w.readAccounts(env)
 const id='usr_99'
 await w.writeAccounts(env,{...accounts,nextUserId:100,users:[...accounts.users,{...accounts.users[0],id,username:'audituser',role:'user'}]})
 assert.equal((await request(`/api/admin/users/${id}`,{enabled:false},'PATCH')).status,200)
 const rows=sqlite.prepare("SELECT * FROM audit_logs WHERE target_type='users'").all()
 assert.ok(rows.some(row=>row.target_id===id && JSON.parse(row.detail).enabled===false))
 assert.ok(!JSON.stringify(sqlite.prepare('SELECT detail FROM audit_logs').all()).includes('correct horse'))
 const planId=sqlite.prepare('SELECT id FROM plans').get().id
 assert.equal((await request(`/api/admin/users/${id}/entitlement`,{action:'grant',planId})).status,200)
 assert.ok(sqlite.prepare("SELECT id FROM audit_logs WHERE action='post.users.entitlement.grant'").get())
 assert.equal((await request(`/api/admin/users/${id}/entitlement`,{action:'revoke'})).status,200)
 assert.ok(sqlite.prepare("SELECT id FROM audit_logs WHERE action='post.users.entitlement.revoke'").get())
 // Keep the subsequent statistics fixture isolated.
 sqlite.prepare('DELETE FROM user_entitlements WHERE user_id=?').run(id)
 sqlite.prepare('DELETE FROM users WHERE id=?').run(id)
 })
 await test('templates list, update, rendering, delete and built-in verification fallback',async()=>{
 const templates=await (await request('/api/admin/mail-templates')).json();assert.equal(templates.templates.length,3)
 assert.equal((await request('/api/admin/mail-templates/verification',{subject:'Code {{code}}',body:'Hello {{username}} {{code}} {{purpose}}'},'PUT')).status,200)
 let captured
 globalThis.fetch=async (_url,init)=>{captured=JSON.parse(init.body);return new Response('{}')}
 env.RESEND_API_KEY='test';env.MAIL_FROM='test@example.com'
 await w.sendEmailVerificationCode({to:'u@example.com',code:'123456',username:'<U>',purpose:'register'})
 assert.equal(captured.subject,'Code 123456');assert.match(captured.html,/&lt;U&gt;/)
 assert.equal((await request('/api/admin/mail-templates/verification',undefined,'DELETE')).status,204)
 await w.sendEmailVerificationCode({to:'u@example.com',code:'654321'})
 assert.equal(captured.subject,'SubPanel 验证码 / Verification code');assert.match(captured.text,/valid for 10 minutes/)
 delete env.RESEND_API_KEY;delete env.MAIL_FROM
 assert.equal((await w.sendMail({to:'u@example.com',subject:'test',text:'test',html:'test'})).ok,false)
 })
 let plan
 await test('statistics use enabled accounts/plans and exact entitlement windows',async()=>{
 plan=sqlite.prepare('SELECT id FROM plans').get().id
 // Duplicate admin fixture as regular users, preserving real account columns.
 for(let i=2;i<=8;i++) sqlite.prepare(`INSERT INTO users SELECT ?,?,'user',1,password_algorithm,password_iterations,password_salt,password_hash,0,?, ?,email_verified_at,created_at,updated_at,NULL FROM users WHERE id='usr_1'`).run('usr_'+i,'user'+i,'u'+i+'@example.com','u'+i+'@example.com')
 const insert=db.prepare("INSERT INTO user_entitlements(id,user_id,plan_id,starts_at,expires_at,status,source,created_at,updated_at) VALUES(?,?,?,?,?,?,'admin',?,?)")
 const now=new Date(), iso=now.toISOString(),day=n=>new Date(now.getTime()+n*86400000).toISOString()
 for(const [id,start,end,status] of [[2,-1,1,'active'],[3,-1,8,'active'],[4,1,2,'active'],[5,-2,-1,'active'],[6,-1,1,'revoked'],[7,-1,1,'active'],[8,-1,1,'active']]) await insert.bind('ent_'+id,'usr_'+id,plan,day(start),day(end),status,iso,iso).run()
 sqlite.exec("UPDATE users SET enabled=0 WHERE id='usr_7'; UPDATE users SET deleted_at='2026-01-01' WHERE id='usr_8'")
 const stats=await w.adminStats(db,iso)
 assert.equal(stats.users,7);assert.equal(stats.activeEntitlements,2);assert.equal(stats.expiringEntitlements,1);assert.equal(stats.plans,1);assert.equal(stats.pendingTickets,0)
 assert.equal((await w.recipients(db,'active',iso)).length,2)
 assert.equal((await w.recipients(db,'expiring',iso)).length,1)
 sqlite.prepare('UPDATE plans SET enabled=0 WHERE id=?').run(plan)
 assert.equal((await w.adminStats(db,iso)).activeEntitlements,0)
 sqlite.prepare('UPDATE plans SET enabled=1 WHERE id=?').run(plan)
 })
 await test('broadcast counts real transport outcomes, throws and unconfigured credentials',async()=>{
 let calls=0
 const result=await w.broadcast(db,'usr_1',{subject:'Hello',body:'World',target:'active'},async()=>({ok:++calls===1,provider:'resend'}))
 assert.deepEqual([result.total,result.sent,result.failed,result.status],[2,1,1,'partial'])
 const failed=await w.broadcast(db,'usr_1',{subject:'Hello',body:'World',target:'active'},async()=>{throw Error('failed')})
 assert.equal(failed.failed,2);assert.equal(failed.status,'failed')
 const noConfig=await request('/api/admin/mail-broadcasts',{subject:'Hello',body:'World',target:'expiring'})
 assert.equal(noConfig.status,201);assert.equal((await noConfig.json()).status,'failed')
 const stored=sqlite.prepare('SELECT sent,failed,status FROM mail_broadcasts WHERE id=?').get(result.id)
 assert.equal(stored.sent,1);assert.equal(stored.failed,1);assert.equal(stored.status,'partial')
 })
 await test('reminders skip same expiry day, retry failures and permit renewed expiry',async()=>{
 const good=async()=>({ok:true,provider:'resend'})
 const first=await w.expiryReminders(db,good);assert.deepEqual(first,{processed:1,sent:1,failed:0,skipped:0})
 const second=await w.expiryReminders(db,good);assert.equal(second.skipped,1);assert.equal(second.sent,0)
 sqlite.exec("UPDATE user_entitlements SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',expires_at,'+1 day') WHERE id='ent_2'")
 const failure=await w.expiryReminders(db,async()=>({ok:false,provider:null}));assert.equal(failure.failed,1)
 assert.equal((await w.expiryReminders(db,good)).sent,1)
 assert.equal((await request('/api/admin/system/reminders',{reminder_days:9},'PUT')).status,200)
 assert.equal((await w.expiryReminders(db,good)).processed,2)
 assert.equal((await request('/api/admin/system/reminders',{reminder_days:0},'PUT')).status,422)
 })
} finally { sqlite.close(); await rm(temp,{recursive:true,force:true}) }
