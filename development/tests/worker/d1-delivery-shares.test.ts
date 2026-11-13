import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { readCatalog, writeCatalog } from '../../../worker/catalog/repository'
import type { CatalogSnapshot } from '../../../worker/catalog/schema'
import { clearAppsStorage } from '../../../worker/apps/d1-repository'
import { clearCatalogStorage } from '../../../worker/catalog/d1-repository'
import { compileSubscription } from '../../../worker/delivery/compiler'
import { clearDeliveryStorage } from '../../../worker/delivery/d1-repository'
import { DELIVERY_KEY, readDelivery, writeDelivery } from '../../../worker/delivery/repository'
import type { DeliverySnapshot } from '../../../worker/delivery/schema'
import {
  APPS_D1_READY_KEY,
  CATALOG_D1_READY_KEY,
  DELIVERY_D1_READY_KEY,
  SHARES_D1_READY_KEY,
  deleteSettings,
  isModuleReady,
  markModuleReady,
} from '../../../worker/db/module-switch'
import { runModuleImport } from '../../../worker/migration/run'
import { CLIENT_IDS } from '../../../worker/renderers/index'
import { clearSharesStorage } from '../../../worker/shares/d1-repository'
import {
  SHARE_SEQ_KEY,
  SHARE_SETTINGS_KEY,
  addIndexHash,
  allocateShareId,
  consumeVerifySlot,
  listAllShares,
  listIndexedShares,
  readShare,
  readShareSettings,
  shareEntityKey,
  subscriptionIndexKey,
  userIndexKey,
  writeShare,
  writeShareSettings,
} from '../../../worker/shares/repository'
import { DEFAULT_SHARE_SETTINGS, type ShareRecord, type ShareSettings } from '../../../worker/shares/schema'
import { applyMigrations } from './d1'
import { jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const NOW = '2026-07-23T00:00:00.000Z'
const LATER = '2026-07-23T01:00:00.000Z'
const COMPILE_NOW = '2026-07-23T02:00:00.000Z'
const USER_ID = 'usr_1'
const ENCRYPTED = {
  version: 1 as const,
  algorithm: 'AES-GCM' as const,
  iv: 'A'.repeat(16),
  ciphertext: 'B'.repeat(32),
}
const PASSWORD_HASH = {
  algorithm: 'PBKDF2-SHA-256' as const,
  iterations: 100_000,
  salt: 'A'.repeat(22),
  hash: 'B'.repeat(43),
}
const HASH_SUB_1 = 'A'.repeat(43)
const HASH_SUB_2 = 'B'.repeat(43)
const HASH_SHARE_1 = 'C'.repeat(43)
const HASH_SHARE_2 = 'D'.repeat(43)
const HASH_SHARE_3 = 'E'.repeat(43)

function catalogFixture(): CatalogSnapshot {
  return {
    schemaVersion: 2,
    revision: 3,
    updatedAt: NOW,
    nextSourceId: 2,
    nextNodeId: 2,
    nextGroupId: 3,
    sources: [
      {
        id: 'src_1',
        name: 'Manual',
        type: 'manual',
        enabled: true,
        encryptedContent: ENCRYPTED,
        warnings: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    nodes: [
      {
        id: 'node_1',
        protocol: 'shadowsocks',
        displayName: 'Demo',
        server: 'ss.example.com',
        port: 8388,
        credentials: { method: 'aes-128-gcm', password: 'password' },
        extensions: {},
        fingerprint: 'fp-node-1',
        sourceIds: ['src_1'],
        rawVariants: [{ sourceId: 'src_1', format: 'uri-list', raw: 'ss://fixture', extensions: {} }],
        enabled: true,
        retained: false,
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    groups: [
      {
        id: 'grp_1',
        name: '后组',
        sourceIds: ['src_1'],
        includedNodeIds: [],
        excludedNodeIds: [],
        nodeOrder: ['node_1'],
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'grp_2',
        name: '前组',
        sourceIds: [],
        includedNodeIds: ['node_1'],
        excludedNodeIds: [],
        nodeOrder: ['node_1'],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  }
}

function deliveryFixture(): DeliverySnapshot {
  return {
    schemaVersion: 1,
    revision: 4,
    updatedAt: NOW,
    nextSubscriptionId: 3,
    subscriptions: [
      {
        id: 'sub_2',
        userId: USER_ID,
        name: '停用',
        groupIds: [],
        tokenHash: HASH_SUB_2,
        tokenPrefix: 'tokpre02',
        encryptedToken: ENCRYPTED,
        enabled: false,
        defaultClient: 'singbox',
        revision: 1,
        startsAt: null,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'sub_1',
        userId: USER_ID,
        name: '主订阅',
        groupIds: ['grp_2', 'grp_1'],
        tokenHash: HASH_SUB_1,
        tokenPrefix: 'tokpre01',
        encryptedToken: ENCRYPTED,
        enabled: true,
        defaultClient: 'mihomo',
        revision: 2,
        startsAt: 1_700_000_000_000,
        expiresAt: 1_800_000_000_000,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  }
}

function shareRecord(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    schemaVersion: 1,
    id: 'shr_1',
    ownerUserId: USER_ID,
    subscriptionId: 'sub_1',
    tokenHash: HASH_SHARE_1,
    tokenPrefix: 'shrpre01',
    tokenEncrypted: ENCRYPTED,
    remark: '给朋友',
    status: 'active',
    accessControl: { mode: 'password', passwordHash: PASSWORD_HASH },
    expiresAt: '2026-12-31T00:00:00.000Z',
    allowOriginalLink: true,
    showSubscriptionName: true,
    showGroups: false,
    showExpiry: true,
    showNodeNames: false,
    requireLogin: true,
    maxAccessCount: 4,
    accessCount: 1,
    lastAccessedAt: NOW,
    lastOriginalRevealAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function shareSettingsFixture(): ShareSettings {
  return {
    ...DEFAULT_SHARE_SETTINGS,
    enabled: false,
    maxValidityDays: 30,
    defaultAccessControl: 'password',
    publicBaseUrl: 'https://share.example.com',
  }
}

async function counts(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function groupIdsFor(subscriptionId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT group_id FROM subscription_groups WHERE subscription_id = ? ORDER BY position',
  ).bind(subscriptionId).all<{ group_id: string }>()
  return rows.results.map((row) => row.group_id)
}

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await clearSharesStorage(env.DB)
  await clearDeliveryStorage(env.DB)
  await clearCatalogStorage(env.DB)
  await clearAppsStorage(env.DB)
  await env.DB.prepare('DELETE FROM system_settings WHERE key IN (?, ?, ?, ?)').bind(
    CATALOG_D1_READY_KEY,
    APPS_D1_READY_KEY,
    DELIVERY_D1_READY_KEY,
    SHARES_D1_READY_KEY,
  ).run()
})

describe('delivery D1 repository and import', () => {
  it('keeps KV until the flag is set and then reads the same snapshot from D1', async () => {
    await setupAdmin()
    const catalog = await writeCatalog(env, catalogFixture(), NOW)
    const saved = await writeDelivery(env, deliveryFixture(), NOW)
    expect(await readDelivery(env)).toEqual(saved)
    expect(await counts('subscriptions')).toBe(0)
    expect(await counts('subscription_groups')).toBe(0)
    const kvRaw = await env.DATA.get(DELIVERY_KEY)
    expect(kvRaw).not.toBeNull()

    await expect(runModuleImport(env, 'delivery', LATER)).rejects.toThrow('订阅迁移校验未通过')
    expect(await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)).toBe(false)
    expect(await readDelivery(env)).toEqual(saved)
    expect(await counts('subscriptions')).toBe(0)

    await runModuleImport(env, 'catalog', LATER)
    expect(await readCatalog(env)).toEqual(catalog)
    const report = await runModuleImport(env, 'delivery', LATER)
    expect(report).toMatchObject({
      module: 'delivery',
      skipped: 0,
      anomalies: [],
      ready: true,
      counts: { subscriptions: 2, subscriptionGroups: 2 },
    })
    expect(report.converted).toBe(4)
    expect(await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)).toBe(true)
    expect(await readDelivery(env)).toEqual(saved)
    const stored = await readDelivery(env)
    expect(stored.subscriptions.map((item) => item.id)).toEqual(['sub_2', 'sub_1'])
    const active = stored.subscriptions.find((item) => item.id === 'sub_1')
    const stopped = stored.subscriptions.find((item) => item.id === 'sub_2')
    expect(active?.groupIds).toEqual(['grp_2', 'grp_1'])
    expect(await groupIdsFor('sub_1')).toEqual(['grp_2', 'grp_1'])
    expect(active).toMatchObject({
      tokenHash: HASH_SUB_1,
      tokenPrefix: 'tokpre01',
      encryptedToken: ENCRYPTED,
      enabled: true,
      revision: 2,
      startsAt: 1_700_000_000_000,
      expiresAt: 1_800_000_000_000,
    })
    expect(stopped).toMatchObject({
      tokenHash: HASH_SUB_2,
      enabled: false,
      startsAt: null,
      expiresAt: null,
      groupIds: [],
    })

    const renamed = {
      ...saved,
      subscriptions: saved.subscriptions.map((item) => item.id === 'sub_1' ? { ...item, name: '改名' } : item),
    }
    const updated = await writeDelivery(env, renamed, LATER)
    expect(updated.subscriptions.find((item) => item.id === 'sub_1')?.name).toBe('改名')
    expect(updated.revision).toBe(saved.revision + 1)
    expect(await readDelivery(env)).toEqual(updated)
    expect(await env.DATA.get(DELIVERY_KEY)).toBe(kvRaw)
    expect(await counts('subscriptions')).toBe(2)

    const again = await runModuleImport(env, 'delivery', LATER)
    expect(again.counts).toEqual(report.counts)
    expect(await counts('subscriptions')).toBe(2)
    expect(await counts('subscription_groups')).toBe(2)
    expect(await readDelivery(env)).toEqual(saved)
    expect(await groupIdsFor('sub_1')).toEqual(['grp_2', 'grp_1'])
  })

  it('rejects a corrupt KV snapshot without setting the flag', async () => {
    await env.DATA.put(DELIVERY_KEY, '{}')
    await expect(runModuleImport(env, 'delivery')).rejects.toThrow('订阅快照无法读取')
    expect(await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)).toBe(false)
    expect(await counts('subscriptions')).toBe(0)
  })

  it('rejects a subscription group that is not in D1 and leaves readers on KV', async () => {
    await setupAdmin()
    await writeCatalog(env, catalogFixture(), NOW)
    await runModuleImport(env, 'catalog', NOW)
    const saved = await writeDelivery(env, {
      ...deliveryFixture(),
      subscriptions: deliveryFixture().subscriptions.map((item) => item.id === 'sub_1'
        ? { ...item, groupIds: ['grp_9'] }
        : item),
    }, NOW)
    await expect(runModuleImport(env, 'delivery', LATER)).rejects.toThrow('订阅迁移校验未通过')
    expect(await isModuleReady(env.DB, DELIVERY_D1_READY_KEY)).toBe(false)
    expect(await readDelivery(env)).toEqual(saved)
    expect(await counts('subscriptions')).toBe(0)
    expect(await counts('subscription_groups')).toBe(0)
  })
})

describe('shares D1 repository and import', () => {
  it('round-trips shares and settings from KV into D1 and reloads from KV on a second import', async () => {
    await setupAdmin()
    const passwordShare = shareRecord()
    const openShare = shareRecord({
      id: 'shr_2',
      tokenHash: HASH_SHARE_2,
      tokenPrefix: 'shrpre02',
      remark: '公开',
      status: 'disabled',
      accessControl: { mode: 'none' },
      expiresAt: '2027-01-15T00:00:00.000Z',
      allowOriginalLink: false,
      showSubscriptionName: false,
      showGroups: true,
      showExpiry: false,
      showNodeNames: true,
      requireLogin: false,
      maxAccessCount: null,
      accessCount: 0,
      lastAccessedAt: null,
      lastOriginalRevealAt: NOW,
    })
    await writeShare(env, passwordShare)
    await writeShare(env, openShare)
    await addIndexHash(env, userIndexKey(USER_ID), passwordShare.tokenHash)
    await addIndexHash(env, userIndexKey(USER_ID), openShare.tokenHash)
    await addIndexHash(env, subscriptionIndexKey('sub_1'), passwordShare.tokenHash)
    await addIndexHash(env, subscriptionIndexKey('sub_1'), openShare.tokenHash)
    await env.DATA.put(SHARE_SETTINGS_KEY, JSON.stringify({
      ...shareSettingsFixture(),
      publicBaseUrl: 'https://share.example.com/',
    }))
    await env.DATA.put(SHARE_SEQ_KEY, JSON.stringify({ next: 7 }))
    expect(await counts('shares')).toBe(0)
    const kvShare = await env.DATA.get(shareEntityKey(passwordShare.tokenHash))
    const kvSettings = await env.DATA.get(SHARE_SETTINGS_KEY)

    const report = await runModuleImport(env, 'shares', LATER)
    expect(report).toMatchObject({
      module: 'shares',
      skipped: 0,
      anomalies: [],
      ready: true,
      counts: { shares: 2, shareSettings: 1 },
    })
    expect(await isModuleReady(env.DB, SHARES_D1_READY_KEY)).toBe(true)
    expect(await readShare(env, passwordShare.tokenHash)).toEqual(passwordShare)
    expect(await readShare(env, openShare.tokenHash)).toEqual(openShare)
    const listed = await listAllShares(env)
    expect(listed.map((item) => item.id).sort()).toEqual(['shr_1', 'shr_2'])
    expect((await listIndexedShares(env, userIndexKey(USER_ID))).map((item) => item.id).sort()).toEqual(['shr_1', 'shr_2'])
    expect((await listIndexedShares(env, subscriptionIndexKey('sub_1'))).map((item) => item.tokenHash).sort()).toEqual([
      HASH_SHARE_1,
      HASH_SHARE_2,
    ])
    expect(await readShareSettings(env)).toEqual(shareSettingsFixture())
    expect(await env.DATA.get(SHARE_SETTINGS_KEY)).toBe(kvSettings)
    expect(await env.DATA.get(userIndexKey(USER_ID))).not.toBeNull()
    expect(await allocateShareId(env)).toBe('shr_7')

    const edited = { ...passwordShare, remark: '只在 D1' }
    await writeShare(env, edited)
    expect(await readShare(env, passwordShare.tokenHash)).toEqual(edited)
    expect(await env.DATA.get(shareEntityKey(passwordShare.tokenHash))).toBe(kvShare)
    const created = shareRecord({
      id: 'shr_8',
      tokenHash: HASH_SHARE_3,
      tokenPrefix: 'shrpre03',
      remark: '新建',
      accessControl: { mode: 'none' },
    })
    await writeShare(env, created)
    expect(await env.DATA.get(shareEntityKey(created.tokenHash))).toBeNull()
    expect(await counts('shares')).toBe(3)
    await expect(writeShare(env, { ...openShare, id: 'shr_9', tokenHash: passwordShare.tokenHash })).rejects.toThrow()

    const again = await runModuleImport(env, 'shares', LATER)
    expect(again.counts).toEqual(report.counts)
    expect(await counts('shares')).toBe(2)
    expect(await readShare(env, passwordShare.tokenHash)).toEqual(passwordShare)
    expect(await readShare(env, created.tokenHash)).toBeNull()
    expect(await readShareSettings(env)).toEqual(shareSettingsFixture())
  })

  it('imports an empty share module and a share whose subscription row is absent', async () => {
    const empty = await runModuleImport(env, 'shares', LATER)
    expect(empty).toMatchObject({
      module: 'shares',
      skipped: 0,
      anomalies: [],
      ready: true,
      counts: { shares: 0, shareSettings: 1 },
    })
    expect(await readShareSettings(env)).toEqual(DEFAULT_SHARE_SETTINGS)
    expect(await allocateShareId(env)).toBe('shr_1')
    await deleteSettings(env.DB, [SHARES_D1_READY_KEY])
    await clearSharesStorage(env.DB)

    await setupAdmin()
    const orphan = shareRecord({ subscriptionId: 'sub_9', remark: '悬空' })
    await writeShare(env, orphan)
    const report = await runModuleImport(env, 'shares', LATER)
    expect(report.ready).toBe(true)
    expect(await counts('shares')).toBe(1)
    expect(await counts('subscriptions')).toBe(0)
    expect(await readShare(env, orphan.tokenHash)).toEqual(orphan)
  })

  it('rejects corrupt share KV without setting the flag', async () => {
    await env.DATA.put(SHARE_SETTINGS_KEY, '{broken')
    await expect(runModuleImport(env, 'shares')).rejects.toThrow('分享数据无法读取')
    expect(await isModuleReady(env.DB, SHARES_D1_READY_KEY)).toBe(false)

    await env.DATA.delete(SHARE_SETTINGS_KEY)
    await env.DATA.put(SHARE_SEQ_KEY, '{')
    await expect(runModuleImport(env, 'shares')).rejects.toThrow('分享数据无法读取')
    expect(await isModuleReady(env.DB, SHARES_D1_READY_KEY)).toBe(false)
  })

  it('persists valid shares but does not set the flag when another record is invalid', async () => {
    await setupAdmin()
    const saved = shareRecord()
    await writeShare(env, saved)
    await env.DATA.put(shareEntityKey(HASH_SHARE_2), 'not-json')
    await expect(runModuleImport(env, 'shares', LATER)).rejects.toThrow('分享迁移校验未通过')
    expect(await isModuleReady(env.DB, SHARES_D1_READY_KEY)).toBe(false)
    expect(await counts('shares')).toBe(1)
    expect(await readShare(env, saved.tokenHash)).toEqual(saved)
    expect(await env.DATA.get(shareEntityKey(saved.tokenHash))).not.toBeNull()
  })

  it('reads KV or D1 according to the flag and counts verify attempts only in the active store', async () => {
    await setupAdmin()
    const saved = shareRecord()
    await writeShare(env, saved)
    await writeShareSettings(env, shareSettingsFixture())
    expect(await readShare(env, saved.tokenHash)).toEqual(saved)
    expect(await counts('shares')).toBe(0)
    const kvRaw = await env.DATA.get(shareEntityKey(saved.tokenHash))

    await markModuleReady(env.DB, SHARES_D1_READY_KEY, NOW)
    expect(await readShare(env, saved.tokenHash)).toBeNull()
    expect(await readShareSettings(env)).toEqual(DEFAULT_SHARE_SETTINGS)
    await deleteSettings(env.DB, [SHARES_D1_READY_KEY])
    expect(await readShare(env, saved.tokenHash)).toEqual(saved)
    expect(await readShareSettings(env)).toEqual(shareSettingsFixture())

    const nowMs = Date.parse('2026-07-23T00:05:00.000Z')
    expect(await consumeVerifySlot(env, saved.tokenHash, nowMs)).toBe(true)
    const kvLimits = await env.DATA.list({ prefix: 'sharelimit:' })
    expect(kvLimits.keys.length).toBe(1)

    await markModuleReady(env.DB, SHARES_D1_READY_KEY, NOW)
    const minute = Math.floor(nowMs / 60_000)
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at) VALUES ('share_verify', ?, ?, 10, ?)`,
    ).bind(saved.tokenHash, minute - 1, Math.floor(nowMs / 1000) - 1).run()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await consumeVerifySlot(env, saved.tokenHash, nowMs)).toBe(true)
    }
    expect(await consumeVerifySlot(env, saved.tokenHash, nowMs)).toBe(false)
    const limitsAfter = await env.DATA.list({ prefix: 'sharelimit:' })
    expect(limitsAfter.keys).toEqual(kvLimits.keys)
    expect(await env.DATA.get(shareEntityKey(saved.tokenHash))).toBe(kvRaw)
  })
})

describe('subscription compile on D1 matches KV', () => {
  it('compiles every client to the same artifact after delivery and catalog move to D1', async () => {
    await setupAdmin()
    await writeCatalog(env, catalogFixture(), NOW)
    const saved = await writeDelivery(env, deliveryFixture(), NOW)
    const enabled = saved.subscriptions.find((item) => item.id === 'sub_1')
    expect(enabled?.enabled).toBe(true)
    const kvArtifacts = await compileSubscription(env, enabled!, { now: COMPILE_NOW })
    expect(kvArtifacts.map((artifact) => artifact.client)).toEqual([...CLIENT_IDS])
    expect(kvArtifacts.every((artifact) => artifact.outputNodes === 1 && artifact.body.length > 0)).toBe(true)

    await runModuleImport(env, 'catalog', LATER)
    await runModuleImport(env, 'delivery', LATER)
    const fromD1 = (await readDelivery(env)).subscriptions.find((item) => item.id === 'sub_1')
    expect(fromD1).toEqual(enabled)
    const d1Artifacts = await compileSubscription(env, fromD1!, { now: COMPILE_NOW })
    expect(d1Artifacts).toEqual(kvArtifacts)
  })
})

describe('POST /api/admin/migration/run delivery and shares', () => {
  it('requires an administrator and imports both modules', async () => {
    await setupAdmin()
    const catalog = await writeCatalog(env, catalogFixture(), NOW)
    const delivery = await writeDelivery(env, deliveryFixture(), NOW)
    const share = shareRecord()
    await writeShare(env, share)
    await writeShareSettings(env, shareSettingsFixture())
    await env.DATA.put(SHARE_SEQ_KEY, JSON.stringify({ next: 4 }))

    const anonymous = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/migration/run`, jsonRequest({ module: 'delivery' }))
    expect(anonymous.status).toBe(401)
    const anonymousShares = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/migration/run`, jsonRequest({ module: 'shares' }))
    expect(anonymousShares.status).toBe(401)

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
      jsonRequest({ module: 'delivery' }, withCookie(user)),
    )
    expect(forbidden.status).toBe(403)
    const forbiddenShares = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'shares' }, withCookie(user)),
    )
    expect(forbiddenShares.status).toBe(403)

    const catalogResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'catalog' }, withCookie(admin)),
    )
    expect(catalogResponse.status).toBe(200)
    expect(await readCatalog(env)).toEqual(catalog)

    const response = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'delivery' }, withCookie(admin)),
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { ready: boolean, module: string, anomalies: string[] }
    expect(body.module).toBe('delivery')
    expect(body.ready).toBe(true)
    expect(body.anomalies).toEqual([])
    expect(await readDelivery(env)).toEqual(delivery)

    const repeated = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'delivery' }, withCookie(admin)),
    )
    expect(repeated.status).toBe(200)
    expect(await counts('subscriptions')).toBe(2)
    expect(await counts('subscription_groups')).toBe(2)

    const sharesResponse = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'shares' }, withCookie(admin)),
    )
    expect(sharesResponse.status).toBe(200)
    const sharesBody = await sharesResponse.json() as { ready: boolean, module: string, anomalies: string[] }
    expect(sharesBody.module).toBe('shares')
    expect(sharesBody.ready).toBe(true)
    expect(sharesBody.anomalies).toEqual([])
    expect(await readShare(env, share.tokenHash)).toEqual(share)
    expect(await readShareSettings(env)).toEqual(shareSettingsFixture())

    const repeatedShares = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/migration/run`,
      jsonRequest({ module: 'shares' }, withCookie(admin)),
    )
    expect(repeatedShares.status).toBe(200)
    expect(await counts('shares')).toBe(1)
  })
})
