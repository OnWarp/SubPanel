import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const migrations = new URL('../migrations/', import.meta.url)
const name = '0018_subscription_plans.sql'
const merge = readFileSync(new URL(name, migrations), 'utf8')
const prior = readdirSync(migrations).filter(file => file.endsWith('.sql') && file < name).sort()
const start = '2026-01-01T00:00:00.123Z'
const expiry = '2026-02-01T00:00:00.456Z'
const previousExpiry = Date.parse('2026-04-01T00:00:00Z')

function database(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  for (const file of prior) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  return db
}

function seed(db) {
  db.prepare(`INSERT INTO users (id,username,role,enabled,password_algorithm,password_iterations,
    password_salt,password_hash,session_version,created_at,updated_at)
    VALUES ('usr_1','fixture','user',1,'PBKDF2-SHA-256',1000,'salt','hash',0,?,?)`).run(start, start)
  db.prepare(`INSERT INTO plans(id,name,duration_days,traffic_gb,speed_limit_mbps,device_limit,created_at,updated_at)
    VALUES ('plan_fixture','Fixture',30,100,20,3,?,?)`).run(start, start)
  db.prepare("INSERT INTO groups (id,name,created_at,updated_at) VALUES ('grp_1','Fixture',?,?)").run(start, start)
  db.exec("INSERT INTO plan_groups (plan_id,group_id,position) VALUES ('plan_fixture','grp_1',0)")
  db.prepare(`INSERT INTO user_entitlements (id,user_id,plan_id,starts_at,expires_at,status,source,note,
    created_at,updated_at,last_reminded_at)
    VALUES ('legacy_current','usr_1','plan_fixture',?,?,'active','trial','memo',?,?,101)`).run(start, expiry, start, start)
}

test('0018 runs against an empty database and retains an empty legacy table', t => {
  const db = database(t)
  db.exec(merge)
  for (const table of ['subscriptions', 'user_entitlements_legacy', 'subscription_plan_migration']) {
    assert.equal(db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total, 0)
  }
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='user_entitlements'").get(), undefined)
})

test('0018 creates an assigned subscription with the legacy window, quota and groups', t => {
  const db = database(t)
  seed(db)
  db.exec(merge)
  const row = db.prepare('SELECT * FROM subscriptions').get()
  assert.equal(row.user_id, 'usr_1')
  assert.equal(row.plan_id, 'plan_fixture')
  assert.equal(row.enabled, 1)
  assert.equal(row.expires_at, Date.parse(expiry))
  assert.equal(row.starts_at, Date.parse(start))
  assert.equal(row.traffic_gb, 100)
  assert.equal(row.speed_limit_mbps, 20)
  assert.equal(row.device_limit, 3)
  assert.equal(row.plan_source, 'trial')
  assert.equal(row.plan_note, 'memo')
  assert.equal(row.last_reminded_at, 101)
  assert.equal(row.encrypted_token, '{}')
  assert.equal(db.prepare('SELECT group_id FROM subscription_groups WHERE subscription_id=?').get(row.id).group_id, 'grp_1')
  assert.equal(db.prepare('SELECT expires_at FROM user_entitlements_legacy').get().expires_at, expiry)
})

test('0018 records expiry conflicts per link and retains original delivery data and revoked history', t => {
  const db = database(t)
  seed(db)
  const add = db.prepare(`INSERT INTO subscriptions (id,user_id,name,token_hash,token_prefix,encrypted_token,
    enabled,default_client,revision,starts_at,expires_at,created_at,updated_at)
    VALUES (?,'usr_1','Original',?,'original','{"old":1}',?,'surge',3,NULL,?,?,?)`)
  add.run('sub_3', 'old-hash', 1, previousExpiry, start, start)
  add.run('sub_4', 'old-hash-2', 0, previousExpiry, start, start)
  db.exec("INSERT INTO subscription_groups VALUES ('sub_3','grp_1',0); INSERT INTO subscription_template_bindings (subscription_id,mode,template_id) VALUES ('sub_3','base',NULL)")
  db.prepare(`INSERT INTO user_entitlements (id,user_id,plan_id,starts_at,expires_at,status,source,created_at,updated_at)
    VALUES ('legacy_past','usr_1','plan_fixture',?,?,'revoked','admin',?,?)`).run(start, expiry, start, start)
  db.exec(merge)
  const rows = db.prepare('SELECT * FROM subscriptions').all()
  assert.equal(rows.length, 3)
  for (const [id, enabled] of [['sub_3', 1], ['sub_4', 0]]) {
    const row = rows.find(subscription => subscription.id === id)
    const ledger = db.prepare('SELECT * FROM subscription_plan_migration WHERE subscription_id=?').get(id)
    assert.equal(row.plan_id, 'plan_fixture')
    assert.equal(row.expires_at, Date.parse(expiry))
    assert.equal(row.enabled, enabled)
    assert.equal(row.default_client, 'surge')
    assert.equal(row.encrypted_token, '{"old":1}')
    assert.equal(ledger.legacy_id, 'legacy_current')
    assert.equal(ledger.previous_expires_at, previousExpiry)
    assert.equal(ledger.previous_enabled, enabled)
  }
  const history = rows.find(subscription => subscription.plan_revoked === 1)
  assert.equal(history.enabled, 0)
  assert.equal(db.prepare("SELECT mode FROM subscription_template_bindings WHERE subscription_id='sub_3'").get().mode, 'base')
  assert.equal(db.prepare("SELECT group_id FROM subscription_groups WHERE subscription_id='sub_3'").get().group_id, 'grp_1')
  assert.equal(db.prepare('SELECT count(*) AS total FROM user_entitlements_legacy').get().total, 2)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})
