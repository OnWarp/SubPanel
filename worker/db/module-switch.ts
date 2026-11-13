import { batch, type AppDatabase } from './db.js'
import { decodeSettingJson, getSetting, putSetting } from './settings-repository.js'

export const CATALOG_D1_READY_KEY = 'catalog_d1_ready'
export const APPS_D1_READY_KEY = 'apps_d1_ready'
export const ACCOUNTS_D1_READY_KEY = 'accounts_d1_ready'
export const DELIVERY_D1_READY_KEY = 'delivery_d1_ready'
export const SHARES_D1_READY_KEY = 'shares_d1_ready'

export const CATALOG_SETTING_KEYS = {
  schemaVersion: 'catalog_schema_version',
  revision: 'catalog_revision',
  updatedAt: 'catalog_updated_at',
  nextSourceId: 'next_source_id',
  nextNodeId: 'next_node_id',
  nextGroupId: 'next_group_id',
  entityOrder: 'catalog_entity_order',
} as const

export const APPS_SETTING_KEYS = {
  schemaVersion: 'apps_schema_version',
  revision: 'apps_revision',
  updatedAt: 'apps_updated_at',
  nextAppId: 'next_app_id',
  nextPlatformId: 'next_platform_id',
  entityOrder: 'apps_entity_order',
} as const

export const ACCOUNTS_SETTING_KEYS = {
  schemaVersion: 'accounts_schema_version',
  revision: 'accounts_revision',
  updatedAt: 'accounts_updated_at',
  nextUserId: 'next_user_id',
} as const

export type DataEnv = {
  DATA: KVNamespace
  DB: D1Database
}

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message)
}

export async function isModuleReady(db: AppDatabase, key: string): Promise<boolean> {
  let raw: string | null
  try {
    raw = await getSetting(db, key)
  } catch (error) {
    if (missingTable(error)) return false
    throw error
  }
  if (raw === null) return false
  let value: unknown
  try {
    value = decodeSettingJson(raw)
  } catch {
    throw new Error('Setting value is corrupt')
  }
  if (value !== true) throw new Error('Setting value is corrupt')
  return true
}

export async function markModuleReady(
  db: AppDatabase,
  key: string,
  now = new Date().toISOString(),
): Promise<void> {
  await putSetting(db, key, true, now)
}

export function upsertSettingStatement(
  db: AppDatabase,
  key: string,
  value: unknown,
  now: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(value), now)
}

export async function deleteSettings(db: AppDatabase, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  const placeholders = keys.map(() => '?').join(', ')
  await db.prepare(`DELETE FROM system_settings WHERE key IN (${placeholders})`).bind(...keys).run()
}

export async function readSettingMap(
  db: AppDatabase,
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  const placeholders = keys.map(() => '?').join(', ')
  const listed = await db.prepare(
    `SELECT key, value FROM system_settings WHERE key IN (${placeholders})`,
  ).bind(...keys).all<{ key: string, value: string }>()
  const map = new Map<string, unknown>()
  for (const row of listed.results) map.set(row.key, decodeSettingJson(row.value))
  return map
}

export async function countRows(db: AppDatabase, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

export async function clearRows(db: AppDatabase, statements: readonly D1PreparedStatement[]): Promise<void> {
  await batch(db, statements)
}
