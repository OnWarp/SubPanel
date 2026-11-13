import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearAppsStorage } from '../../../worker/apps/d1-repository'
import { readApps, writeApps } from '../../../worker/apps/repository'
import type { AppsSnapshot } from '../../../worker/apps/schema'
import { clearCatalogStorage } from '../../../worker/catalog/d1-repository'
import { createSource, deleteSource } from '../../../worker/catalog/import-service'
import { readCatalog, writeCatalog, CATALOG_KEY } from '../../../worker/catalog/repository'
import type { CatalogSnapshot } from '../../../worker/catalog/schema'
import {
  APPS_D1_READY_KEY,
  CATALOG_D1_READY_KEY,
  isModuleReady,
} from '../../../worker/db/module-switch'
import { runModuleImport } from '../../../worker/migration/run'
import { applyMigrations } from './d1'
import { jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const NOW = '2026-07-23T00:00:00.000Z'
const LATER = '2026-07-23T01:00:00.000Z'
const ENCRYPTED = {
  version: 1 as const,
  algorithm: 'AES-GCM' as const,
  iv: 'A'.repeat(16),
  ciphertext: 'B'.repeat(32),
}

function catalogFixture(): CatalogSnapshot {
  return {
    schemaVersion: 2,
    revision: 4,
    updatedAt: NOW,
    nextSourceId: 4,
    nextNodeId: 3,
    nextGroupId: 2,
    sources: [
      {
        id: 'src_1',
        name: 'Remote',
        type: 'remote',
        enabled: true,
        encryptedUrl: ENCRYPTED,
        encryptedHeaders: ENCRYPTED,
        refreshIntervalMinutes: 60,
        detectedFormat: 'mihomo',
        warnings: [],
        lastAttemptAt: NOW,
        lastSuccessAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'src_2',
        name: 'Manual',
        type: 'manual',
        enabled: true,
        encryptedContent: ENCRYPTED,
        warnings: [{ code: 'PARTIAL', message: 'kept', line: 2 }],
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'src_3',
        name: 'File',
        type: 'file',
        enabled: false,
        encryptedContent: ENCRYPTED,
        detectedFormat: 'sing-box',
        warnings: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    nodes: [
      {
        id: 'node_1',
        protocol: 'vless',
        displayName: 'Reality',
        server: 'example.com',
        port: 443,
        credentials: { uuid: '11111111-1111-4111-8111-111111111111', flow: 'xtls-rprx-vision' },
        tls: { enabled: true, reality: { publicKey: 'public-key', shortId: 'short-id' } },
        transport: { type: 'ws', path: '/edge' },
        extensions: { custom: ['keep', true] },
        fingerprint: 'fp-node-1',
        sourceIds: ['src_1', 'src_2'],
        rawVariants: [
          { sourceId: 'src_1', format: 'mihomo', raw: 'vless://one', extensions: { cert: 'raw-cert' } },
          { sourceId: 'src_2', format: 'uri-list', raw: 'vless://two', extensions: {} },
        ],
        enabled: true,
        retained: false,
        order: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'node_2',
        protocol: 'trojan',
        displayName: 'Kept',
        server: 'trojan.example.com',
        port: 443,
        credentials: { password: 'secret' },
        extensions: {},
        fingerprint: 'fp-node-2',
        sourceIds: ['src_3'],
        rawVariants: [{ sourceId: 'src_3', format: 'sing-box', raw: 'trojan://kept', extensions: {} }],
        enabled: false,
        retained: true,
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    groups: [
      {
        id: 'grp_1',
        name: 'Ordered',
        sourceIds: ['src_3', 'src_1'],
        includedNodeIds: ['node_1'],
        excludedNodeIds: ['node_2'],
        nodeOrder: ['node_2', 'node_1'],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  }
}

function appsFixture(): AppsSnapshot {
  return {
    schemaVersion: 1,
    revision: 2,
    updatedAt: NOW,
    nextAppId: 3,
    nextPlatformId: 3,
    apps: [
      {
        id: 'app_1',
        name: '面板',
        icon: '',
        summary: '简介',
        description: '说明',
        category: '工具',
        officialWebsite: 'https://example.com',
        developer: 'Lab',
        flags: { isRecommended: true, isOfficial: false, isPopular: true, isEnabled: true, isPublic: true },
        sortOrder: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'app_2',
        name: '另一个',
        icon: '',
        summary: '',
        description: '',
        category: '系统',
        officialWebsite: '',
        flags: { isRecommended: false, isOfficial: true, isPopular: false, isEnabled: true, isPublic: false },
        sortOrder: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    platforms: [
      {
        id: 'plt_1',
        appId: 'app_1',
        platform: 'ios',
        version: '1.0.0',
        downloadUrl: 'https://cdn.example.com/ios',
        downloadType: 'store',
        officialStoreUrl: '',
        officialDownloadUrl: '',
        updateNotes: '',
        importSupported: false,
        importProtocol: '',
        importUrlTemplate: '',
        importInstructions: '',
        isEnabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'plt_2',
        appId: 'app_1',
        platform: 'android',
        version: '1.2.0',
        downloadUrl: 'https://cdn.example.com/app.apk',
        downloadType: 'direct',
        fileSizeKb: 2048,
        officialStoreUrl: '',
        officialDownloadUrl: '',
        updateNotes: '修复',
        importSupported: true,
        importProtocol: 'clash',
        importUrlTemplate: 'clash://install-config?url={url}',
        importInstructions: '打开后导入',
        isEnabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  }
}

async function counts(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await clearCatalogStorage(env.DB)
  await clearAppsStorage(env.DB)
  await env.DB.prepare('DELETE FROM system_settings WHERE key IN (?, ?)').bind(CATALOG_D1_READY_KEY, APPS_D1_READY_KEY).run()
})

describe('catalog D1 repository and import', () => {
  it('keeps KV until the flag is set and then reads the same snapshot from D1', async () => {
    const saved = await writeCatalog(env, catalogFixture(), NOW)
    expect(await readCatalog(env)).toEqual(saved)
    expect(await counts('sources')).toBe(0)
    expect(await env.DATA.get(CATALOG_KEY)).not.toBeNull()
    const kvRaw = await env.DATA.get(CATALOG_KEY)

    const report = await runModuleImport(env, 'catalog', LATER)
    expect(report).toMatchObject({
      module: 'catalog',
      skipped: 0,
      anomalies: [],
      ready: true,
      counts: {
        sources: 3,
        nodes: 2,
        nodeRawVariants: 3,
        groups: 1,
        groupSources: 2,
        groupNodes: 2,
        groupNodeOrder: 2,
      },
    })
    expect(report.converted).toBe(3 + 2 + 3 + 1 + 2 + 2 + 2)
    expect(await readCatalog(env)).toEqual(saved)
    expect(await isModuleReady(env.DB, CATALOG_D1_READY_KEY)).toBe(true)

    const renamed = {
      ...saved,
      sources: saved.sources.map((source) => source.id === 'src_2' ? { ...source, name: 'Renamed' } : source),
    }
    const updated = await writeCatalog(env, renamed, LATER)
    expect(updated.sources.find((source) => source.id === 'src_2')?.name).toBe('Renamed')
    expect(updated.revision).toBe(saved.revision + 1)
    expect(await readCatalog(env)).toEqual(updated)
    expect(await env.DATA.get(CATALOG_KEY)).toBe(kvRaw)
    expect(await counts('sources')).toBe(3)

    const again = await runModuleImport(env, 'catalog', LATER)
    expect(again.counts).toEqual(report.counts)
    expect(await counts('sources')).toBe(3)
    expect(await counts('nodes')).toBe(2)
    expect(await counts('node_raw_variants')).toBe(3)
    expect(await readCatalog(env)).toEqual(saved)
    const group = (await readCatalog(env)).groups[0]
    expect(group.sourceIds).toEqual(['src_3', 'src_1'])
    expect(group.includedNodeIds).toEqual(['node_1'])
    expect(group.excludedNodeIds).toEqual(['node_2'])
    expect(group.nodeOrder).toEqual(['node_2', 'node_1'])
    const node = (await readCatalog(env)).nodes.find((item) => item.id === 'node_1')
    expect(node?.sourceIds).toEqual(['src_1', 'src_2'])
    expect(node?.rawVariants.map((variant) => variant.raw)).toEqual(['vless://one', 'vless://two'])
  })

  it('rejects a corrupt KV snapshot without setting the flag', async () => {
    await env.DATA.put(CATALOG_KEY, '{broken')
    await expect(runModuleImport(env, 'catalog')).rejects.toThrow('Catalog 快照无法读取')
    expect(await isModuleReady(env.DB, CATALOG_D1_READY_KEY)).toBe(false)
  })

  it('updates and deletes catalog rows through the D1 repository', async () => {
    await runModuleImport(env, 'catalog', NOW)
    await env.DATA.put(CATALOG_KEY, JSON.stringify(catalogFixture()))
    await runModuleImport(env, 'catalog', NOW)
    const line = `ss://${btoa('aes-128-gcm:password')}@added.example.com:8388#Added`
    const created = await createSource(env, { type: 'manual', name: 'Added', content: line }, { now: LATER })
    expect(created.success).toBe(true)
    expect(await counts('sources')).toBe(4)
    expect(await env.DATA.get(CATALOG_KEY)).not.toContain('Added')
    await deleteSource(env, created.source.id, { now: LATER })
    const after = await readCatalog(env)
    expect(after.sources.map((source) => source.id)).toEqual(['src_1', 'src_2', 'src_3'])
    expect(await counts('sources')).toBe(3)
  })
})

describe('apps D1 repository and import', () => {
  it('round-trips apps from KV into D1 and ignores a second import', async () => {
    const saved = await writeApps(env, appsFixture(), NOW)
    expect(await counts('apps')).toBe(0)
    const kvRaw = await env.DATA.get('state:apps')

    const report = await runModuleImport(env, 'apps', LATER)
    expect(report).toMatchObject({
      module: 'apps',
      skipped: 0,
      anomalies: [],
      ready: true,
      counts: { apps: 2, platforms: 2 },
    })
    expect(await readApps(env)).toEqual(saved)

    await writeApps(env, {
      ...saved,
      apps: saved.apps.map((app) => app.id === 'app_2' ? { ...app, name: '改名' } : app),
    }, LATER)
    expect((await readApps(env)).apps.find((app) => app.id === 'app_2')?.name).toBe('改名')
    expect(await env.DATA.get('state:apps')).toBe(kvRaw)

    const again = await runModuleImport(env, 'apps', LATER)
    expect(again.counts).toEqual(report.counts)
    expect(await counts('apps')).toBe(2)
    expect(await counts('app_platforms')).toBe(2)
    expect(await readApps(env)).toEqual(saved)
    const stored = await readApps(env)
    expect(stored.apps.map((app) => app.id)).toEqual(['app_1', 'app_2'])
    expect(stored.platforms.map((platform) => platform.id)).toEqual(['plt_1', 'plt_2'])
    expect(stored.apps[1].developer).toBeUndefined()
    expect(stored.platforms[0].fileSizeKb).toBeUndefined()
    expect(stored.platforms[1].fileSizeKb).toBe(2048)
  })
})

describe('POST /api/admin/migration/run', () => {
  it('requires an administrator and imports the requested module', async () => {
    await setupAdmin()
    const saved = await writeCatalog(env, catalogFixture(), NOW)
    const anonymous = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/migration/run`, jsonRequest({ module: 'catalog' }))
    expect(anonymous.status).toBe(401)

    const admin = await login()
    const invite = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/invites`,
      jsonRequest({ username: 'migrator' }, withCookie(admin)),
    )
    const link = (await invite.json() as { invite: { link: string } }).invite.link
    const token = new URL(link).pathname.split('/').at(-1) ?? ''
    await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`, jsonRequest({ password: 'migrator-password' }))
    const user = await login('migrator', 'migrator-password')
    const forbidden = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'catalog' }, withCookie(user)),
    )
    expect(forbidden.status).toBe(403)

    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'catalog' }, withCookie(admin)),
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { ready: boolean, module: string, anomalies: string[] }
    expect(body.module).toBe('catalog')
    expect(body.ready).toBe(true)
    expect(body.anomalies).toEqual([])
    expect(await readCatalog(env)).toEqual(saved)

    const repeated = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'catalog' }, withCookie(admin)),
    )
    expect(repeated.status).toBe(200)
    expect(await counts('sources')).toBe(3)
    expect(await counts('nodes')).toBe(2)
  })
})
