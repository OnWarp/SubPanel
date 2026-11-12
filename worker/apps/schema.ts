import { z } from 'zod'

export const APPS_KEY = 'state:apps'
export const MAX_APPS_BYTES = 2 * 1024 * 1024

export const appIdSchema = z.string().regex(/^app_[1-9]\d*$/)
export const platformIdSchema = z.string().regex(/^plt_[1-9]\d*$/)
export const platformNameSchema = z.enum(['android', 'ios', 'windows', 'macos', 'linux'])

const URL_MAX = 2048

export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value) || value.length > URL_MAX || /[\s\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

const httpUrlSchema = z.string().trim().min(1).max(URL_MAX).refine(isHttpUrl, '仅允许 http 或 https 链接')
const optionalHttpUrlSchema = z.string().trim().max(URL_MAX).refine(
  (value) => value.length === 0 || isHttpUrl(value),
  '仅允许 http 或 https 链接',
)

export const appFlagsSchema = z.object({
  isRecommended: z.boolean(),
  isOfficial: z.boolean(),
  isPopular: z.boolean(),
  isEnabled: z.boolean(),
  isPublic: z.boolean(),
})

const appFields = {
  name: z.string().trim().min(1).max(128),
  icon: optionalHttpUrlSchema,
  summary: z.string().trim().max(512),
  description: z.string().trim().max(8000),
  category: z.string().trim().min(1).max(64),
  officialWebsite: optionalHttpUrlSchema,
  developer: z.union([z.string().trim().max(128), z.null()]).optional(),
  flags: appFlagsSchema,
  sortOrder: z.number().int().nonnegative().max(1_000_000),
} as const

export const appWriteSchema = z.object(appFields)

const platformFields = {
  platform: platformNameSchema,
  version: z.string().trim().min(1).max(64),
  downloadUrl: httpUrlSchema,
  downloadType: z.string().trim().min(1).max(64),
  fileSizeKb: z.number().int().nonnegative().max(2_000_000_000).nullable().optional(),
  officialStoreUrl: optionalHttpUrlSchema,
  officialDownloadUrl: optionalHttpUrlSchema,
  updateNotes: z.string().trim().max(8000),
  importSupported: z.boolean(),
  importProtocol: z.string().trim().max(64),
  importUrlTemplate: z.string().trim().max(2048),
  importInstructions: z.string().trim().max(4000),
  isEnabled: z.boolean(),
} as const

export const platformWriteSchema = z.object(platformFields)

export const appSchema = z.object({
  id: appIdSchema,
  name: appFields.name,
  icon: appFields.icon,
  summary: appFields.summary,
  description: appFields.description,
  category: appFields.category,
  officialWebsite: appFields.officialWebsite,
  developer: z.string().trim().min(1).max(128).optional(),
  flags: appFlagsSchema,
  sortOrder: appFields.sortOrder,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const platformSchema = z.object({
  id: platformIdSchema,
  appId: appIdSchema,
  platform: platformFields.platform,
  version: platformFields.version,
  downloadUrl: platformFields.downloadUrl,
  downloadType: platformFields.downloadType,
  fileSizeKb: z.number().int().nonnegative().max(2_000_000_000).optional(),
  officialStoreUrl: platformFields.officialStoreUrl,
  officialDownloadUrl: platformFields.officialDownloadUrl,
  updateNotes: platformFields.updateNotes,
  importSupported: platformFields.importSupported,
  importProtocol: platformFields.importProtocol,
  importUrlTemplate: platformFields.importUrlTemplate,
  importInstructions: platformFields.importInstructions,
  isEnabled: platformFields.isEnabled,
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
export type AppFlags = z.infer<typeof appFlagsSchema>
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

export function cleanDeveloper(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function cleanFileSizeKb(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : value
}
