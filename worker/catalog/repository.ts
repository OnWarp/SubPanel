import { catalogDependencyChange } from '../delivery/dependencies.js'
import { CATALOG_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { apiError } from '../platform/api-error.js'
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
  if (await isModuleReady(env.DB, CATALOG_D1_READY_KEY)) {
    try {
      const current = await readCatalogFromD1(env.DB)
      const impacts = catalogDependencyChange(current, next)
      const audit = impacts.groupIds.length || impacts.directNodeIds.length
        ? env.DB.prepare(`INSERT INTO audit_logs (id, action, target_type, detail, created_at)
          SELECT ?, 'compile.invalidate.catalog', 'catalog',
            json_set(?, '$.candidateSubscriptions', (SELECT count(*) FROM (
              SELECT sg.subscription_id FROM json_each(?) changed
              JOIN subscription_groups sg ON sg.group_id=changed.value
              JOIN subscriptions s ON s.id=sg.subscription_id
              WHERE s.plan_id IS NULL OR EXISTS (
                SELECT 1 FROM plan_groups pg WHERE pg.plan_id=s.plan_id AND pg.group_id=sg.group_id
              )
              UNION
              SELECT sn.subscription_id FROM json_each(?) changed
              JOIN subscription_nodes sn ON sn.node_id=changed.value
              JOIN subscriptions s ON s.id=sn.subscription_id WHERE s.plan_id IS NULL
            ))), ?`).bind(crypto.randomUUID(), JSON.stringify(impacts),
              JSON.stringify(impacts.groupIds), JSON.stringify(impacts.directNodeIds), now)
        : undefined
      await persistCatalogSnapshot(env.DB, next, snapshot.revision, audit)
    } catch (error) {
      if (error instanceof Error && error.message.includes('NOT NULL constraint failed: system_settings.value')) {
        throw apiError(409, 'CATALOG_WRITE_CONFLICT', '目录已更新，请重新加载后再试')
      }
      if (error instanceof Error && (error.message.includes('CHECK constraint failed: length(key) > 0') || error.message.includes('ENTITLEMENT_GROUP_IN_USE'))) {
        throw apiError(409, 'GROUP_IN_USE', '请先在计划、订阅和订阅模板中更换或移除此分组')
      }
      throw error
    }
  } else {
    const current = await readCatalogKv(env.DATA)
    if (current.revision !== 0 && current.revision !== snapshot.revision) {
      throw apiError(409, 'CATALOG_WRITE_CONFLICT', '目录已更新，请重新加载后再试')
    }
    await writeCatalogKv(env.DATA, JSON.stringify(next))
  }
  return next
}
