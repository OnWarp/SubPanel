import type { AppDatabase } from '../db/db.js'
import {
  ACCOUNTS_D1_READY_KEY,
  ACCOUNTS_SETTING_KEYS,
  APPS_D1_READY_KEY,
  APPS_SETTING_KEYS,
  CATALOG_D1_READY_KEY,
  CATALOG_SETTING_KEYS,
  DELIVERY_D1_READY_KEY,
  readSettingMap,
  SHARES_D1_READY_KEY,
} from '../db/module-switch.js'

// Mirrors the database_name of the DB binding in wrangler.jsonc. The worker
// cannot read its own binding metadata at runtime, so the status page shows
// this constant; keep it in sync with wrangler.jsonc.
export const DATABASE_NAME = 'subpanel-d1'

export interface ModuleStatus {
  module: string
  label: string
  backend: 'd1' | 'kv'
  schemaVersion: number | null
  updatedAt: string | null
}

export interface MigrationRecord {
  name: string
  appliedAt: string | null
}

export interface SystemStatus {
  databaseName: string
  modules: ModuleStatus[]
  migrations: MigrationRecord[]
}

interface ModuleDescriptor {
  module: string
  label: string
  readyKey: string
  schemaVersionKey: string
  updatedAtKey: string
}

export const MODULE_STATUS_DESCRIPTORS: readonly ModuleDescriptor[] = [
  {
    module: 'catalog',
    label: '目录（来源 / 节点 / 分组）',
    readyKey: CATALOG_D1_READY_KEY,
    schemaVersionKey: CATALOG_SETTING_KEYS.schemaVersion,
    updatedAtKey: CATALOG_SETTING_KEYS.updatedAt,
  },
  {
    module: 'apps',
    label: '应用目录',
    readyKey: APPS_D1_READY_KEY,
    schemaVersionKey: APPS_SETTING_KEYS.schemaVersion,
    updatedAtKey: APPS_SETTING_KEYS.updatedAt,
  },
  {
    module: 'delivery',
    label: '订阅交付',
    readyKey: DELIVERY_D1_READY_KEY,
    schemaVersionKey: 'delivery_schema_version',
    updatedAtKey: 'delivery_updated_at',
  },
  {
    module: 'shares',
    label: '分享',
    readyKey: SHARES_D1_READY_KEY,
    schemaVersionKey: 'shares_schema_version',
    updatedAtKey: 'shares_updated_at',
  },
  {
    module: 'accounts',
    label: '账户',
    readyKey: ACCOUNTS_D1_READY_KEY,
    schemaVersionKey: ACCOUNTS_SETTING_KEYS.schemaVersion,
    updatedAtKey: ACCOUNTS_SETTING_KEYS.updatedAt,
  },
] as const

function asVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

// Pure assembly from decoded system_settings values, exported for tests. The
// status page is read-only: backend comes straight from the *_d1_ready flags
// the coordinator sets, nothing here can change them.
export function assembleModuleStatuses(values: Map<string, unknown>): ModuleStatus[] {
  return MODULE_STATUS_DESCRIPTORS.map((descriptor) => ({
    module: descriptor.module,
    label: descriptor.label,
    backend: values.get(descriptor.readyKey) === true ? 'd1' : 'kv',
    schemaVersion: asVersion(values.get(descriptor.schemaVersionKey)),
    updatedAt: asTimestamp(values.get(descriptor.updatedAtKey)),
  }))
}

async function readMigrations(db: AppDatabase): Promise<MigrationRecord[]> {
  try {
    const listed = await db.prepare(
      'SELECT name, applied_at FROM d1_migrations ORDER BY id ASC',
    ).all<{ name: string, applied_at: string | null }>()
    return listed.results.map((row) => ({ name: row.name, appliedAt: row.applied_at ?? null }))
  } catch {
    // Databases provisioned by executing migration files directly have no
    // d1_migrations table; the per-module schema versions above still show.
    return []
  }
}

export async function readSystemStatus(db: AppDatabase): Promise<SystemStatus> {
  const keys = MODULE_STATUS_DESCRIPTORS.flatMap((descriptor) => [
    descriptor.readyKey,
    descriptor.schemaVersionKey,
    descriptor.updatedAtKey,
  ])
  const [values, migrations] = await Promise.all([
    readSettingMap(db, keys),
    readMigrations(db),
  ])
  return {
    databaseName: DATABASE_NAME,
    modules: assembleModuleStatuses(values),
    migrations,
  }
}
