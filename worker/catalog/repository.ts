import { CATALOG_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { persistCatalogSnapshot, readCatalogFromD1 } from './d1-repository.js'
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

export async function readCatalogKv(kv: KVNamespace): Promise<CatalogSnapshot> {
  const raw = await kv.get(CATALOG_KEY)
  if (raw === null) return emptyCatalogSnapshot()

  try {
    return upgradeCatalogSnapshot(JSON.parse(raw))
  } catch {
    throw new Error('Catalog snapshot is corrupt')
  }
}

async function writeCatalogKv(kv: KVNamespace, serialized: string): Promise<void> {
  await kv.put(CATALOG_KEY, serialized)
}

function prepareCatalogWrite(snapshot: CatalogSnapshotInput, now: string): CatalogSnapshot {
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
  return result.data
}

export async function readCatalog(env: DataEnv): Promise<CatalogSnapshot> {
  if (await isModuleReady(env.DB, CATALOG_D1_READY_KEY)) return readCatalogFromD1(env.DB)
  return readCatalogKv(env.DATA)
}

export async function writeCatalog(
  env: DataEnv,
  snapshot: CatalogSnapshotInput,
  now = new Date().toISOString(),
): Promise<CatalogSnapshot> {
  const next = prepareCatalogWrite(snapshot, now)
  // One backend only: the import flag selects D1, and its absence keeps KV.
  if (await isModuleReady(env.DB, CATALOG_D1_READY_KEY)) await persistCatalogSnapshot(env.DB, next)
  else await writeCatalogKv(env.DATA, JSON.stringify(next))
  return next
}
