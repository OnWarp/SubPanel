import type { DataEnv } from '../db/module-switch.js'
import { readApps, writeApps } from './repository.js'
import {
  cleanOptionalUrl,
  platformRank,
  type App,
  type AppsSnapshot,
  type AppWrite,
  type Platform,
  type PlatformWrite,
} from './schema.js'

export class AppsError extends Error {
  readonly code: 'APP_NOT_FOUND' | 'APPS_STATE_INVALID' | 'APPS_SNAPSHOT_TOO_LARGE'

  constructor(code: AppsError['code']) {
    super(code)
    this.name = 'AppsError'
    this.code = code
  }
}

async function readOrThrow(env: DataEnv): Promise<AppsSnapshot> {
  try {
    return await readApps(env)
  } catch (error) {
    if (error instanceof Error && error.message === 'Apps snapshot is corrupt') throw new AppsError('APPS_STATE_INVALID')
    throw error
  }
}

async function save(env: DataEnv, snapshot: AppsSnapshot, now: string): Promise<AppsSnapshot> {
  try {
    return await writeApps(env, snapshot, now)
  } catch (error) {
    if (error instanceof Error && error.message === 'Apps snapshot is too large') throw new AppsError('APPS_SNAPSHOT_TOO_LARGE')
    if (error instanceof Error && error.message === 'Apps snapshot validation failed') throw new AppsError('APPS_STATE_INVALID')
    throw error
  }
}

function requireApp(snapshot: AppsSnapshot, id: string): App {
  const app = snapshot.apps.find((item) => item.id === id)
  if (!app) throw new AppsError('APP_NOT_FOUND')
  return app
}

function buildPlatform(
  id: string,
  appId: string,
  input: PlatformWrite,
  createdAt: string,
  updatedAt: string,
): Platform {
  const documentationUrl = cleanOptionalUrl(input.documentationUrl)
  return {
    id,
    appId,
    platform: input.platform,
    downloadUrl: input.downloadUrl,
    ...(documentationUrl ? { documentationUrl } : {}),
    sortOrder: input.sortOrder ?? platformRank(input.platform),
    createdAt,
    updatedAt,
  }
}

export async function readAppsState(env: DataEnv): Promise<AppsSnapshot> {
  return readOrThrow(env)
}

export async function createApp(env: DataEnv, input: AppWrite, now = new Date().toISOString()): Promise<{ app: App, platforms: Platform[] }> {
  const snapshot = await readOrThrow(env)
  const app: App = {
    id: `app_${snapshot.nextAppId}`,
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    sortOrder: input.sortOrder,
    createdAt: now,
    updatedAt: now,
  }
  let nextPlatformId = snapshot.nextPlatformId
  const platforms = input.platforms.map((platformInput) => {
    const platform = buildPlatform(`plt_${nextPlatformId}`, app.id, platformInput, now, now)
    nextPlatformId += 1
    return platform
  })
  const saved = await save(env, {
    ...snapshot,
    nextAppId: snapshot.nextAppId + 1,
    nextPlatformId,
    apps: [...snapshot.apps, app],
    platforms: [...snapshot.platforms, ...platforms],
  }, now)
  const created = saved.apps.find((item) => item.id === app.id)
  if (!created) throw new AppsError('APPS_STATE_INVALID')
  return { app: created, platforms: saved.platforms.filter((item) => item.appId === app.id) }
}

export async function updateApp(env: DataEnv, id: string, input: AppWrite, now = new Date().toISOString()): Promise<{ app: App, platforms: Platform[] }> {
  const snapshot = await readOrThrow(env)
  const current = requireApp(snapshot, id)
  const updated: App = {
    id: current.id,
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    sortOrder: input.sortOrder,
    createdAt: current.createdAt,
    updatedAt: now,
  }
  const existingByPlatform = new Map(
    snapshot.platforms.filter((item) => item.appId === id).map((item) => [item.platform, item]),
  )
  let nextPlatformId = snapshot.nextPlatformId
  const platforms = input.platforms.map((platformInput) => {
    const existing = existingByPlatform.get(platformInput.platform)
    if (existing) return buildPlatform(existing.id, id, platformInput, existing.createdAt, now)
    const platform = buildPlatform(`plt_${nextPlatformId}`, id, platformInput, now, now)
    nextPlatformId += 1
    return platform
  })
  const saved = await save(env, {
    ...snapshot,
    nextPlatformId,
    apps: snapshot.apps.map((item) => item.id === id ? updated : item),
    platforms: [...snapshot.platforms.filter((item) => item.appId !== id), ...platforms],
  }, now)
  const stored = saved.apps.find((item) => item.id === id)
  if (!stored) throw new AppsError('APPS_STATE_INVALID')
  return { app: stored, platforms: saved.platforms.filter((item) => item.appId === id) }
}

export async function setAppEnabled(env: DataEnv, id: string, enabled: boolean, now = new Date().toISOString()): Promise<App> {
  const snapshot = await readOrThrow(env)
  const current = requireApp(snapshot, id)
  const updated: App = { ...current, enabled, updatedAt: now }
  const saved = await save(env, {
    ...snapshot,
    apps: snapshot.apps.map((item) => item.id === id ? updated : item),
  }, now)
  const stored = saved.apps.find((item) => item.id === id)
  if (!stored) throw new AppsError('APPS_STATE_INVALID')
  return stored
}

export async function deleteApp(env: DataEnv, id: string, now = new Date().toISOString()): Promise<void> {
  const snapshot = await readOrThrow(env)
  requireApp(snapshot, id)
  await save(env, {
    ...snapshot,
    apps: snapshot.apps.filter((item) => item.id !== id),
    platforms: snapshot.platforms.filter((item) => item.appId !== id),
  }, now)
}
