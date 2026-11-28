import { ApiError } from '../platform/api-error.js'
import type { AppDatabase } from '../db/db.js'
import { clientAliases } from '../delivery/public-client.js'
import { clientIdSchema, type ClientId } from '../delivery/schema.js'
import {
  PLATFORM_KEY_PATTERN,
  PLATFORM_RENDERER_SET,
  SUBSCRIPTION_LINK_PLATFORM_KEYS,
} from './platforms.js'

export class DomainError extends ApiError {}

function domainError(status: 400, code: string, message: string): DomainError {
  return new DomainError(status, code, message)
}

export type PlatformSetting = {
  platform: string
  displayName: string
  enabled: boolean
  sortOrder: number
  renderer: string
}

type PlatformRow = {
  platform: string
  display_name: string
  enabled: number
  sort_order: number
  renderer: string
}

// The database is authoritative: seed rows only exist as the fresh-install
// default (migrations 0007 + 0034). A key missing here is deleted, not hidden,
// and a custom key stored here is a first-class platform.
export async function listPlatformSettings(db: AppDatabase): Promise<PlatformSetting[]> {
  const listed = await db
    .prepare(
      'SELECT platform, display_name, enabled, sort_order, renderer FROM subscription_platform_settings ORDER BY sort_order, platform',
    )
    .all<PlatformRow>()
  return listed.results.map((row) => ({
    platform: row.platform,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    renderer: row.renderer,
  }))
}

export async function listEnabledPlatforms(db: AppDatabase): Promise<PlatformSetting[]> {
  return (await listPlatformSettings(db)).filter((entry) => entry.enabled)
}

// The platform table is tiny and read on every public subscription fetch, so
// key -> renderer lookups are cached in-process. updatePlatformSettings (the
// only writer) invalidates the cache; direct database edits in tests must
// call invalidatePlatformRendererCache themselves.
let rendererCache: Map<string, string> | null = null

export function invalidatePlatformRendererCache(): void {
  rendererCache = null
}

async function loadRendererMap(db: AppDatabase): Promise<Map<string, string>> {
  if (!rendererCache) {
    const listed = await db
      .prepare('SELECT platform, renderer FROM subscription_platform_settings')
      .all<{ platform: string; renderer: string }>()
    rendererCache = new Map(listed.results.map((row) => [row.platform, row.renderer]))
  }
  return rendererCache
}

export async function resolvePlatformRenderer(db: AppDatabase, platform: string): Promise<string | null> {
  return (await loadRendererMap(db)).get(platform) ?? null
}

// Resolve a /sub/<token>/<key> path segment to the client format it renders.
// Returns null when the key must answer 404. Database first: a stored key
// renders with its configured renderer, even if an admin changed it away
// from the seed mapping. A seed key missing from the database was deleted by
// an admin, so it 404s instead of falling back to the alias. Anything else
// falls back to the legacy alias spellings, then to a bare client id
// (mihomo, generic, ...), matching the pre-platform behaviour.
export async function resolveSubscriptionClient(db: AppDatabase, key: string): Promise<ClientId | null> {
  const renderer = await resolvePlatformRenderer(db, key)
  if (renderer !== null) {
    if (renderer === 'auto') return null
    const parsed = clientIdSchema.safeParse(renderer)
    return parsed.success ? parsed.data : null
  }
  if (SUBSCRIPTION_LINK_PLATFORM_KEYS.has(key)) return null
  const parsed = clientIdSchema.safeParse(clientAliases[key] ?? key)
  return parsed.success ? parsed.data : null
}

const PLATFORM_INPUT_KEYS = ['platform', 'displayName', 'enabled', 'sortOrder', 'renderer'] as const

function invalid(message: string): DomainError {
  return domainError(400, 'PLATFORM_INVALID', message)
}

function validatePlatformEntries(input: unknown): PlatformSetting[] {
  if (!Array.isArray(input)) throw invalid('platforms 字段必须为数组')
  const seen = new Set<string>()
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`platforms[${index}] 不是对象`)
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!(PLATFORM_INPUT_KEYS as readonly string[]).includes(key)) {
        throw invalid(`platforms[${index}] 含有未知字段：${key}`)
      }
    }
    const platform = record.platform
    if (typeof platform !== 'string' || !PLATFORM_KEY_PATTERN.test(platform) || platform.length > 64) {
      throw invalid(
        typeof platform === 'string'
          ? `平台键格式无效：${platform}（只允许小写字母、数字与连字符）`
          : `platforms[${index}].platform 格式无效`,
      )
    }
    if (seen.has(platform)) throw invalid(`平台键重复：${platform}`)
    seen.add(platform)
    for (const field of PLATFORM_INPUT_KEYS) {
      if (!(field in record)) throw invalid(`平台 ${platform} 缺少字段：${field}`)
    }
    const displayName = record.displayName
    if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.trim().length > 64) {
      throw invalid(`平台 ${platform} 的 displayName 无效`)
    }
    if (typeof record.enabled !== 'boolean') throw invalid(`平台 ${platform} 的 enabled 无效`)
    if (typeof record.sortOrder !== 'number' || !Number.isInteger(record.sortOrder) || record.sortOrder < 0) {
      throw invalid(`平台 ${platform} 的 sortOrder 无效`)
    }
    const renderer = record.renderer
    if (typeof renderer !== 'string') throw invalid(`平台 ${platform} 的 renderer 无效`)
    if (platform === 'auto' && renderer !== 'auto') {
      throw invalid(`平台 auto 的 renderer 必须为 auto，当前为 ${renderer}`)
    }
    if (platform !== 'auto' && !PLATFORM_RENDERER_SET.has(renderer)) {
      throw invalid(`平台 ${platform} 的 renderer 无效：${renderer}`)
    }
    return {
      platform,
      displayName: displayName.trim(),
      enabled: record.enabled,
      sortOrder: record.sortOrder,
      renderer,
    }
  })
}

// Full replace: the submitted list is the final state. Keys missing from it
// are deleted, a new key is added, and a renamed key retires its old URL.
// One D1 batch is one atomic unit, so a failed statement rolls the whole
// replace back instead of leaving a half-deleted platform list.
export async function updatePlatformSettings(
  db: AppDatabase,
  input: unknown,
  now = new Date().toISOString(),
): Promise<PlatformSetting[]> {
  const entries = validatePlatformEntries(input)
  const statements = [
    db.prepare('DELETE FROM subscription_platform_settings'),
    ...entries.map((entry) =>
      db
        .prepare(
          `INSERT INTO subscription_platform_settings (platform, display_name, enabled, sort_order, renderer, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(entry.platform, entry.displayName, entry.enabled ? 1 : 0, entry.sortOrder, entry.renderer, now),
    ),
  ]
  await db.batch(statements)
  invalidatePlatformRendererCache()
  return listPlatformSettings(db)
}
