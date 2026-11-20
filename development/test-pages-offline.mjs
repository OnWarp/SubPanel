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
const temp = await mkdtemp(join(tmpdir(),'pages-test-'))
const output = join(temp,'worker.mjs')
await build({ stdin: { contents: `export { userAnchorStatement } from './worker/db/ensure-users.ts'; export { readAccounts, writeAccounts } from './worker/accounts/repository.ts'; export * from './worker/admin/service.ts'; export * from './worker/admin/templates.ts'; export * from './worker/admin/audit.ts'; export * from './worker/accounts/email.ts'; export { app } from './worker/app.ts'; export * from './worker/delivery/plans.ts'; export { setEmailVerificationDeliverer } from './worker/accounts/email.ts'; export { putSetting, putRegistrationMode } from './worker/db/settings-repository.ts'; export { markModuleReady, ACCOUNTS_D1_READY_KEY } from './worker/db/module-switch.ts';`,resolveDir: root },bundle: true,platform: 'node',format: 'esm',banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },outfile: output,plugins: [{ name: 'worker-bindings',setup(builder) {
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
let cookie = ''
const request = async (path,body,method = body === undefined ? 'GET' : 'POST',auth = true) => w.app.fetch(new Request(`https://subpanel.test${path}`,{ method,headers: { ...(auth ? { cookie } : {}),origin: 'https://subpanel.test',...(body === undefined ? {} : { 'content-type': 'application/json' }) },body: body === undefined ? undefined : JSON.stringify(body) }),env)
try {
 for (const file of (await readdir(resolve(root,'migrations'))).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(await readFile(resolve(root,'migrations',file),'utf8'))
 await test('public plan catalog is authenticated, read only, ordered, live and redacted for ordinary users',async()=>{
 assert.equal((await request('/api/setup',{username:'admin',password:'correct horse battery staple'})).status,201)
 const login=await request('/api/login',{username:'admin',password:'correct horse battery staple'})
 cookie=login.headers.get('set-cookie').split(';')[0]
 await w.userAnchorStatement(db,(await w.readAccounts(env)).users[0]).run()
 const accounts=await w.readAccounts(env)
 await w.writeAccounts(env,{...accounts,nextUserId:3,users:[...accounts.users,{...accounts.users[0],id:'usr_2',username:'reader',role:'user'}]})
 await w.userAnchorStatement(db,(await w.readAccounts(env)).users.find(user=>user.id==='usr_2')).run()
 const readerLogin=await request('/api/login',{username:'reader',password:'correct horse battery staple'})
 const readerCookie=readerLogin.headers.get('set-cookie').split(';')[0]
 const first=await w.savePlan(db,{name:'First',description:'Public',durationDays:7,groupIds:[],sortOrder:-10})
 const later=await w.savePlan(db,{name:'Later',durationDays:30,groupIds:[],sortOrder:20})
 await w.savePlan(db,{name:'Hidden',durationDays:1,groupIds:[],enabled:false})
 assert.equal((await request('/api/account/plans',undefined,'GET',false)).status,401)
 const adminCookie=cookie;cookie=readerCookie
 const response=await request('/api/account/plans');assert.equal(response.status,200)
 const body=await response.json()
 assert.deepEqual(body.plans.map(p=>p.id),[first.id,later.id])
 assert.deepEqual(Object.keys(body.plans[0]).sort(),['id','name','description','durationDays','trafficGb','speedLimitMbps','deviceLimit'].sort())
 assert.equal((await request('/api/account/plans',{})).status,404)
 assert.equal((await request('/api/admin/plans')).status,403)
 await w.savePlan(db,{...first,enabled:false},first.id)
 assert.deepEqual((await (await request('/api/account/plans')).json()).plans.map(p=>p.id),[later.id])
 await w.deletePlan(db,later.id)
 assert.deepEqual((await (await request('/api/account/plans')).json()).plans,[])
 cookie=adminCookie
 })
 await test('notice database search handles title/body, visibility, literal punctuation and server pages',async()=>{
 const create=async input=>{const response=await request('/api/admin/notices',input);assert.equal(response.status,201);return (await response.json()).notice}
 await create({title:'Secret needle',body:'Hidden',visible:false})
 const first=await create({title:'NEEDLE title',body:'First',sortOrder:1})
 const second=await create({title:'Body match',body:'A needle in text',sortOrder:2})
 const literal=await create({title:'100%_literal',body:'中文内容',sortOrder:3})
 await create({title:'Other',body:'Nothing'})
 const query=async(q,page=1)=> (await request(`/api/notices?q=${encodeURIComponent(q)}&page=${page}&pageSize=1`)).json()
 assert.deepEqual((await query(' needle ')).notices.map(n=>n.id),[first.id])
 assert.equal((await query('needle')).total,2)
 assert.deepEqual((await query('needle',2)).notices.map(n=>n.id),[second.id])
 assert.deepEqual((await query('needle',3)).notices,[])
 assert.deepEqual((await query('%_')).notices.map(n=>n.id),[literal.id])
 assert.equal((await query('中文')).total,1)
 assert.equal((await query("' OR 1=1 --")).total,0)
 const bounded=await (await request('/api/notices?q=&page=-1&pageSize=999')).json()
 assert.equal(bounded.page,1);assert.equal(bounded.pageSize,100);assert.equal(bounded.total,4)
 assert.equal((await request('/api/notices?q=needle',undefined,'GET',false)).status,401)
 assert.equal((await (await request('/api/notices')).json()).notices.length,4)
 assert.equal((await request(`/api/admin/notices/${first.id}`,{visible:false},'PUT')).status,200)
 assert.equal((await query('needle')).total,1)
 assert.equal((await request(`/api/admin/notices/${second.id}`,undefined,'DELETE')).status,204)
 assert.equal((await query('needle')).total,0)
 })
 await test('stats endpoint supplies all dashboard counts under the admin guard',async()=>{
 const response=await request('/api/admin/stats');assert.equal(response.status,200)
 const stats=await response.json()
 assert.equal(stats.users,2);assert.equal(stats.activeSubscriptions,0);assert.equal(stats.expiringSubscriptions,0);assert.equal(stats.pendingTickets,0)
 assert.equal((await request('/api/admin/stats',undefined,'GET',false)).status,401)
 })
} finally { sqlite.close(); await rm(temp,{recursive:true,force:true}) }
