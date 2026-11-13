import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { getShowAppDownloads } from '../db/settings-repository.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import {
  appIdSchema,
  appWriteSchema,
  isHttpsUrl,
  platformRank,
  type App,
  type AppsSnapshot,
  type Platform,
} from './schema.js'
import {
  AppsError,
  createApp,
  deleteApp,
  readAppsState,
  setAppEnabled,
  updateApp,
} from './service.js'

function requireAppId(value: string | undefined): string {
  const parsed = appIdSchema.safeParse(value ?? '')
  if (!parsed.success) throw apiError(404, 'APP_NOT_FOUND', '应用不存在')
  return parsed.data
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AppsError) {
      if (error.code === 'APP_NOT_FOUND') throw apiError(404, error.code, '应用不存在')
      if (error.code === 'APPS_SNAPSHOT_TOO_LARGE') throw apiError(413, error.code, '应用数据超过大小限制')
      throw apiError(500, 'APPS_STATE_INVALID', '应用数据不可用')
    }
    throw error
  }
}

function sortedPlatforms(platforms: Platform[]): Platform[] {
  return [...platforms].sort((left, right) => left.sortOrder - right.sortOrder
    || platformRank(left.platform) - platformRank(right.platform)
    || left.id.localeCompare(right.id))
}

function toAdminApp(app: App, platforms: Platform[]) {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    enabled: app.enabled,
    sortOrder: app.sortOrder,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    platforms: sortedPlatforms(platforms.filter((item) => item.appId === app.id)).map((platform) => ({
      id: platform.id,
      platform: platform.platform,
      downloadUrl: platform.downloadUrl,
      documentationUrl: platform.documentationUrl ?? null,
      sortOrder: platform.sortOrder,
      createdAt: platform.createdAt,
      updatedAt: platform.updatedAt,
    })),
  }
}

function toPublicApp(app: App, platforms: Platform[]) {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    sortOrder: app.sortOrder,
    platforms: sortedPlatforms(platforms.filter((item) => item.appId === app.id && isHttpsUrl(item.downloadUrl)))
      .map((platform) => ({
        id: platform.id,
        platform: platform.platform,
        downloadUrl: platform.downloadUrl,
        documentationUrl: platform.documentationUrl ?? null,
        sortOrder: platform.sortOrder,
      })),
  }
}

function toPublicApps(snapshot: AppsSnapshot) {
  return snapshot.apps
    .filter((app) => app.enabled)
    .sort((left, right) => left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name, 'zh-CN')
      || left.id.localeCompare(right.id))
    .map((app) => toPublicApp(app, snapshot.platforms))
    .filter((app) => app.platforms.length > 0)
}

export const adminAppRoutes = new Hono<AppEnv>()

adminAppRoutes.get('/', async (c) => {
  const snapshot = await run(() => readAppsState(c.env))
  return c.json({
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    apps: snapshot.apps.map((app) => toAdminApp(app, snapshot.platforms)),
  })
})

adminAppRoutes.post('/', async (c) => {
  const input = await readJson(c, appWriteSchema)
  const { app, platforms } = await run(() => createApp(c.env, input))
  return c.json({ app: toAdminApp(app, platforms) }, 201)
})

adminAppRoutes.put('/:id', async (c) => {
  const id = requireAppId(c.req.param('id'))
  const input = await readJson(c, appWriteSchema)
  const { app, platforms } = await run(() => updateApp(c.env, id, input))
  return c.json({ app: toAdminApp(app, platforms) })
})

const enabledBodySchema = z.object({ enabled: z.boolean() }).strict()

adminAppRoutes.post('/:id/enabled', async (c) => {
  const id = requireAppId(c.req.param('id'))
  const input = await readJson(c, enabledBodySchema)
  const app = await run(() => setAppEnabled(c.env, id, input.enabled))
  const snapshot = await run(() => readAppsState(c.env))
  return c.json({ app: toAdminApp(app, snapshot.platforms) })
})

adminAppRoutes.delete('/:id', async (c) => {
  const id = requireAppId(c.req.param('id'))
  await run(() => deleteApp(c.env, id))
  return c.body(null, 204)
})

export const userAppRoutes = new Hono<AppEnv>()

userAppRoutes.get('/', async (c) => {
  if (!(await getShowAppDownloads(c.env.DB))) {
    return c.json({ downloadsEnabled: false, apps: [] })
  }
  const snapshot = await run(() => readAppsState(c.env))
  return c.json({ downloadsEnabled: true, apps: toPublicApps(snapshot) })
})

userAppRoutes.get('/:id', async (c) => {
  const id = requireAppId(c.req.param('id'))
  if (!(await getShowAppDownloads(c.env.DB))) {
    throw apiError(404, 'APP_NOT_FOUND', '应用不存在')
  }
  const snapshot = await run(() => readAppsState(c.env))
  const app = snapshot.apps.find((item) => item.id === id)
  if (!app || !app.enabled) throw apiError(404, 'APP_NOT_FOUND', '应用不存在')
  const publicApp = toPublicApp(app, snapshot.platforms)
  if (publicApp.platforms.length === 0) throw apiError(404, 'APP_NOT_FOUND', '应用不存在')
  return c.json({ app: publicApp })
})
