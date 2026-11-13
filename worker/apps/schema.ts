import { z } from 'zod'

export const APPS_KEY = 'state:apps'
export const MAX_APPS_BYTES = 2 * 1024 * 1024

export const appIdSchema = z.string().regex(/^app_[1-9]\d*$/)
export const platformIdSchema = z.string().regex(/^plt_[1-9]\d*$/)
export const platformNameSchema = z.enum(['android', 'ios', 'windows', 'macos', 'linux'])

/** Display order for user-side platform categories (SubPanel_APP.md §5.2). */
export const PLATFORM_ORDER = ['windows', 'macos', 'android', 'ios', 'linux'] as const

export function platformRank(platform: z.infer<typeof platformNameSchema>): number {
  const index = (PLATFORM_ORDER as readonly string[]).indexOf(platform)
  return index === -1 ? PLATFORM_ORDER.length : index
}

const URL_MAX = 2048

export function isHttpsUrl(value: string): boolean {
  if (!/^https:\/\//iu.test(value) || value.length > URL_MAX || /[\s\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0
  } catch {
    return false
  }
}

const httpsUrlSchema = z.string().trim().min(1).max(URL_MAX).refine(isHttpsUrl, '仅允许 https 链接')
const optionalHttpsUrlSchema = z.string().trim().max(URL_MAX).refine(
  (value) => value.length === 0 || isHttpsUrl(value),
  '仅允许 https 链接',
)

const appFields = {
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(8000),
  enabled: z.boolean(),
  sortOrder: z.number().int().nonnegative().max(1_000_000),
} as const

const platformWriteFields = {
  platform: platformNameSchema,
  downloadUrl: httpsUrlSchema,
  documentationUrl: optionalHttpsUrlSchema.optional(),
  sortOrder: z.number().int().nonnegative().max(1_000_000).optional(),
} as const

export const platformWriteSchema = z.object(platformWriteFields)

export const appWriteSchema = z.object({
  ...appFields,
  platforms: z.array(platformWriteSchema).min(1).max(PLATFORM_ORDER.length),
}).superRefine((input, ctx) => {
  const seen = new Set<string>()
  for (const [index, platform] of input.platforms.entries()) {
    if (seen.has(platform.platform)) {
      ctx.addIssue({ code: 'custom', path: ['platforms', index, 'platform'], message: '同一 APP 不能重复配置相同平台' })
    }
    seen.add(platform.platform)
  }
})

export const appSchema = z.object({
  id: appIdSchema,
  name: appFields.name,
  description: appFields.description,
  enabled: appFields.enabled,
  sortOrder: appFields.sortOrder,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const platformSchema = z.object({
  id: platformIdSchema,
  appId: appIdSchema,
  platform: platformNameSchema,
  downloadUrl: httpsUrlSchema,
  documentationUrl: httpsUrlSchema.optional(),
  sortOrder: z.number().int().nonnegative().max(1_000_000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

function maxIdentifierNumber(ids: string[], prefix: string): number {
  return ids.reduce((maximum, id) => Math.max(maximum, Number(id.slice(prefix.length))), 0)
}

function validateSnapshot(snapshot: {
  nextAppId: number
  nextPlatformId: number
  apps: App[]
  platforms: Platform[]
}, ctx: z.RefinementCtx): void {
  const appIds = new Set<string>()
  const platformIds = new Set<string>()
  const platformKeys = new Set<string>()

  if (snapshot.nextAppId <= maxIdentifierNumber(snapshot.apps.map(({ id }) => id), 'app_')) {
    ctx.addIssue({ code: 'custom', path: ['nextAppId'], message: 'nextAppId must be greater than all existing app IDs' })
  }
  if (snapshot.nextPlatformId <= maxIdentifierNumber(snapshot.platforms.map(({ id }) => id), 'plt_')) {
    ctx.addIssue({ code: 'custom', path: ['nextPlatformId'], message: 'nextPlatformId must be greater than all existing platform IDs' })
  }

  for (const [index, app] of snapshot.apps.entries()) {
    if (appIds.has(app.id)) ctx.addIssue({ code: 'custom', path: ['apps', index, 'id'], message: 'Duplicate app id' })
    appIds.add(app.id)
  }

  for (const [index, platform] of snapshot.platforms.entries()) {
    if (platformIds.has(platform.id)) ctx.addIssue({ code: 'custom', path: ['platforms', index, 'id'], message: 'Duplicate platform id' })
    platformIds.add(platform.id)
    if (!appIds.has(platform.appId)) {
      ctx.addIssue({ code: 'custom', path: ['platforms', index, 'appId'], message: 'Platform references a missing app' })
    }
    const key = `${platform.appId}:${platform.platform}`
    if (platformKeys.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['platforms', index, 'platform'], message: 'Duplicate platform for app' })
    }
    platformKeys.add(key)
  }
}

export const appsSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  nextAppId: z.number().int().positive(),
  nextPlatformId: z.number().int().positive(),
  apps: z.array(appSchema),
  platforms: z.array(platformSchema),
}).superRefine(validateSnapshot)

export type AppId = z.infer<typeof appIdSchema>
export type PlatformId = z.infer<typeof platformIdSchema>
export type PlatformName = z.infer<typeof platformNameSchema>
export type AppWrite = z.infer<typeof appWriteSchema>
export type PlatformWrite = z.infer<typeof platformWriteSchema>
export type App = z.infer<typeof appSchema>
export type Platform = z.infer<typeof platformSchema>
export type AppsSnapshot = z.infer<typeof appsSnapshotSchema>

export const emptyAppsSnapshot = (now = '1970-01-01T00:00:00.000Z'): AppsSnapshot => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: now,
  nextAppId: 1,
  nextPlatformId: 1,
  apps: [],
  platforms: [],
})

/** Normalizes an optional URL field: blank input means "no link". */
export function cleanOptionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
