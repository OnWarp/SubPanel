import { ApiError } from '../platform/api-error.js'
import type { AppDatabase } from '../db/db.js'
import { SUBSCRIPTION_LINK_PLATFORM_KEYS, SUBSCRIPTION_LINK_PLATFORMS } from './platforms.js'

export class DomainError extends ApiError {}

function domainError(status: 422, code: string, message: string): DomainError {
  return new DomainError(status, code, message)
}

export type PlatformSetting = {
  platform: string
  displayName: string
  enabled: boolean
  sortOrder: number
}

type PlatformRow = {
  platform: string
  display_name: string
  enabled: number
  sort_order: number
}

export async function listPlatformSettings(db: AppDatabase): Promise<PlatformSetting[]> {
  const listed = await db
    .prepare(
      'SELECT platform, display_name, enabled, sort_order FROM subscription_platform_settings ORDER BY sort_order, platform',
    )
    .all<PlatformRow>()
  const byKey = new Map(listed.results.map((row) => [row.platform, row]))
  // Rows are seeded by migration 0007; if a row is missing (older test
  // fixture), fall back to the canonical seed shape instead of dropping the
  // platform from the admin list.
  return SUBSCRIPTION_LINK_PLATFORMS.map((seed, index) => {
    const row = byKey.get(seed.platform)
    if (!row) {
      return { platform: seed.platform, displayName: seed.displayName, enabled: true, sortOrder: index * 10 }
    }
    return {
      platform: row.platform,
      displayName: row.display_name,
      enabled: row.enabled === 1,
      sortOrder: row.sort_order,
    }
  }).sort((a, b) => a.sortOrder - b.sortOrder || a.platform.localeCompare(b.platform))
}

export async function listEnabledPlatforms(db: AppDatabase): Promise<PlatformSetting[]> {
  return (await listPlatformSettings(db)).filter((entry) => entry.enabled)
}

export async function updatePlatformSettings(
  db: AppDatabase,
  entries: Array<{ platform: string; enabled: boolean }>,
  now = new Date().toISOString(),
): Promise<PlatformSetting[]> {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!SUBSCRIPTION_LINK_PLATFORM_KEYS.has(entry.platform) || seen.has(entry.platform)) {
      throw domainError(422, 'PLATFORM_INVALID', '平台配置无效')
    }
    seen.add(entry.platform)
  }
  if (seen.size !== SUBSCRIPTION_LINK_PLATFORM_KEYS.size) {
    throw domainError(422, 'PLATFORM_INVALID', '平台配置不完整')
  }
  const statements = entries.map((entry, index) =>
    db
      .prepare(
        `INSERT INTO subscription_platform_settings (platform, display_name, enabled, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform) DO UPDATE SET
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      )
      .bind(
        entry.platform,
        SUBSCRIPTION_LINK_PLATFORMS.find((seed) => seed.platform === entry.platform)?.displayName ?? entry.platform,
        entry.enabled ? 1 : 0,
        index * 10,
        now,
      ),
  )
  await db.batch(statements)
  return listPlatformSettings(db)
}
