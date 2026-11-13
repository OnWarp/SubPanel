import type { DataEnv } from '../db/module-switch.js'
import { readApps, writeApps } from './repository.js'
import {
  cleanDeveloper,
  cleanFileSizeKb,
  type App,
  type AppsSnapshot,
  type AppWrite,
  type Platform,
  type PlatformWrite,
} from './schema.js'

export class AppsError extends Error {
  readonly code: 'APP_NOT_FOUND' | 'PLATFORM_NOT_FOUND' | 'APPS_STATE_INVALID' | 'APPS_SNAPSHOT_TOO_LARGE'

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

function requirePlatform(snapshot: AppsSnapshot, appId: string, platformId: string): Platform {
  const platform = snapshot.platforms.find((item) => item.id === platformId)
  if (!platform || platform.appId !== appId) throw new AppsError('PLATFORM_NOT_FOUND')
  return platform
}

function buildApp(id: string, input: AppWrite, createdAt: string, updatedAt: string): App {
  const developer = cleanDeveloper(input.developer)
  return {
    id,
    name: input.name,
    icon: input.icon,
    summary: input.summary,
    description: input.description,
    category: input.category,
    officialWebsite: input.officialWebsite,
    ...(developer ? { developer } : {}),
    flags: input.flags,
    sortOrder: input.sortOrder,
    createdAt,
    updatedAt,
  }
}

function buildPlatform(id: string, appId: string, input: PlatformWrite, createdAt: string, updatedAt: string): Platform {
  const fileSizeKb = cleanFileSizeKb(input.fileSizeKb)
  return {
    id,
    appId,
    platform: input.platform,
    version: input.version,
    downloadUrl: input.downloadUrl,
    downloadType: input.downloadType,
    ...(fileSizeKb !== undefined ? { fileSizeKb } : {}),
    officialStoreUrl: input.officialStoreUrl,
    officialDownloadUrl: input.officialDownloadUrl,
    updateNotes: input.updateNotes,
    importSupported: input.importSupported,
    importProtocol: input.importProtocol,
    importUrlTemplate: input.importUrlTemplate,
    importInstructions: input.importInstructions,
    isEnabled: input.isEnabled,
    createdAt,
    updatedAt,
  }
}

export async function readAppsState(env: DataEnv): Promise<AppsSnapshot> {
  return readOrThrow(env)
}

export async function createApp(env: DataEnv, input: AppWrite, now = new Date().toISOString()): Promise<App> {
  const snapshot = await readOrThrow(env)
  const app = buildApp(`app_${snapshot.nextAppId}`, input, now, now)
  const saved = await save(env, {
    ...snapshot,
    nextAppId: snapshot.nextAppId + 1,
    apps: [...snapshot.apps, app],
  }, now)
  const created = saved.apps.find((item) => item.id === app.id)
  if (!created) throw new AppsError('APPS_STATE_INVALID')
  return created
}

export async function updateApp(env: DataEnv, id: string, input: AppWrite, now = new Date().toISOString()): Promise<App> {
  const snapshot = await readOrThrow(env)
  const current = requireApp(snapshot, id)
  const updated = buildApp(current.id, input, current.createdAt, now)
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

export async function createPlatform(
  env: DataEnv,
  appId: string,
  input: PlatformWrite,
  now = new Date().toISOString(),
): Promise<Platform> {
  const snapshot = await readOrThrow(env)
  requireApp(snapshot, appId)
  const platform = buildPlatform(`plt_${snapshot.nextPlatformId}`, appId, input, now, now)
  const saved = await save(env, {
    ...snapshot,
    nextPlatformId: snapshot.nextPlatformId + 1,
    platforms: [...snapshot.platforms, platform],
  }, now)
  const created = saved.platforms.find((item) => item.id === platform.id)
  if (!created) throw new AppsError('APPS_STATE_INVALID')
  return created
}

export async function updatePlatform(
  env: DataEnv,
  appId: string,
  platformId: string,
  input: PlatformWrite,
  now = new Date().toISOString(),
): Promise<Platform> {
  const snapshot = await readOrThrow(env)
  requireApp(snapshot, appId)
  const current = requirePlatform(snapshot, appId, platformId)
  const updated = buildPlatform(current.id, appId, input, current.createdAt, now)
  const saved = await save(env, {
    ...snapshot,
    platforms: snapshot.platforms.map((item) => item.id === platformId ? updated : item),
  }, now)
  const stored = saved.platforms.find((item) => item.id === platformId)
  if (!stored) throw new AppsError('APPS_STATE_INVALID')
  return stored
}

export async function deletePlatform(
  env: DataEnv,
  appId: string,
  platformId: string,
  now = new Date().toISOString(),
): Promise<void> {
  const snapshot = await readOrThrow(env)
  requireApp(snapshot, appId)
  requirePlatform(snapshot, appId, platformId)
  await save(env, {
    ...snapshot,
    platforms: snapshot.platforms.filter((item) => item.id !== platformId),
  }, now)
}
