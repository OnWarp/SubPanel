import { Hono } from 'hono'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { appIdSchema, appWriteSchema, platformIdSchema, platformWriteSchema, type App, type AppsSnapshot, type Platform, type PlatformName } from './schema.js'
import {
  AppsError,
  createApp,
  createPlatform,
  deleteApp,
  deletePlatform,
  readAppsState,
  updateApp,
  updatePlatform,
} from './service.js'

const PLATFORM_RANK: Record<PlatformName, number> = {
  android: 0,
  ios: 1,
  windows: 2,
  macos: 3,
  linux: 4,
}

function requireAppId(value: string | undefined): string {
  const parsed = appIdSchema.safeParse(value ?? '')
  if (!parsed.success) throw apiError(404, 'APP_NOT_FOUND', '应用不存在')
  return parsed.data
}

function requirePlatformId(value: string | undefined): string {
  const parsed = platformIdSchema.safeParse(value ?? '')
  if (!parsed.success) throw apiError(404, 'PLATFORM_NOT_FOUND', '平台配置不存在')
  return parsed.data
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AppsError) {
      if (error.code === 'APP_NOT_FOUND') throw apiError(404, error.code, '应用不存在')
      if (error.code === 'PLATFORM_NOT_FOUND') throw apiError(404, error.code, '平台配置不存在')
      if (error.code === 'APPS_SNAPSHOT_TOO_LARGE') throw apiError(413, error.code, '应用数据超过大小限制')
      throw apiError(500, 'APPS_STATE_INVALID', '应用数据不可用')
    }
    throw error
  }
}

function toPublicPlatform(platform: Platform) {
  return {
    id: platform.id,
    appId: platform.appId,
    platform: platform.platform,
    version: platform.version,
    downloadUrl: platform.downloadUrl,
    downloadType: platform.downloadType,
    fileSizeKb: platform.fileSizeKb ?? null,
    officialStoreUrl: platform.officialStoreUrl,
    officialDownloadUrl: platform.officialDownloadUrl,
    updateNotes: platform.updateNotes,
    importSupported: platform.importSupported,
    importProtocol: platform.importProtocol,
    importUrlTemplate: platform.importUrlTemplate,
    importInstructions: platform.importInstructions,
    isEnabled: platform.isEnabled,
    createdAt: platform.createdAt,
    updatedAt: platform.updatedAt,
  }
}

function toPublicApp(app: App, platforms: Platform[]) {
  return {
    id: app.id,
    name: app.name,
    icon: app.icon,
    summary: app.summary,
    description: app.description,
    category: app.category,
    officialWebsite: app.officialWebsite,
    developer: app.developer ?? null,
    flags: {
      isRecommended: app.flags.isRecommended,
      isOfficial: app.flags.isOfficial,
      isPopular: app.flags.isPopular,
      isEnabled: app.flags.isEnabled,
      isPublic: app.flags.isPublic,
    },
    sortOrder: app.sortOrder,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    platforms: platforms
      .filter((item) => item.appId === app.id && item.isEnabled)
      .sort((left, right) => PLATFORM_RANK[left.platform] - PLATFORM_RANK[right.platform]
        || left.version.localeCompare(right.version, 'zh-CN')
        || left.id.localeCompare(right.id))
      .map(toPublicPlatform),
  }
}

function toPublicApps(snapshot: AppsSnapshot) {
  return snapshot.apps
    .filter((app) => app.flags.isEnabled && app.flags.isPublic)
    .sort((left, right) => left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name, 'zh-CN')
      || left.id.localeCompare(right.id))
    .map((app) => toPublicApp(app, snapshot.platforms))
}

export const adminAppRoutes = new Hono<AppEnv>()

adminAppRoutes.get('/', async (c) => {
  const snapshot = await run(() => readAppsState(c.env))
  return c.json({
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    apps: snapshot.apps,
    platforms: snapshot.platforms,
  })
})

adminAppRoutes.post('/', async (c) => {
  const input = await readJson(c, appWriteSchema)
  const app = await run(() => createApp(c.env, input))
  return c.json({ app }, 201)
})

adminAppRoutes.put('/:id', async (c) => {
  const id = requireAppId(c.req.param('id'))
  const input = await readJson(c, appWriteSchema)
  const app = await run(() => updateApp(c.env, id, input))
  return c.json({ app })
})

adminAppRoutes.delete('/:id', async (c) => {
  const id = requireAppId(c.req.param('id'))
  await run(() => deleteApp(c.env, id))
  return c.body(null, 204)
})

adminAppRoutes.post('/:id/platforms', async (c) => {
  const appId = requireAppId(c.req.param('id'))
  const input = await readJson(c, platformWriteSchema)
  const platform = await run(() => createPlatform(c.env, appId, input))
  return c.json({ platform }, 201)
})

adminAppRoutes.put('/:appId/platforms/:pid', async (c) => {
  const appId = requireAppId(c.req.param('appId'))
  const platformId = requirePlatformId(c.req.param('pid'))
  const input = await readJson(c, platformWriteSchema)
  const platform = await run(() => updatePlatform(c.env, appId, platformId, input))
  return c.json({ platform })
})

adminAppRoutes.delete('/:appId/platforms/:pid', async (c) => {
  const appId = requireAppId(c.req.param('appId'))
  const platformId = requirePlatformId(c.req.param('pid'))
  await run(() => deletePlatform(c.env, appId, platformId))
  return c.body(null, 204)
})

export const userAppRoutes = new Hono<AppEnv>()

userAppRoutes.get('/', async (c) => {
  const snapshot = await run(() => readAppsState(c.env))
  return c.json({ apps: toPublicApps(snapshot) })
})

userAppRoutes.get('/:id', async (c) => {
  const id = requireAppId(c.req.param('id'))
  const snapshot = await run(() => readAppsState(c.env))
  const app = snapshot.apps.find((item) => item.id === id)
  if (!app || !app.flags.isEnabled || !app.flags.isPublic) throw apiError(404, 'APP_NOT_FOUND', '应用不存在')
  return c.json({ app: toPublicApp(app, snapshot.platforms) })
})
