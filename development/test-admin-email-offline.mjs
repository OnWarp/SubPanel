// Focused SQLite + in-process HTTP coverage when workerd cannot open localhost sockets.
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
const temp = await mkdtemp(join(tmpdir(),'admin-email-test-'))
const output = join(temp,'worker.mjs')
await build({ stdin: { contents: `export { userAnchorStatement } from './worker/db/ensure-users.ts'; export { readAccounts, writeAccounts } from './worker/accounts/repository.ts'; export { app } from './worker/app.ts'; export { setEmailVerificationDeliverer } from './worker/accounts/email.ts'; export { markModuleReady, ACCOUNTS_D1_READY_KEY } from './worker/db/module-switch.ts';`,resolveDir: root },bundle: true,platform: 'node',format: 'esm',banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },outfile: output,plugins: [{ name: 'worker-bindings',setup(builder) {
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
let cookie = ''
const request = async (path,body,method = body === undefined ? 'GET' : 'POST',auth = true) => w.app.fetch(new Request(`https://subpanel.test${path}`,{ method,headers: { ...(auth ? { cookie } : {}),origin: 'https://subpanel.test',...(body === undefined ? {} : { 'content-type': 'application/json' }) },body: body === undefined ? undefined : JSON.stringify(body) }),env)
try {
 for (const file of (await readdir(resolve(root,'migrations'))).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(await readFile(resolve(root,'migrations',file),'utf8'))
 await test('admin direct email edit: trust, login, guards, duplicates, self, audit and no mail',async()=>{
 assert.equal((await request('/api/setup',{username:'admin',password:'correct horse battery staple'})).status,201)
 const accounts = await w.readAccounts(env)
 for (const user of accounts.users) await w.userAnchorStatement(db,user).run()
 await w.markModuleReady(db,w.ACCOUNTS_D1_READY_KEY)
 await w.writeAccounts(env,{...accounts,nextUserId:4,users:[...accounts.users,{...accounts.users[0],id:'usr_2',username:'reader',role:'user'},{...accounts.users[0],id:'usr_3',username:'second',role:'admin'}]})
 const login=await request('/api/login',{username:'admin',password:'correct horse battery staple'})
 cookie=login.headers.get('set-cookie').split(';')[0]
 let sent = 0
 w.setEmailVerificationDeliverer(async()=>{sent++;return {ok:true}})
 // Admin must ignore both registration domain restrictions and pending reservations.
 sqlite.prepare('INSERT INTO allowed_email_domains (domain,created_at) VALUES (?,?)').run('allowed.example',new Date().toISOString())
 sqlite.prepare("INSERT INTO email_verifications (user_id,email,email_normalized,token_hash,expires_at,created_at) VALUES ('usr_3','new@outside.example','new@outside.example',?,'2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run('x'.repeat(43))
 sqlite.prepare("UPDATE users SET email='old@example.com',email_normalized='old@example.com' WHERE id='usr_2'").run()
 const before=sqlite.prepare('SELECT * FROM users WHERE id = ?').get('usr_2')
 let response=await request('/api/admin/users/usr_2',{email:' New@Outside.example '},'PATCH')
 assert.equal(response.status,200)
 assert.equal((await response.json()).user.email,'new@outside.example')
 const after=sqlite.prepare('SELECT * FROM users WHERE id = ?').get('usr_2')
 assert.ok(after.email_verified_at)
 for (const key of Object.keys(before).filter(k=>!['email','email_normalized','email_verified_at','updated_at'].includes(k))) assert.deepEqual(after[key],before[key])
 assert.equal((await request('/api/login',{username:'old@example.com',password:'correct horse battery staple'})).status,401)
 assert.equal((await request('/api/login',{username:'new@outside.example',password:'correct horse battery staple'})).status,200)
 assert.equal((await request('/api/admin/users/usr_3',{email:'other@outside.example'},'PATCH')).status,200)
 assert.equal((await request('/api/login',{username:'other@outside.example',password:'correct horse battery staple'})).status,200)
 assert.equal((await request('/api/admin/users/usr_1',{email:'self@outside.example'},'PATCH')).status,200)
 assert.equal((await request('/api/admin/users/usr_1',{email:'SELF@outside.example'},'PATCH')).status,200)
 response=await request('/api/admin/users/usr_1',{email:'NEW@outside.example'},'PATCH')
 assert.equal(response.status,409);assert.equal((await response.json()).error.code,'EMAIL_TAKEN')
 assert.equal((await request('/api/admin/users/usr_1',{email:'invalid'},'PATCH')).status,422)
 const adminCookie=cookie
 const readerLogin=await request('/api/login',{username:'reader',password:'correct horse battery staple'})
 cookie=readerLogin.headers.get('set-cookie').split(';')[0]
 assert.equal((await request('/api/admin/users/usr_1',{email:'forbidden@example.com'},'PATCH')).status,403)
 cookie=adminCookie
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action='patch.users' AND target_id='usr_2'").get().count,1)
 assert.equal(sent,0)
 })
} finally { sqlite.close(); await rm(temp,{recursive:true,force:true}) }
