import type { User } from '../accounts/schema.js'
import { batch, type AppDatabase } from '../db/db.js'
import { userAnchorStatements } from '../db/ensure-users.js'
import {
  SHARES_SETTING_KEYS,
  countRows,
  deleteSettings,
  upsertSettingStatement,
} from '../db/module-switch.js'
import { convertShares, type ShareRow } from '../migration/shares.js'
import { decodeSettingJson, getSetting, SHARE_SETTINGS_KEY } from '../db/settings-repository.js'
import {
  canonicalPublicBaseUrl,
  DEFAULT_SHARE_SETTINGS,
  shareRecordSchema,
  shareSettingsSchema,
  type ShareRecord,
  type ShareSettings,
} from './schema.js'

export type SharesCounts = {
  shares: number
  shareSettings: number
}

type ShareSql = {
  id: string
  schema_version: number
  owner_user_id: string
  subscription_id: string
  token_hash: string
  token_prefix: string
  token_encrypted: string
  remark: string
  status: 'active' | 'disabled' | 'revoked'
  access_mode: 'none' | 'password'
  access_password_algorithm: string | null
  access_password_iterations: number | null
  access_password_salt: string | null
  access_password_hash: string | null
  expires_at: string
  allow_original_link: number
  show_subscription_name: number
  show_groups: number
  show_expiry: number
  show_node_names: number
  require_login: number
  max_access_count: number | null
  access_count: number
  last_accessed_at: string | null
  last_original_reveal_at: string | null
  created_at: string
  updated_at: string
}

const SHARE_META_KEYS = [SHARE_SETTINGS_KEY, SHARES_SETTING_KEYS.nextShareId] as const
const VERIFY_BUCKET = 'share_verify'
const VERIFY_WINDOW_MS = 60_000
const VERIFY_WINDOW_COUNT = 10
const VERIFY_LIMIT = 10

function corrupt(): never {
  throw new Error('Share record is corrupt')
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    corrupt()
  }
}

function flag(value: number): boolean {
  return value === 1
}

export function shareFromRow(row: ShareSql): ShareRecord {
  const accessControl = row.access_mode === 'password'
    ? {
      mode: 'password' as const,
      passwordHash: {
        algorithm: 'PBKDF2-SHA-256' as const,
        iterations: row.access_password_iterations ?? 0,
        salt: row.access_password_salt ?? '',
        hash: row.access_password_hash ?? '',
      },
    }
    : { mode: 'none' as const }
  try {
    return shareRecordSchema.parse({
      schemaVersion: row.schema_version,
      id: row.id,
      ownerUserId: row.owner_user_id,
      subscriptionId: row.subscription_id,
      tokenHash: row.token_hash,
      tokenPrefix: row.token_prefix,
      tokenEncrypted: parseJson(row.token_encrypted),
      remark: row.remark,
      status: row.status,
      accessControl,
      expiresAt: row.expires_at,
      allowOriginalLink: flag(row.allow_original_link),
      showSubscriptionName: flag(row.show_subscription_name),
      showGroups: flag(row.show_groups),
      showExpiry: flag(row.show_expiry),
      showNodeNames: flag(row.show_node_names),
      requireLogin: flag(row.require_login),
      maxAccessCount: row.max_access_count,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      lastOriginalRevealAt: row.last_original_reveal_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Share record is corrupt') throw error
    throw new Error('Share record is corrupt')
  }
}

const SHARE_COLUMNS = `id, schema_version, owner_user_id, subscription_id, token_hash, token_prefix, token_encrypted,
  remark, status, access_mode, access_password_algorithm, access_password_iterations,
  access_password_salt, access_password_hash, expires_at, allow_original_link,
  show_subscription_name, show_groups, show_expiry, show_node_names, require_login,
  max_access_count, access_count, last_accessed_at, last_original_reveal_at, created_at, updated_at`

export async function clearSharesStorage(db: AppDatabase): Promise<void> {
  await batch(db, [
    db.prepare('DELETE FROM shares'),
    db.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(VERIFY_BUCKET),
  ])
  await deleteSettings(db, SHARE_META_KEYS)
}

export async function sharesCounts(db: AppDatabase): Promise<SharesCounts> {
  const [shares, shareSettings] = await Promise.all([
    countRows(db, 'shares'),
    db.prepare('SELECT COUNT(*) AS count FROM system_settings WHERE key = ?').bind(SHARE_SETTINGS_KEY).first<{ count: number }>(),
  ])
  return { shares, shareSettings: Number(shareSettings?.count ?? 0) }
}

export async function readNextShareId(db: AppDatabase): Promise<number> {
  const raw = await getSetting(db, SHARES_SETTING_KEYS.nextShareId)
  if (raw === null) return 1
  const value = decodeSettingJson(raw)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('Share id sequence is corrupt')
  }
  return value
}

export async function readShareFromD1(db: AppDatabase, tokenHash: string): Promise<ShareRecord | null> {
  const row = await db.prepare(
    `SELECT ${SHARE_COLUMNS} FROM shares WHERE token_hash = ?`,
  ).bind(tokenHash).first<ShareSql>()
  if (!row) return null
  return shareFromRow(row)
}

export async function listSharesFromD1(
  db: AppDatabase,
  filter: { ownerUserId?: string, subscriptionId?: string } = {},
): Promise<ShareRecord[]> {
  let sql = `SELECT ${SHARE_COLUMNS} FROM shares`
  const binds: string[] = []
  if (filter.ownerUserId) {
    sql += ' WHERE owner_user_id = ?'
    binds.push(filter.ownerUserId)
  } else if (filter.subscriptionId) {
    sql += ' WHERE subscription_id = ?'
    binds.push(filter.subscriptionId)
  }
  const listed = await db.prepare(sql).bind(...binds).all<ShareSql>()
  return listed.results.map((row) => shareFromRow(row))
}

function shareInsert(db: AppDatabase, row: ShareRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO shares (
      id, schema_version, owner_user_id, subscription_id, token_hash, token_prefix, token_encrypted,
      remark, status, access_mode, access_password_algorithm, access_password_iterations,
      access_password_salt, access_password_hash, expires_at, allow_original_link,
      show_subscription_name, show_groups, show_expiry, show_node_names, require_login,
      max_access_count, access_count, last_accessed_at, last_original_reveal_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      owner_user_id = excluded.owner_user_id,
      subscription_id = excluded.subscription_id,
      token_hash = excluded.token_hash,
      token_prefix = excluded.token_prefix,
      token_encrypted = excluded.token_encrypted,
      remark = excluded.remark,
      status = excluded.status,
      access_mode = excluded.access_mode,
      access_password_algorithm = excluded.access_password_algorithm,
      access_password_iterations = excluded.access_password_iterations,
      access_password_salt = excluded.access_password_salt,
      access_password_hash = excluded.access_password_hash,
      expires_at = excluded.expires_at,
      allow_original_link = excluded.allow_original_link,
      show_subscription_name = excluded.show_subscription_name,
      show_groups = excluded.show_groups,
      show_expiry = excluded.show_expiry,
      show_node_names = excluded.show_node_names,
      require_login = excluded.require_login,
      max_access_count = excluded.max_access_count,
      access_count = excluded.access_count,
      last_accessed_at = excluded.last_accessed_at,
      last_original_reveal_at = excluded.last_original_reveal_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
  ).bind(
    row.id,
    row.schema_version,
    row.owner_user_id,
    row.subscription_id,
    row.token_hash,
    row.token_prefix,
    row.token_encrypted,
    row.remark,
    row.status,
    row.access_mode,
    row.access_password_algorithm,
    row.access_password_iterations,
    row.access_password_salt,
    row.access_password_hash,
    row.expires_at,
    row.allow_original_link,
    row.show_subscription_name,
    row.show_groups,
    row.show_expiry,
    row.show_node_names,
    row.require_login,
    row.max_access_count,
    row.access_count,
    row.last_accessed_at,
    row.last_original_reveal_at,
    row.created_at,
    row.updated_at,
  )
}

export async function upsertShareRow(db: AppDatabase, record: ShareRecord, users: readonly User[]): Promise<void> {
  const converted = convertShares([record], DEFAULT_SHARE_SETTINGS)
  const row = converted.rows.shares[0]
  if (!row) throw new Error('Share record is corrupt')
  await batch(db, [
    ...userAnchorStatements(db, users, [record.ownerUserId]),
    shareInsert(db, row),
  ])
}

export async function deleteShareByTokenHash(db: AppDatabase, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM shares WHERE token_hash = ?').bind(tokenHash).run()
}

export async function persistSharesSnapshot(
  db: AppDatabase,
  records: readonly ShareRecord[],
  settings: ShareSettings,
  nextShareId: number,
  users: readonly User[],
  now: string,
): Promise<void> {
  const parsedSettings = shareSettingsSchema.parse(settings)
  const publicBaseUrl = canonicalPublicBaseUrl(parsedSettings.publicBaseUrl)
  if (publicBaseUrl === null) throw new Error('Share settings are corrupt')
  const normalized = { ...parsedSettings, publicBaseUrl }
  const converted = convertShares([...records], normalized)
  if (converted.rows.shares.length !== records.length) throw new Error('Share record is corrupt')
  const ids = converted.rows.shares.map((row) => row.id)
  const statements: D1PreparedStatement[] = [
    ...userAnchorStatements(db, users, converted.rows.shares.map((row) => row.owner_user_id)),
    db.prepare('DELETE FROM shares WHERE id NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)),
    ...converted.rows.shares.map((row) => shareInsert(db, row)),
    upsertSettingStatement(db, SHARE_SETTINGS_KEY, normalized, now),
    upsertSettingStatement(db, SHARES_SETTING_KEYS.nextShareId, nextShareId, now),
  ]
  await batch(db, statements)
}

export async function consumeVerifySlotD1(db: AppDatabase, tokenHash: string, nowMs: number): Promise<boolean> {
  const minute = Math.floor(nowMs / VERIFY_WINDOW_MS)
  const nowSec = Math.floor(nowMs / 1000)
  const windows = Array.from({ length: VERIFY_WINDOW_COUNT }, (_, index) => minute - index)
  const placeholders = windows.map(() => '?').join(', ')
  const listed = await db.prepare(
    `SELECT window_start, count, expires_at FROM rate_limits
     WHERE bucket = ? AND subject = ? AND window_start IN (${placeholders})`,
  ).bind(VERIFY_BUCKET, tokenHash, ...windows).all<{ window_start: number, count: number, expires_at: number | null }>()
  const counts = new Map<number, number>()
  for (const row of listed.results) {
    if (row.expires_at !== null && row.expires_at <= nowSec) continue
    counts.set(row.window_start, row.count)
  }
  const total = windows.reduce((sum, window) => sum + (counts.get(window) ?? 0), 0)
  if (total >= VERIFY_LIMIT) return false
  const nextCount = (counts.get(minute) ?? 0) + 1
  await db.prepare(
    `INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bucket, subject, window_start) DO UPDATE SET
       count = excluded.count,
       expires_at = excluded.expires_at`,
  ).bind(VERIFY_BUCKET, tokenHash, minute, nextCount, nowSec + 11 * 60).run()
  return true
}
