import { batch, type AppDatabase } from '../db/db.js'
import {
  APPS_SETTING_KEYS,
  countRows,
  deleteSettings,
  readSettingMap,
  upsertSettingStatement,
} from '../db/module-switch.js'
import { convertApps, type AppPlatformRow, type AppRow } from '../migration/apps.js'
import { appsSnapshotSchema, emptyAppsSnapshot, type AppsSnapshot } from './schema.js'

export type AppsCounts = {
  apps: number
  platforms: number
}

type AppSql = {
  id: string
  name: string
  icon: string
  summary: string
  description: string
  category: string
  official_website: string
  developer: string | null
  is_recommended: number
  is_official: number
  is_popular: number
  is_enabled: number
  is_public: number
  sort_order: number
  created_at: string
  updated_at: string
}

type PlatformSql = {
  id: string
  app_id: string
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux'
  version: string
  download_url: string
  download_type: string
  file_size_kb: number | null
  official_store_url: string
  official_download_url: string
  update_notes: string
  import_supported: number
  import_protocol: string
  import_url_template: string
  import_instructions: string
  is_enabled: number
  created_at: string
  updated_at: string
}

const APPS_META_KEYS = [
  APPS_SETTING_KEYS.schemaVersion,
  APPS_SETTING_KEYS.revision,
  APPS_SETTING_KEYS.updatedAt,
  APPS_SETTING_KEYS.nextAppId,
  APPS_SETTING_KEYS.nextPlatformId,
  APPS_SETTING_KEYS.entityOrder,
] as const

function corrupt(): never {
  throw new Error('Apps snapshot is corrupt')
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) corrupt()
  return value
}

function orderExactly<T extends { id: string }>(rows: T[], order: string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (order.length !== rows.length || order.some((id) => !byId.has(id))) corrupt()
  return order.map((id) => byId.get(id)!)
}

export async function clearAppsStorage(db: AppDatabase): Promise<void> {
  await batch(db, [
    db.prepare('DELETE FROM app_platforms'),
    db.prepare('DELETE FROM apps'),
  ])
  await deleteSettings(db, APPS_META_KEYS)
}

export async function appsCounts(db: AppDatabase): Promise<AppsCounts> {
  const [apps, platforms] = await Promise.all([
    countRows(db, 'apps'),
    countRows(db, 'app_platforms'),
  ])
  return { apps, platforms }
}

export async function readAppsFromD1(db: AppDatabase): Promise<AppsSnapshot> {
  try {
    const [apps, platforms, settings] = await Promise.all([
      db.prepare('SELECT * FROM apps').all<AppSql>(),
      db.prepare('SELECT * FROM app_platforms').all<PlatformSql>(),
      readSettingMap(db, APPS_META_KEYS),
    ])
    const appRows = apps.results
    const platformRows = platforms.results
    const revision = settings.get(APPS_SETTING_KEYS.revision)
    if (revision === undefined && appRows.length === 0 && platformRows.length === 0) return emptyAppsSnapshot()

    const updatedAt = settings.get(APPS_SETTING_KEYS.updatedAt)
    const nextAppId = settings.get(APPS_SETTING_KEYS.nextAppId)
    const nextPlatformId = settings.get(APPS_SETTING_KEYS.nextPlatformId)
    const storedOrder = settings.get(APPS_SETTING_KEYS.entityOrder)
    if (
      typeof revision !== 'number' ||
      typeof updatedAt !== 'string' ||
      typeof nextAppId !== 'number' ||
      typeof nextPlatformId !== 'number' ||
      storedOrder === null ||
      typeof storedOrder !== 'object' ||
      Array.isArray(storedOrder)
    ) corrupt()

    const order = storedOrder as { apps?: unknown, platforms?: unknown }
    const snapshot = {
      schemaVersion: 1 as const,
      revision,
      updatedAt,
      nextAppId,
      nextPlatformId,
      apps: orderExactly(appRows, asStringArray(order.apps)).map((row) => {
        const app: Record<string, unknown> = {
          id: row.id,
          name: row.name,
          icon: row.icon,
          summary: row.summary,
          description: row.description,
          category: row.category,
          officialWebsite: row.official_website,
          flags: {
            isRecommended: row.is_recommended === 1,
            isOfficial: row.is_official === 1,
            isPopular: row.is_popular === 1,
            isEnabled: row.is_enabled === 1,
            isPublic: row.is_public === 1,
          },
          sortOrder: row.sort_order,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
        if (row.developer) app.developer = row.developer
        return app
      }),
      platforms: orderExactly(platformRows, asStringArray(order.platforms)).map((row) => {
        const platform: Record<string, unknown> = {
          id: row.id,
          appId: row.app_id,
          platform: row.platform,
          version: row.version,
          downloadUrl: row.download_url,
          downloadType: row.download_type,
          officialStoreUrl: row.official_store_url,
          officialDownloadUrl: row.official_download_url,
          updateNotes: row.update_notes,
          importSupported: row.import_supported === 1,
          importProtocol: row.import_protocol,
          importUrlTemplate: row.import_url_template,
          importInstructions: row.import_instructions,
          isEnabled: row.is_enabled === 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
        if (row.file_size_kb !== null) platform.fileSizeKb = row.file_size_kb
        return platform
      }),
    }
    return appsSnapshotSchema.parse(snapshot)
  } catch (error) {
    if (error instanceof Error && error.message === 'Apps snapshot is corrupt') throw error
    throw new Error('Apps snapshot is corrupt')
  }
}

function appInsert(db: AppDatabase, row: AppRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO apps (
      id, name, icon, summary, description, category, official_website, developer,
      is_recommended, is_official, is_popular, is_enabled, is_public,
      sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id,
    row.name,
    row.icon,
    row.summary,
    row.description,
    row.category,
    row.official_website,
    row.developer,
    row.is_recommended,
    row.is_official,
    row.is_popular,
    row.is_enabled,
    row.is_public,
    row.sort_order,
    row.created_at,
    row.updated_at,
  )
}

function platformInsert(db: AppDatabase, row: AppPlatformRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO app_platforms (
      id, app_id, platform, version, download_url, download_type, file_size_kb,
      official_store_url, official_download_url, update_notes,
      import_supported, import_protocol, import_url_template, import_instructions,
      is_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id,
    row.app_id,
    row.platform,
    row.version,
    row.download_url,
    row.download_type,
    row.file_size_kb,
    row.official_store_url,
    row.official_download_url,
    row.update_notes,
    row.import_supported,
    row.import_protocol,
    row.import_url_template,
    row.import_instructions,
    row.is_enabled,
    row.created_at,
    row.updated_at,
  )
}

export async function persistAppsSnapshot(db: AppDatabase, snapshot: AppsSnapshot): Promise<void> {
  const converted = convertApps(snapshot)
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM app_platforms'),
    db.prepare('DELETE FROM apps'),
    ...converted.rows.apps.map((row) => appInsert(db, row)),
    ...converted.rows.app_platforms.map((row) => platformInsert(db, row)),
    upsertSettingStatement(db, APPS_SETTING_KEYS.schemaVersion, snapshot.schemaVersion, snapshot.updatedAt),
    upsertSettingStatement(db, APPS_SETTING_KEYS.revision, snapshot.revision, snapshot.updatedAt),
    upsertSettingStatement(db, APPS_SETTING_KEYS.updatedAt, snapshot.updatedAt, snapshot.updatedAt),
    upsertSettingStatement(db, APPS_SETTING_KEYS.nextAppId, snapshot.nextAppId, snapshot.updatedAt),
    upsertSettingStatement(db, APPS_SETTING_KEYS.nextPlatformId, snapshot.nextPlatformId, snapshot.updatedAt),
    upsertSettingStatement(db, APPS_SETTING_KEYS.entityOrder, {
      apps: snapshot.apps.map((app) => app.id),
      platforms: snapshot.platforms.map((platform) => platform.id),
    }, snapshot.updatedAt),
  ]
  await batch(db, statements)
}
