import { readAccounts } from '../accounts/repository.js'
import { persistAppsSnapshot, readAppsFromD1, appsCounts, type AppsCounts } from '../apps/d1-repository.js'
import { readAppsKv } from '../apps/repository.js'
import {
  catalogCounts,
  persistCatalogSnapshot,
  readCatalogFromD1,
  type CatalogCounts,
} from '../catalog/d1-repository.js'
import { readCatalogKv } from '../catalog/repository.js'
import {
  deliveryCounts,
  persistDeliverySnapshot,
  readDeliveryFromD1,
  type DeliveryCounts,
} from '../delivery/d1-repository.js'
import { readDeliveryKv } from '../delivery/repository.js'
import {
  APPS_D1_READY_KEY,
  CATALOG_D1_READY_KEY,
  DELIVERY_D1_READY_KEY,
  SHARES_D1_READY_KEY,
  markModuleReady,
  type DataEnv,
} from '../db/module-switch.js'
import {
  listSharesFromD1,
  persistSharesSnapshot,
  readNextShareId,
  sharesCounts,
  type SharesCounts,
} from '../shares/d1-repository.js'
import { readShareSeqKv, readShareSettingsKv, readShareValuesKv } from '../shares/repository.js'
import { getShareSettings } from '../db/settings-repository.js'
import { shareRecordSchema, type ShareRecord } from '../shares/schema.js'
import { convertApps } from './apps.js'
import { convertCatalog } from './catalog.js'
import { convertDelivery } from './delivery.js'
import { convertShares } from './shares.js'

export type MigrationModule = 'catalog' | 'apps' | 'delivery' | 'shares'

export type MigrationReport = {
  module: MigrationModule
  converted: number
  skipped: number
  anomalies: string[]
  counts: CatalogCounts | AppsCounts | DeliveryCounts | SharesCounts
  ready: boolean
}

export class MigrationError extends Error {
  readonly code: 'MIGRATION_SOURCE_INVALID' | 'MIGRATION_VERIFY_FAILED'
  readonly report?: MigrationReport

  constructor(code: MigrationError['code'], message: string, report?: MigrationReport) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
    this.report = report
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function importCatalog(env: DataEnv, now: string): Promise<MigrationReport> {
  let snapshot
  try {
    snapshot = await readCatalogKv(env.DATA)
  } catch {
    throw new MigrationError('MIGRATION_SOURCE_INVALID', 'Catalog 快照无法读取')
  }
  const converted = convertCatalog(snapshot)
  await persistCatalogSnapshot(env.DB, snapshot)
  let stored
  try {
    stored = await readCatalogFromD1(env.DB)
  } catch {
    stored = null
  }
  const counts = await catalogCounts(env.DB)
  const rows = converted.rows
  const countsMatch = counts.sources === rows.sources.length
    && counts.nodes === rows.nodes.length
    && counts.nodeRawVariants === rows.node_raw_variants.length
    && counts.groups === rows.groups.length
    && counts.groupSources === rows.group_sources.length
    && counts.groupNodes === rows.group_nodes.length
    && counts.groupNodeOrder === rows.group_node_order.length
  const relationsMatch = stored !== null && sameJson(stored, snapshot)
  const report: MigrationReport = {
    module: 'catalog',
    converted: converted.report.converted,
    skipped: converted.report.skipped,
    anomalies: converted.report.anomalies,
    counts,
    ready: false,
  }
  if (!countsMatch || !relationsMatch) {
    throw new MigrationError('MIGRATION_VERIFY_FAILED', 'Catalog 迁移校验未通过', report)
  }
  await markModuleReady(env.DB, CATALOG_D1_READY_KEY, now)
  return { ...report, ready: true }
}

async function importApps(env: DataEnv, now: string): Promise<MigrationReport> {
  let snapshot
  try {
    snapshot = await readAppsKv(env.DATA)
  } catch {
    throw new MigrationError('MIGRATION_SOURCE_INVALID', '应用快照无法读取')
  }
  const converted = convertApps(snapshot)
  await persistAppsSnapshot(env.DB, snapshot)
  let stored
  try {
    stored = await readAppsFromD1(env.DB)
  } catch {
    stored = null
  }
  const counts = await appsCounts(env.DB)
  const countsMatch = counts.apps === converted.rows.apps.length
    && counts.platforms === converted.rows.app_platforms.length
  const relationsMatch = stored !== null && sameJson(stored, snapshot)
  const report: MigrationReport = {
    module: 'apps',
    converted: converted.report.converted,
    skipped: converted.report.skipped,
    anomalies: converted.report.anomalies,
    counts,
    ready: false,
  }
  if (!countsMatch || !relationsMatch) {
    throw new MigrationError('MIGRATION_VERIFY_FAILED', '应用迁移校验未通过', report)
  }
  await markModuleReady(env.DB, APPS_D1_READY_KEY, now)
  return { ...report, ready: true }
}

async function importDelivery(env: DataEnv, now: string): Promise<MigrationReport> {
  let snapshot
  try {
    snapshot = await readDeliveryKv(env.DATA)
  } catch {
    throw new MigrationError('MIGRATION_SOURCE_INVALID', '订阅快照无法读取')
  }
  const converted = convertDelivery(snapshot)
  const accounts = await readAccounts(env)
  try {
    await persistDeliverySnapshot(env.DB, snapshot, accounts.users)
  } catch {
    const counts = await deliveryCounts(env.DB).catch(() => ({ subscriptions: 0, subscriptionGroups: 0 }))
    throw new MigrationError('MIGRATION_VERIFY_FAILED', '订阅迁移校验未通过', {
      module: 'delivery',
      converted: converted.report.converted,
      skipped: converted.report.skipped,
      anomalies: converted.report.anomalies,
      counts,
      ready: false,
    })
  }
  let stored
  try {
    stored = await readDeliveryFromD1(env.DB)
  } catch {
    stored = null
  }
  const counts = await deliveryCounts(env.DB)
  const countsMatch = counts.subscriptions === converted.rows.subscriptions.length
    && counts.subscriptionGroups === converted.rows.subscription_groups.length
  const relationsMatch = stored !== null && sameJson(stored, snapshot)
  const report: MigrationReport = {
    module: 'delivery',
    converted: converted.report.converted,
    skipped: converted.report.skipped,
    anomalies: converted.report.anomalies,
    counts,
    ready: false,
  }
  if (!countsMatch || !relationsMatch) {
    throw new MigrationError('MIGRATION_VERIFY_FAILED', '订阅迁移校验未通过', report)
  }
  await markModuleReady(env.DB, DELIVERY_D1_READY_KEY, now)
  return { ...report, ready: true }
}

function sortShares(records: readonly ShareRecord[]): ShareRecord[] {
  return [...records].sort((left, right) => left.id.localeCompare(right.id))
}

async function importShares(env: DataEnv, now: string): Promise<MigrationReport> {
  let values: unknown[]
  let settings
  let nextShareId: number
  try {
    values = await readShareValuesKv(env.DATA)
    settings = await readShareSettingsKv(env.DATA)
    nextShareId = await readShareSeqKv(env.DATA)
  } catch {
    throw new MigrationError('MIGRATION_SOURCE_INVALID', '分享数据无法读取')
  }
  const converted = convertShares(values, settings)
  const records: ShareRecord[] = []
  for (const value of values) {
    const parsed = shareRecordSchema.safeParse(value)
    if (parsed.success) records.push(parsed.data)
  }
  const uniqueRecords: ShareRecord[] = []
  const seenHash = new Set<string>()
  const seenId = new Set<string>()
  for (const record of records) {
    if (seenHash.has(record.tokenHash) || seenId.has(record.id)) continue
    seenHash.add(record.tokenHash)
    seenId.add(record.id)
    uniqueRecords.push(record)
  }
  const accounts = await readAccounts(env)
  const reportBase = {
    module: 'shares' as const,
    converted: converted.report.converted,
    skipped: converted.report.skipped,
    anomalies: converted.report.anomalies,
    ready: false,
  }
  try {
    await persistSharesSnapshot(env.DB, uniqueRecords, settings, nextShareId, accounts.users, now)
  } catch {
    const counts = await sharesCounts(env.DB).catch(() => ({ shares: 0, shareSettings: 0 }))
    throw new MigrationError('MIGRATION_VERIFY_FAILED', '分享迁移校验未通过', { ...reportBase, counts })
  }
  let stored: ShareRecord[] | null
  try {
    stored = await listSharesFromD1(env.DB)
  } catch {
    stored = null
  }
  const counts = await sharesCounts(env.DB)
  let storedSettings
  let storedNext = 0
  try {
    storedSettings = await getShareSettings(env.DB)
    storedNext = await readNextShareId(env.DB)
  } catch {
    storedSettings = null
  }
  const countsMatch = counts.shares === uniqueRecords.length && counts.shareSettings === 1
  const relationsMatch = stored !== null
    && storedSettings !== null
    && sameJson(sortShares(stored), sortShares(uniqueRecords))
    && sameJson(storedSettings, settings)
    && storedNext === nextShareId
  const report: MigrationReport = { ...reportBase, counts }
  if (!countsMatch || !relationsMatch || converted.report.anomalies.length > 0) {
    throw new MigrationError('MIGRATION_VERIFY_FAILED', '分享迁移校验未通过', report)
  }
  await markModuleReady(env.DB, SHARES_D1_READY_KEY, now)
  return { ...report, ready: true }
}

// Re-reads the KV snapshot and replaces that module's D1 rows. Safe to repeat.
// A repeat after cutover reloads D1 from KV and drops later D1-only edits.
export async function runModuleImport(
  env: DataEnv,
  module: MigrationModule,
  now = new Date().toISOString(),
): Promise<MigrationReport> {
  if (module === 'catalog') return importCatalog(env, now)
  if (module === 'apps') return importApps(env, now)
  if (module === 'delivery') return importDelivery(env, now)
  return importShares(env, now)
}
