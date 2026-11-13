import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SHARE_SETTINGS } from '../../../worker/shares/schema'
import { batch } from '../../../worker/db/db'
import {
  DEFAULT_REGISTRATION_MODE,
  decodeSettingJson,
  getRegistrationMode,
  getSetting,
  getShareSettings,
  putRegistrationMode,
  putSetting,
  putShareSettings,
  REGISTRATION_MODE_KEY,
  SHARE_SETTINGS_KEY,
} from '../../../worker/db/settings-repository'
import {
  decryptText,
  encryptText,
  getOrCreateCryptoMaterial,
  readCryptoMaterial,
  toBase64Url,
  type CryptoSecrets,
} from '../../../worker/platform/crypto'
import {
  applyMigrations,
  D1_TABLES,
  APP_REFACTOR_MIGRATION_NAME,
  EMAIL_VERIFICATION_PURPOSE_MIGRATION_NAME,
  emptyDatabase,
  INIT_MIGRATION_NAME,
  initMigration,
  SOFT_DELETE_MIGRATION_NAME,
  listTables,
  REGISTRATION_MIGRATION_NAME,
  SHARES_FK_MIGRATION_NAME,
} from './d1'
import { resetData } from './helpers'

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-02-01T00:00:00.000Z'

describe('D1 migrations', () => {
  it('applies the full schema on an empty database and skips a second run', async () => {
    await emptyDatabase(env.DB)
    expect(await listTables(env.DB)).toEqual([])
    expect(initMigration.queries.length).toBeGreaterThan(D1_TABLES.length)

    await applyMigrations(env.DB)
    expect((await listTables(env.DB)).filter((name) => name !== 'd1_migrations')).toEqual([...D1_TABLES])

    const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()
    expect(applied.results.map((row) => row.name)).toEqual([
      INIT_MIGRATION_NAME,
      EMAIL_VERIFICATION_PURPOSE_MIGRATION_NAME,
      SHARES_FK_MIGRATION_NAME,
      SOFT_DELETE_MIGRATION_NAME,
      REGISTRATION_MIGRATION_NAME,
      APP_REFACTOR_MIGRATION_NAME,
    ])

    await applyMigrations(env.DB)
    const replayed = await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{ count: number }>()
    expect(replayed?.count).toBe(6)

    await env.DB.prepare(
      `INSERT INTO users (
        id, username, role, enabled,
        password_algorithm, password_iterations, password_salt, password_hash,
        session_version, created_at, updated_at
      ) VALUES (?, ?, 'admin', 1, 'PBKDF2-SHA-256', 1000, ?, ?, 0, ?, ?)`,
    ).bind('usr_1', 'admin', 'salt-value-0123456789ab', 'hash-value', NOW, NOW).run()

    await expect(env.DB.prepare(
      `INSERT INTO users (
        id, username, role, enabled,
        password_algorithm, password_iterations, password_salt, password_hash,
        session_version, created_at, updated_at
      ) VALUES ('usr_2', 'admin', 'user', 1, 'PBKDF2-SHA-256', 1000, 'salt', 'hash', 0, ?, ?)`,
    ).bind(NOW, NOW).run()).rejects.toThrow()

    // Administrators may coexist since 0004 dropped the users_single_admin
    // unique index, so a second admin row inserts cleanly.
    await env.DB.prepare(
      `INSERT INTO users (
        id, username, role, enabled,
        password_algorithm, password_iterations, password_salt, password_hash,
        session_version, created_at, updated_at
      ) VALUES ('usr_2', 'other', 'admin', 1, 'PBKDF2-SHA-256', 1000, 'salt', 'hash', 0, ?, ?)`,
    ).bind(NOW, NOW).run()

    await expect(env.DB.prepare(
      `INSERT INTO subscriptions (
        id, user_id, name, token_hash, token_prefix, encrypted_token, enabled, default_client,
        revision, created_at, updated_at
      ) VALUES (
        'sub_1', 'usr_missing', 'missing', 'token-hash', 'tokenpre',
        '{"version":1}', 1, 'mihomo', 1, ?, ?
      )`,
    ).bind(NOW, NOW).run()).rejects.toThrow()

    await env.DB.prepare('DELETE FROM users').run()
  })
})

describe('settings repository', () => {
  beforeAll(async () => {
    await applyMigrations(env.DB)
  })

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM system_settings').run()
  })

  it('returns defaults when registration mode and share settings are absent', async () => {
    expect(await getRegistrationMode(env.DB)).toBe(DEFAULT_REGISTRATION_MODE)
    expect(await getShareSettings(env.DB)).toEqual(DEFAULT_SHARE_SETTINGS)
    expect(await getSetting(env.DB, REGISTRATION_MODE_KEY)).toBeNull()
  })

  it('writes, reads, and overwrites registration mode', async () => {
    await putRegistrationMode(env.DB, 'open', NOW)
    expect(await getRegistrationMode(env.DB)).toBe('open')
    expect(decodeSettingJson((await getSetting(env.DB, REGISTRATION_MODE_KEY)) ?? '')).toBe('open')

    await putRegistrationMode(env.DB, 'closed', LATER)
    expect(await getRegistrationMode(env.DB)).toBe('closed')
    const row = await env.DB.prepare('SELECT updated_at FROM system_settings WHERE key = ?').bind(REGISTRATION_MODE_KEY).first<{ updated_at: string }>()
    expect(row?.updated_at).toBe(LATER)
  })

  it('writes, merges, and overwrites share settings', async () => {
    await putSetting(env.DB, SHARE_SETTINGS_KEY, { enabled: false }, NOW)
    const merged = await getShareSettings(env.DB)
    expect(merged.enabled).toBe(false)
    expect(merged.maxValidityDays).toBe(DEFAULT_SHARE_SETTINGS.maxValidityDays)
    expect(merged.publicBaseUrl).toBe('')

    const next = { ...DEFAULT_SHARE_SETTINGS, maxValidityDays: 30, publicBaseUrl: 'https://Example.com' }
    await putShareSettings(env.DB, next, LATER)
    expect(await getShareSettings(env.DB)).toEqual({ ...next, publicBaseUrl: 'https://example.com' })
  })

  it('rejects corrupt stored values', async () => {
    await putSetting(env.DB, REGISTRATION_MODE_KEY, 'nope', NOW)
    await expect(getRegistrationMode(env.DB)).rejects.toThrow('Setting value is corrupt')

    await putSetting(env.DB, SHARE_SETTINGS_KEY, { maxValidityDays: 0 }, NOW)
    await expect(getShareSettings(env.DB)).rejects.toThrow('Setting value is corrupt')
    await expect(putShareSettings(env.DB, { ...DEFAULT_SHARE_SETTINGS, publicBaseUrl: 'https://example.com/path' })).rejects.toThrow()
  })

  it('stores two settings in one batch', async () => {
    await batch(env.DB, [
      env.DB.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').bind('alpha', '"1"', NOW),
      env.DB.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').bind('beta', '"2"', NOW),
    ])
    expect(decodeSettingJson((await getSetting(env.DB, 'alpha')) ?? '')).toBe('1')
    expect(decodeSettingJson((await getSetting(env.DB, 'beta')) ?? '')).toBe('2')
  })
})

function standardBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function kvProbe(stored: string | null = null): { kv: KVNamespace; reads: () => number; writes: () => number } {
  let reads = 0
  let writes = 0
  const kv = {
    get: async () => {
      reads += 1
      return stored
    },
    put: async () => {
      writes += 1
    },
  } as unknown as KVNamespace
  return { kv, reads: () => reads, writes: () => writes }
}

describe('crypto secret fallback', () => {
  beforeEach(resetData)

  it('reads KV when both secrets are absent and matches the stored material', async () => {
    const created = await getOrCreateCryptoMaterial(env.DATA)
    expect(await readCryptoMaterial(env.DATA)).toEqual(created)
    expect(JSON.parse((await env.DATA.get('system:crypto')) ?? '')).toEqual(created)

    const stored = JSON.parse((await env.DATA.get('system:crypto')) ?? '') as { createdAt: string }
    stored.createdAt = '2020-01-01T00:00:00.000Z'
    await env.DATA.put('system:crypto', JSON.stringify(stored))
    expect((await readCryptoMaterial(env.DATA)).createdAt).toBe('2020-01-01T00:00:00.000Z')
    expect((await getOrCreateCryptoMaterial(env.DATA)).createdAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('uses both secrets and does not read or write KV', async () => {
    const encryptionBytes = crypto.getRandomValues(new Uint8Array(32))
    const sessionBytes = crypto.getRandomValues(new Uint8Array(32))
    const secrets: CryptoSecrets = {
      DATA_ENCRYPTION_KEY: toBase64Url(encryptionBytes),
      SESSION_KEY: toBase64Url(sessionBytes),
    }
    const probe = kvProbe('{"schemaVersion":1}')

    const material = await readCryptoMaterial(probe.kv, secrets)
    expect(probe.reads()).toBe(0)
    expect(probe.writes()).toBe(0)
    expect(material.encryptionKey).toBe(secrets.DATA_ENCRYPTION_KEY)
    expect(material.sessionKey).toBe(secrets.SESSION_KEY)
    expect(material.schemaVersion).toBe(1)

    const created = await getOrCreateCryptoMaterial(probe.kv, secrets)
    expect(probe.reads()).toBe(0)
    expect(probe.writes()).toBe(0)
    expect(created.encryptionKey).toBe(material.encryptionKey)
    expect(await env.DATA.get('system:crypto')).toBeNull()

    const encrypted = await encryptText('secret path', material.encryptionKey)
    await expect(decryptText(encrypted, toBase64Url(encryptionBytes))).resolves.toBe('secret path')

    const partial = kvProbe()
    await expect(readCryptoMaterial(partial.kv, { DATA_ENCRYPTION_KEY: secrets.DATA_ENCRYPTION_KEY })).rejects.toThrow('Crypto material is corrupt')
    expect(partial.reads()).toBe(0)
  })

  it('accepts standard base64 secrets as the same raw key', async () => {
    let encryptionBytes = new Uint8Array(32)
    let sessionBytes = new Uint8Array(32)
    let encryptionStandard = ''
    let sessionStandard = ''
    do {
      encryptionBytes = crypto.getRandomValues(new Uint8Array(32))
      sessionBytes = crypto.getRandomValues(new Uint8Array(32))
      encryptionStandard = standardBase64(encryptionBytes)
      sessionStandard = standardBase64(sessionBytes)
    } while (!/[+/=]/u.test(encryptionStandard) || !/[+/=]/u.test(sessionStandard))

    const probe = kvProbe()
    const material = await readCryptoMaterial(probe.kv, {
      DATA_ENCRYPTION_KEY: encryptionStandard,
      SESSION_KEY: sessionStandard,
    })
    expect(probe.reads()).toBe(0)
    expect(material.encryptionKey).toBe(toBase64Url(encryptionBytes))
    expect(material.sessionKey).toBe(toBase64Url(sessionBytes))
    const encrypted = await encryptText('normalized', material.encryptionKey)
    await expect(decryptText(encrypted, toBase64Url(encryptionBytes))).resolves.toBe('normalized')
  })
})
