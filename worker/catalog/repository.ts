import {
  catalogSnapshotSchema,
  emptyCatalogSnapshot,
  MAX_NODES,
  upgradeCatalogSnapshot,
  type CatalogSnapshotInput,
  type CatalogSnapshot,
} from './schema.js'

export const CATALOG_KEY = 'state:catalog'
export const MAX_CATALOG_BYTES = 20 * 1024 * 1024
export { MAX_NODES }

export async function readCatalog(kv: KVNamespace): Promise<CatalogSnapshot> {
  const raw = await kv.get(CATALOG_KEY)
  if (raw === null) return emptyCatalogSnapshot()

  try {
    return upgradeCatalogSnapshot(JSON.parse(raw))
  } catch {
    throw new Error('Catalog snapshot is corrupt')
  }
}

export async function writeCatalog(
  kv: KVNamespace,
  snapshot: CatalogSnapshotInput,
  now = new Date().toISOString(),
): Promise<CatalogSnapshot> {
  let current: CatalogSnapshot
  try {
    current = upgradeCatalogSnapshot(snapshot)
  } catch {
    throw new Error('Catalog snapshot validation failed')
  }
  const result = catalogSnapshotSchema.safeParse({
    ...current,
    revision: current.revision + 1,
    updatedAt: now,
  })
  if (!result.success) throw new Error('Catalog snapshot validation failed')

  const serialized = JSON.stringify(result.data)
  if (new TextEncoder().encode(serialized).byteLength > MAX_CATALOG_BYTES) {
    throw new Error('Catalog snapshot is too large')
  }

  // ponytail: KV is last-writer-wins; move Catalog writes to a Durable Object or D1 when concurrent writers or frequent refreshes become normal.
  await kv.put(CATALOG_KEY, serialized)
  return result.data
}
