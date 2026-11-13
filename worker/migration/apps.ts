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
  icon: string
  summary: string
  description: string
  category: string
  official_website: string
  developer: string | null
  is_recommended: 0 | 1
  is_official: 0 | 1
  is_popular: 0 | 1
  is_enabled: 0 | 1
  is_public: 0 | 1
  sort_order: number
  created_at: string
  updated_at: string
}

export interface AppPlatformRow {
  id: string
  app_id: string
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux'
  version: string
  download_url: string
  download_type: string
  file_size_kb: number | null
  official_store_url: string
  official_download_url: string
  update_notes: string
  import_supported: 0 | 1
  import_protocol: string
  import_url_template: string
  import_instructions: string
  is_enabled: 0 | 1
  created_at: string
  updated_at: string
}

export function convertApps(kvValue: unknown): AppsConversionResult {
  const report: ConversionReport = { converted: 0, skipped: 0, anomalies: [] }
  const strict = appsSnapshotSchema.safeParse(kvValue)
  const snapshot = (strict.success ? strict.data : structuralAppsSnapshotSchema.parse(kvValue)) as AppsSnapshot

  const appIdSet = new Set(snapshot.apps.map((a) => a.id))

  // Convert apps
  const apps: AppRow[] = snapshot.apps.map((app) => ({
    id: app.id,
    name: app.name,
    icon: app.icon,
    summary: app.summary,
    description: app.description,
    category: app.category,
    official_website: app.officialWebsite,
    developer: app.developer ?? null,
    is_recommended: app.flags.isRecommended ? 1 : 0,
    is_official: app.flags.isOfficial ? 1 : 0,
    is_popular: app.flags.isPopular ? 1 : 0,
    is_enabled: app.flags.isEnabled ? 1 : 0,
    is_public: app.flags.isPublic ? 1 : 0,
    sort_order: app.sortOrder,
    created_at: app.createdAt,
    updated_at: app.updatedAt,
  }))

  // Convert platforms
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
      version: platform.version,
      download_url: platform.downloadUrl,
      download_type: platform.downloadType,
      file_size_kb: platform.fileSizeKb ?? null,
      official_store_url: platform.officialStoreUrl,
      official_download_url: platform.officialDownloadUrl,
      update_notes: platform.updateNotes,
      import_supported: platform.importSupported ? 1 : 0,
      import_protocol: platform.importProtocol,
      import_url_template: platform.importUrlTemplate,
      import_instructions: platform.importInstructions,
      is_enabled: platform.isEnabled ? 1 : 0,
      created_at: platform.createdAt,
      updated_at: platform.updatedAt,
    })
  }

  report.converted = apps.length + app_platforms.length

  return { rows: { apps, app_platforms }, report }
}