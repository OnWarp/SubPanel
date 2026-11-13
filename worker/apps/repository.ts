import { APPS_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { persistAppsSnapshot, readAppsFromD1 } from './d1-repository.js'
import {
  APPS_KEY,
  MAX_APPS_BYTES,
  appsSnapshotSchema,
  emptyAppsSnapshot,
  type AppsSnapshot,
} from './schema.js'

export { APPS_KEY, MAX_APPS_BYTES }

export async function readAppsKv(kv: KVNamespace): Promise<AppsSnapshot> {
  const raw = await kv.get(APPS_KEY)
  if (raw === null) return emptyAppsSnapshot()

  try {
    return appsSnapshotSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Apps snapshot is corrupt')
  }
}

function prepareAppsWrite(snapshot: AppsSnapshot, now: string): AppsSnapshot {
  const result = appsSnapshotSchema.safeParse({
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt: now,
  })
  if (!result.success) throw new Error('Apps snapshot validation failed')

  const serialized = JSON.stringify(result.data)
  if (new TextEncoder().encode(serialized).byteLength > MAX_APPS_BYTES) {
    throw new Error('Apps snapshot is too large')
  }
  return result.data
}

export async function readApps(env: DataEnv): Promise<AppsSnapshot> {
  if (await isModuleReady(env.DB, APPS_D1_READY_KEY)) return readAppsFromD1(env.DB)
  return readAppsKv(env.DATA)
}

export async function writeApps(
  env: DataEnv,
  snapshot: AppsSnapshot,
  now = new Date().toISOString(),
): Promise<AppsSnapshot> {
  const next = prepareAppsWrite(snapshot, now)
  if (await isModuleReady(env.DB, APPS_D1_READY_KEY)) await persistAppsSnapshot(env.DB, next)
  else await env.DATA.put(APPS_KEY, JSON.stringify(next))
  return next
}
