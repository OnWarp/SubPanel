import { beforeAll, describe, expect, it } from 'vitest'
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
        description: 'Description 1',
        enabled: true,
        sortOrder: 0,
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
      {
        id: 'app_2',
        name: 'Test App 2',
        description: 'Description 2',
        enabled: false,
        sortOrder: 1,
        createdAt: '2024-01-11T10:00:00.000Z',
        updatedAt: '2024-01-11T10:00:00.000Z',
      },
    ],
    platforms: [
      {
        id: 'plt_1',
        appId: 'app_1',
        platform: 'windows',
        downloadUrl: 'https://example.com/app1-setup.exe',
        documentationUrl: 'https://example.com/app1/docs',
        sortOrder: 0,
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'plt_2',
        appId: 'app_1',
        platform: 'android',
        downloadUrl: 'https://example.com/app1-android.apk',
        sortOrder: 2,
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'plt_3',
        appId: 'app_2',
        platform: 'ios',
        downloadUrl: 'https://example.com/app2-ios',
        sortOrder: 3,
        createdAt: '2024-01-11T10:00:00.000Z',
        updatedAt: '2024-01-11T10:00:00.000Z',
      },
    ],
  }

  it('converts a valid snapshot into slim apps rows', () => {
    const result = convertApps(validSnapshot)
    expect(result.report).toEqual({ converted: 5, skipped: 0, anomalies: [] })
    expect(result.rows.apps).toEqual([
      {
        id: 'app_1',
        name: 'Test App 1',
        description: 'Description 1',
        enabled: 1,
        sort_order: 0,
        created_at: '2024-01-10T10:00:00.000Z',
        updated_at: '2024-01-15T10:00:00.000Z',
      },
      {
        id: 'app_2',
        name: 'Test App 2',
        description: 'Description 2',
        enabled: 0,
        sort_order: 1,
        created_at: '2024-01-11T10:00:00.000Z',
        updated_at: '2024-01-11T10:00:00.000Z',
      },
    ])
    expect(result.rows.app_platforms).toHaveLength(3)
    expect(result.rows.app_platforms[0]).toEqual({
      id: 'plt_1',
      app_id: 'app_1',
      platform: 'windows',
      download_url: 'https://example.com/app1-setup.exe',
      documentation_url: 'https://example.com/app1/docs',
      sort_order: 0,
      created_at: '2024-01-10T10:00:00.000Z',
      updated_at: '2024-01-10T10:00:00.000Z',
    })
    expect(result.rows.app_platforms[1].documentation_url).toBeNull()
  })

  it('reports anomaly for platform referencing missing app', () => {
    const snapshot = {
      ...validSnapshot,
      platforms: [
        ...validSnapshot.platforms,
        {
          id: 'plt_999',
          appId: 'app_999',
          platform: 'linux',
          downloadUrl: 'https://example.com/app-linux.tar.gz',
          sortOrder: 4,
          createdAt: '2024-01-12T10:00:00.000Z',
          updatedAt: '2024-01-12T10:00:00.000Z',
        },
      ],
    }

    const result = convertApps(snapshot)
    expect(result.report.anomalies).toContain('Platform plt_999 references missing app app_999')
    expect(result.report.skipped).toBe(1)
    expect(result.rows.app_platforms).toHaveLength(3)
  })

  it('property test: converted rows satisfy D1 constraints', async () => {
    const result = convertApps(validSnapshot)

    await emptyDatabase(db)
    await applyMigrations(db)

    for (const app of result.rows.apps) {
      await db.prepare(`
        INSERT INTO apps (id, name, description, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        app.id, app.name, app.description, app.enabled,
        app.sort_order, app.created_at, app.updated_at,
      ).run()
    }

    for (const platform of result.rows.app_platforms) {
      await db.prepare(`
        INSERT INTO app_platforms (id, app_id, platform, download_url, documentation_url, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        platform.id, platform.app_id, platform.platform, platform.download_url,
        platform.documentation_url, platform.sort_order, platform.created_at, platform.updated_at,
      ).run()
    }

    const appCount = await db.prepare('SELECT COUNT(*) as c FROM apps').first<{ c: number }>()
    expect(appCount!.c).toBe(2)

    const platformCount = await db.prepare('SELECT COUNT(*) as c FROM app_platforms').first<{ c: number }>()
    expect(platformCount!.c).toBe(3)

    const fkCheck = await db.prepare(`
      SELECT COUNT(*) as c FROM app_platforms ap
      LEFT JOIN apps a ON ap.app_id = a.id
      WHERE a.id IS NULL
    `).first<{ c: number }>()
    expect(fkCheck!.c).toBe(0)

    // UNIQUE(app_id, platform) is enforced by the schema
    await expect(db.prepare(`
      INSERT INTO app_platforms (id, app_id, platform, download_url, documentation_url, sort_order, created_at, updated_at)
      VALUES ('plt_dup', 'app_1', 'windows', 'https://example.com/dup', NULL, 0, '2024-01-12T10:00:00.000Z', '2024-01-12T10:00:00.000Z')
    `).run()).rejects.toThrow()

    // Deleting an app cascades to its platforms
    await db.prepare('DELETE FROM apps WHERE id = ?').bind('app_1').run()
    const remaining = await db.prepare('SELECT COUNT(*) as c FROM app_platforms').first<{ c: number }>()
    expect(remaining!.c).toBe(1)
  })
})
