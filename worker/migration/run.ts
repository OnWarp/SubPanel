import { persistAppsSnapshot, readAppsFromD1, appsCounts, type AppsCounts } from '../apps/d1-repository.js'
import { readAppsKv } from '../apps/repository.js'
import {
  catalogCounts,
  persistCatalogSnapshot,
  readCatalogFromD1,
  type CatalogCounts,
} from '../catalog/d1-repository.js'
import { readCatalogKv } from '../catalog/repository.js'
import { APPS_D1_READY_KEY, CATALOG_D1_READY_KEY, markModuleReady, type DataEnv } from '../db/module-switch.js'
import { convertApps } from './apps.js'
import { convertCatalog } from './catalog.js'

export type MigrationModule = 'catalog' | 'apps'

export type MigrationReport = {
  module: MigrationModule
  converted: number
  skipped: number
  anomalies: string[]
  counts: CatalogCounts | AppsCounts
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

// Re-reads the KV snapshot and replaces that module's D1 rows. Safe to repeat.
// A repeat after cutover reloads D1 from KV and drops later D1-only edits.
export async function runModuleImport(
  env: DataEnv,
  module: MigrationModule,
  now = new Date().toISOString(),
): Promise<MigrationReport> {
  if (module === 'catalog') return importCatalog(env, now)
  return importApps(env, now)
}
