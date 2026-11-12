import {
  APPS_KEY,
  MAX_APPS_BYTES,
  appsSnapshotSchema,
  emptyAppsSnapshot,
  type AppsSnapshot,
} from './schema.js'

export { APPS_KEY, MAX_APPS_BYTES }

export async function readApps(kv: KVNamespace): Promise<AppsSnapshot> {
  const raw = await kv.get(APPS_KEY)
  if (raw === null) return emptyAppsSnapshot()

  try {
    return appsSnapshotSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Apps snapshot is corrupt')
  }
}

export async function writeApps(
  kv: KVNamespace,
  snapshot: AppsSnapshot,
  now = new Date().toISOString(),
): Promise<AppsSnapshot> {
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

  // ponytail: KV is last-writer-wins. Concurrent admin edits can overwrite a snapshot; move app writes to a Durable Object if overlapping edits become normal.
  await kv.put(APPS_KEY, serialized)
  return result.data
}
