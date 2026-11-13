import { describe, it, expect, beforeAll } from 'vitest'
import { convertApps } from '../../../worker/migration/apps'
import { applyMigrations, emptyDatabase } from '../worker/d1.js'
import { env } from 'cloudflare:workers'

describe('apps converter', () => {
  let db: D1Database

  beforeAll(async () => {
    db = env.DB
    await applyMigrations(db)
  })

  const validSnapshot = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2024-01-15T10:00:00.000Z',
    nextAppId: 3,
    nextPlatformId: 4,
    apps: [
      {
        id: 'app_1',
        name: 'Test App 1',
        icon: 'https://example.com/icon1.png',
        summary: 'Summary 1',
        description: 'Description 1',
        category: 'VPN',
        officialWebsite: 'https://example.com/app1',
        developer: 'Developer 1',
        flags: {
          isRecommended: true,
          isOfficial: false,
          isPopular: true,
          isEnabled: true,
          isPublic: true,
        },
        sortOrder: 0,
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
      {
        id: 'app_2',
        name: 'Test App 2',
        icon: '',
        summary: 'Summary 2',
        description: 'Description 2',
        category: 'Proxy',
        officialWebsite: '',
        flags: {
          isRecommended: false,
          isOfficial: true,
          isPopular: false,
          isEnabled: true,
          isPublic: false,
        },
        sortOrder: 1,
        createdAt: '2024-01-11T10:00:00.000Z',
        updatedAt: '2024-01-11T10:00:00.000Z',
      },
    ],
    platforms: [
      {
        id: 'plt_1',
        appId: 'app_1',
        platform: 'android',
        version: '1.0.0',
        downloadUrl: 'https://example.com/app1-android.apk',
        downloadType: 'apk',
        fileSizeKb: 5000,
        officialStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.app1',
        officialDownloadUrl: '',
        updateNotes: 'Initial release',
        importSupported: true,
        importProtocol: 'vmess',
        importUrlTemplate: 'https://example.com/import/{subscription}',
        importInstructions: 'Import instructions here',
        isEnabled: true,
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'plt_2',
        appId: 'app_1',
        platform: 'ios',
        version: '1.0.0',
        downloadUrl: 'https://example.com/app1-ios.ipa',
        downloadType: 'ipa',
        fileSizeKb: 10000,
        officialStoreUrl: 'https://apps.apple.com/app/id123456',
        officialDownloadUrl: '',
        updateNotes: 'Initial release',
        importSupported: true,
        importProtocol: 'vmess',
        importUrlTemplate: 'https://example.com/import/{subscription}',
        importInstructions: 'Import instructions here',
        isEnabled: true,
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'plt_3',
        appId: 'app_2',
        platform: 'windows',
        version: '2.0.0',
        downloadUrl: 'https://example.com/app2-windows.exe',
        downloadType: 'exe',
        officialStoreUrl: '',
        officialDownloadUrl: 'https://github.com/example/app2/releases',
        updateNotes: 'Version 2.0',
        importSupported: false,
        importProtocol: '',
        importUrlTemplate: '',
        importInstructions: '',
        isEnabled: true,
        createdAt: '2024-01-11T10:00:00.000Z',
        updatedAt: '2024-01-11T10:00:00.000Z',
      },
    ],
  }

  it('converts valid snapshot without anomalies', () => {
    const result = convertApps(validSnapshot)

    expect(result.report.anomalies).toHaveLength(0)
    expect(result.report.skipped).toBe(0)
    expect(result.rows.apps).toHaveLength(2)
    expect(result.rows.app_platforms).toHaveLength(3)

    // Check app conversion
    const app1 = result.rows.apps.find(a => a.id === 'app_1')
    expect(app1).toBeDefined()
    expect(app1!.name).toBe('Test App 1')
    expect(app1!.icon).toBe('https://example.com/icon1.png')
    expect(app1!.developer).toBe('Developer 1')
    expect(app1!.is_recommended).toBe(1)
    expect(app1!.is_official).toBe(0)
    expect(app1!.is_popular).toBe(1)
    expect(app1!.is_enabled).toBe(1)
    expect(app1!.is_public).toBe(1)

    const app2 = result.rows.apps.find(a => a.id === 'app_2')
    expect(app2).toBeDefined()
    expect(app2!.developer).toBeNull()
    expect(app2!.icon).toBe('')
    expect(app2!.official_website).toBe('')

    // Check platform conversion
    const platforms = result.rows.app_platforms.filter(p => p.app_id === 'app_1')
    expect(platforms).toHaveLength(2)
    expect(platforms.map(p => p.platform).sort()).toEqual(['android', 'ios'])

    const androidPlatform = platforms.find(p => p.platform === 'android')
    expect(androidPlatform).toBeDefined()
    expect(androidPlatform!.version).toBe('1.0.0')
    expect(androidPlatform!.file_size_kb).toBe(5000)
    expect(androidPlatform!.import_supported).toBe(1)
    expect(androidPlatform!.official_download_url).toBe('')

    const windowsPlatform = result.rows.app_platforms.find(p => p.app_id === 'app_2' && p.platform === 'windows')
    expect(windowsPlatform).toBeDefined()
    expect(windowsPlatform!.file_size_kb).toBeNull()
    expect(windowsPlatform!.import_supported).toBe(0)
  })

  it('reports anomaly for platform referencing missing app', () => {
    const snapshot = {
      ...validSnapshot,
      platforms: [
        ...validSnapshot.platforms,
        {
          id: 'plt_999',
          appId: 'app_999', // doesn't exist
          platform: 'linux',
          version: '1.0.0',
          downloadUrl: 'https://example.com/app-linux.tar.gz',
          downloadType: 'tar.gz',
          fileSizeKb: 2000,
          officialStoreUrl: '',
          officialDownloadUrl: '',
          updateNotes: '',
          importSupported: false,
          importProtocol: '',
          importUrlTemplate: '',
          importInstructions: '',
          isEnabled: true,
          createdAt: '2024-01-12T10:00:00.000Z',
          updatedAt: '2024-01-12T10:00:00.000Z',
        },
      ],
    }

    const result = convertApps(snapshot)
    expect(result.report.anomalies).toContain('Platform plt_999 references missing app app_999')
    expect(result.report.skipped).toBe(1)
    expect(result.rows.app_platforms).toHaveLength(3) // only valid ones
  })

  it('property test: converted rows satisfy D1 constraints', async () => {
    const result = convertApps(validSnapshot)

    await emptyDatabase(db)
    await applyMigrations(db)

    for (const app of result.rows.apps) {
      await db.prepare(`
        INSERT INTO apps (id, name, icon, summary, description, category, official_website, developer,
          is_recommended, is_official, is_popular, is_enabled, is_public, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        app.id, app.name, app.icon, app.summary, app.description, app.category, app.official_website, app.developer,
        app.is_recommended, app.is_official, app.is_popular, app.is_enabled, app.is_public,
        app.sort_order, app.created_at, app.updated_at
      ).run()
    }

    for (const platform of result.rows.app_platforms) {
      await db.prepare(`
        INSERT INTO app_platforms (id, app_id, platform, version, download_url, download_type, file_size_kb,
          official_store_url, official_download_url, update_notes, import_supported, import_protocol,
          import_url_template, import_instructions, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        platform.id, platform.app_id, platform.platform, platform.version, platform.download_url,
        platform.download_type, platform.file_size_kb, platform.official_store_url,
        platform.official_download_url, platform.update_notes, platform.import_supported,
        platform.import_protocol, platform.import_url_template, platform.import_instructions,
        platform.is_enabled, platform.created_at, platform.updated_at
      ).run()
    }

    // Verify counts
    const appCount = await db.prepare('SELECT COUNT(*) as c FROM apps').first<{ c: number }>()
    expect(appCount!.c).toBe(2)

    const platformCount = await db.prepare('SELECT COUNT(*) as c FROM app_platforms').first<{ c: number }>()
    expect(platformCount!.c).toBe(3)

    // Verify FK constraint
    const fkCheck = await db.prepare(`
      SELECT COUNT(*) as c FROM app_platforms ap
      LEFT JOIN apps a ON ap.app_id = a.id
      WHERE a.id IS NULL
    `).first<{ c: number }>()
    expect(fkCheck!.c).toBe(0)

    // Verify unique constraints
    const uniqueAppIds = await db.prepare('SELECT COUNT(DISTINCT id) as c FROM apps').first<{ c: number }>()
    expect(uniqueAppIds!.c).toBe(2)

    const uniquePlatformIds = await db.prepare('SELECT COUNT(DISTINCT id) as c FROM app_platforms').first<{ c: number }>()
    expect(uniquePlatformIds!.c).toBe(3)
  })
})