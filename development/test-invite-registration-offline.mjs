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
const temp = await mkdtemp(join(tmpdir(),'invite-registration-test-'))
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
let cookie = ''
const request = async (path,body,method = body === undefined ? 'GET' : 'POST',auth = true) => w.app.fetch(new Request(`https://subpanel.test${path}`,{ method,headers: { ...(auth ? { cookie } : {}),origin: 'https://subpanel.test',...(body === undefined ? {} : { 'content-type': 'application/json' }) },body: body === undefined ? undefined : JSON.stringify(body) }),env)
const password = 'chosen password 123'
const register = (username, code, extra = {}) => request('/api/register', { username, password, email: `${username}@example.com`, ...(code ? { inviteCode: code } : {}), ...extra }, 'POST', false)
const makeCodes = async (body) => {
 const response = await request('/api/admin/invitations', body)
 assert.equal(response.status,201)
 const { invitations } = await response.json()
 for (const code of invitations) {
  const panel = sqlite.prepare('SELECT hostname FROM panel_domains WHERE enabled=1').get()
  assert.equal(code.link,`${panel ? `https://${panel.hostname}` : 'https://subpanel.test'}/invite/${code.code}`)
  assert.ok(!('username' in code))
 }
 return invitations
}
let sent = []
try {
 for (const file of (await readdir(resolve(root,'migrations'))).filter(f=>f.endsWith('.sql') && !f.startsWith('0012')).sort()) sqlite.exec(await readFile(resolve(root,'migrations',file),'utf8'))
 await test('0012 preserves old hashes, ignores reservations, and does not revive redeemed codes',async()=>{
  const now = new Date().toISOString()
  sqlite.prepare("INSERT INTO users(id,username,role,enabled,password_algorithm,password_iterations,password_salt,password_hash,session_version,created_at,updated_at) VALUES ('usr_99','legacyowner','user',1,'PBKDF2-SHA-256',1,'salt','hash',0,?,?)").run(now,now)
  for (const hash of ['oldhash','usedhash']) sqlite.prepare('INSERT INTO invitations(id,schema_version,user_id,username,created_at,expires_at) VALUES (?,1,?,?,?,?)').run(hash,'usr_99','legacyowner',now,'2099-01-01T00:00:00.000Z')
  sqlite.prepare("INSERT INTO invitation_redemptions(invitation_id,user_id,redeemed_at) VALUES ('usedhash','usr_99',?)").run(now)
  sqlite.exec(await readFile(resolve(root,'migrations/0012_invite_registration.sql'),'utf8'))
  assert.equal(sqlite.prepare("SELECT used_count FROM invite_codes WHERE id='usedhash'").get().used_count,1)
  assert.equal(sqlite.prepare("SELECT max_uses FROM invite_codes WHERE id='oldhash'").get().max_uses,1)
  sqlite.exec('DELETE FROM invitation_redemptions; DELETE FROM invitations; DELETE FROM invite_codes; DELETE FROM users;')
 })
 await test('create qualification codes without a username and register without sending or verifying email',async()=>{
  await w.markModuleReady(db,w.ACCOUNTS_D1_READY_KEY)
  assert.equal((await request('/api/setup',{ username:'admin',password })).status,201)
  cookie=(await request('/api/login',{ username:'admin',password })).headers.get('set-cookie').split(';')[0]
  await w.putRegistrationMode(db,'invite')
  w.setEmailVerificationDeliverer(async message=>{sent.push(message)})
  const [code]=await makeCodes({ type:'multi',maxUses:2 })
  sqlite.exec('UPDATE panel_domains SET enabled=0')
  await makeCodes({type:'multi',maxUses:1}) // request-origin fallback
  sqlite.exec('UPDATE panel_domains SET enabled=1')
  assert.equal((await register('chosen',code.code)).status,201)
  const row=sqlite.prepare("SELECT * FROM users WHERE username='chosen'").get()
  assert.equal(row.email,'chosen@example.com');assert.ok(row.email_verified_at)
  assert.equal((await request('/api/login',{ identifier:'chosen@example.com',password },'POST',false)).status,200)
  assert.equal((await request('/api/login',{ username:'chosen',password },'POST',false)).status,200)
  assert.equal(sent.length,0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM email_verifications').get().count,0)
  assert.equal((await register('second',code.code,{ code:'000000' })).status,201)
  assert.equal((await register('third',code.code)).status,409)
  const listed=await (await request('/api/admin/invitations')).json()
  const consumed=listed.invitations.find(item=>item.id===code.id)
  assert.equal(consumed.usedCount,2)
  assert.equal(consumed.remaining,0)
  assert.ok(!JSON.stringify(listed).includes(code.code))
 })
 await test('batch single-use codes, disabled and expired codes, and management authorization',async()=>{
  const codes=await makeCodes({type:'batch',count:3})
  assert.equal(codes.length,3);assert.ok(codes.every(code=>code.type==='single'))
  assert.equal((await register('single',codes[0].code)).status,201)
  assert.equal((await register('reuse',codes[0].code)).status,409)
  assert.equal((await request(`/api/admin/invitations/${codes[1].id}`,undefined,'DELETE')).status,204)
  assert.equal((await register('disabled',codes[1].code)).status,409)
  assert.equal((await request('/api/admin/invitations',{type:'multi'},'POST',false)).status,401)
  const [expired]=await makeCodes({type:'multi',expiresAt:'2000-01-01T00:00:00.000Z'})
  assert.equal((await register('expired',expired.code)).status,410)
 })
 await test('injected account insert failure rolls back code consumption and redemption',async()=>{
  const [code]=await makeCodes({type:'batch',count:1})
  const before=sqlite.prepare('SELECT COUNT(*) count FROM invite_code_redemptions').get().count
  sqlite.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON users WHEN NEW.username='failuser' BEGIN SELECT RAISE(ABORT,'injected account failure'); END")
  try {
   assert.equal((await register('failuser',code.code)).status,500)
   assert.equal(sqlite.prepare('SELECT used_count FROM invite_codes WHERE id=?').get(code.id).used_count,0)
   assert.equal(sqlite.prepare('SELECT COUNT(*) count FROM invite_code_redemptions').get().count,before)
  } finally { sqlite.exec('DROP TRIGGER fail_registration') }
  assert.equal((await register('recovered',code.code)).status,201)
 })
 await test('legacy KV links become single-use qualifications with arbitrary new username and email',async()=>{
  const token='L'.repeat(43)
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url')
  await kv.put(`invite:${hash}`,JSON.stringify({schemaVersion:1,userId:'usr_999',username:'reserved',createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00.000Z'}))
  assert.equal((await register('selfchosen',token)).status,201)
  assert.equal(await kv.get(`invite:${hash}`),null)
  assert.equal(sqlite.prepare('SELECT used_count FROM invite_codes WHERE id=?').get(hash).used_count,1)
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM users WHERE username='reserved'").get().count,0)
  assert.equal((await register('oldreuse',token)).status,409)
  assert.equal((await request(`/api/invites/${token}`,{password},'POST',false)).status,410)
  const alias=await request('/api/admin/invites',{})
  assert.equal(alias.status,201)
  const {invite}=await alias.json()
  assert.ok(!('username' in invite));assert.ok(invite.link.includes('/invite/'))
  assert.equal((await register('aliasuser',invite.code)).status,201)
 })
 await test('open registration still requires emailed verification; invite whitelist and closed mode stay enforced',async()=>{
  await w.putRegistrationMode(db,'open')
  assert.equal((await register('openuser')).status,400)
  assert.equal((await request('/api/register/send-code',{email:'openuser@example.com'},'POST',false)).status,200)
  assert.equal(sent.length,1)
  assert.equal((await register('openuser',undefined,{code:'000000'})).status,401)
  assert.equal((await register('openuser',undefined,{code:sent[0].code})).status,201)
  const [code]=await makeCodes({type:'multi'})
  sqlite.prepare('INSERT INTO allowed_email_domains(domain,created_at) VALUES (?,?)').run('example.com',new Date().toISOString())
  assert.equal((await register('outside',code.code,{email:'outside@other.example'})).status,403)
  assert.equal((await register('bademail',code.code,{email:'invalid'})).status,422)
  assert.equal((await register('allowed',code.code)).status,201)
  assert.equal(sent.length,1)
  await w.putRegistrationMode(db,'closed')
  assert.equal((await register('closed',code.code)).status,403)
  assert.equal((await request('/api/register/send-code',{email:'closed@example.com'},'POST',false)).status,403)
 })
} finally { sqlite.close(); await rm(temp,{recursive:true,force:true}) }
