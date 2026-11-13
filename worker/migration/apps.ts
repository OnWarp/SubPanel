import { z } from 'zod'
import { appsSnapshotSchema, type AppsSnapshot } from '../apps/schema.js'

// Snapshot superRefine rejects dangling platform→app links. Those are anomalies.
const structuralAppsSnapshotSchema = z.object(appsSnapshotSchema.shape)

export interface ConversionReport {
  converted: number
  skipped: number
  anomalies: string[]
}

export interface AppsConversionResult {
  rows: {
    apps: AppRow[]
    app_platforms: AppPlatformRow[]
  }
  report: ConversionReport
}

export interface AppRow {
  id: string
  name: string
  description: string
  enabled: 0 | 1
  sort_order: number
  created_at: string
  updated_at: string
}

export interface AppPlatformRow {
  id: string
  app_id: string
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux'
  download_url: string
  documentation_url: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export function convertApps(kvValue: unknown): AppsConversionResult {
  const report: ConversionReport = { converted: 0, skipped: 0, anomalies: [] }
  const strict = appsSnapshotSchema.safeParse(kvValue)
  const snapshot = (strict.success ? strict.data : structuralAppsSnapshotSchema.parse(kvValue)) as AppsSnapshot

  const appIdSet = new Set(snapshot.apps.map((a) => a.id))

  const apps: AppRow[] = snapshot.apps.map((app) => ({
    id: app.id,
    name: app.name,
    description: app.description,
    enabled: app.enabled ? 1 : 0,
    sort_order: app.sortOrder,
    created_at: app.createdAt,
    updated_at: app.updatedAt,
  }))

  const app_platforms: AppPlatformRow[] = []
  for (const platform of snapshot.platforms) {
    if (!appIdSet.has(platform.appId)) {
      report.anomalies.push(`Platform ${platform.id} references missing app ${platform.appId}`)
      report.skipped++
      continue
    }

    app_platforms.push({
      id: platform.id,
      app_id: platform.appId,
      platform: platform.platform,
      download_url: platform.downloadUrl,
      documentation_url: platform.documentationUrl ?? null,
      sort_order: platform.sortOrder,
      created_at: platform.createdAt,
      updated_at: platform.updatedAt,
    })
  }

  report.converted = apps.length + app_platforms.length

  return { rows: { apps, app_platforms }, report }
}
