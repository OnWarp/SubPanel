import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'

it('upgrades existing subscriptions and group order with foreign keys enabled and permits null owners', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const directory = new URL('../../../migrations/', import.meta.url)
  for (const file of readdirSync(directory).sort().filter(file => file.endsWith('.sql') && file < '0014')) {
    db.exec(readFileSync(new URL(file, directory), 'utf8'))
  }
  db.exec(`INSERT INTO users(id,username,role,enabled,password_algorithm,password_iterations,password_salt,password_hash,session_version,created_at,updated_at)
    VALUES('usr_1','admin','admin',1,'PBKDF2-SHA-256',1,'salt','hash',0,'2026-01-01','2026-01-01');
    INSERT INTO groups VALUES('grp_1','Group','2026-01-01','2026-01-01');
    INSERT INTO subscriptions VALUES('sub_1','usr_1','Existing','hash','prefix','{}',1,'mihomo',2,NULL,1800000000000,'2026-01-01','2026-01-01');
    INSERT INTO subscription_groups VALUES('sub_1','grp_1',0);`)
  const subscription = db.prepare('SELECT * FROM subscriptions').all()
  const groups = db.prepare('SELECT * FROM subscription_groups').all()
  db.exec(readFileSync(new URL('0014_subscription_pool.sql', directory), 'utf8'))
  expect(db.prepare('SELECT * FROM subscriptions').all()).toEqual(subscription)
  expect(db.prepare('SELECT * FROM subscription_groups').all()).toEqual(groups)
  db.exec("UPDATE subscriptions SET user_id = NULL WHERE id = 'sub_1'")
  expect(db.prepare('SELECT user_id FROM subscriptions').get()).toEqual({ user_id: null })
  expect(() => db.exec("UPDATE subscriptions SET user_id = 'usr_missing'")).toThrow()
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  db.close()
})
