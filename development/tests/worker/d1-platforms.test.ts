import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { subscriptionLinks } from '../../../worker/delivery/links.js'
import {
  invalidatePlatformRendererCache,
  listPlatformSettings,
  resolveSubscriptionClient,
  updatePlatformSettings,
  type PlatformSetting,
} from '../../../worker/domains/service.js'
import { applyMigrations } from './d1'
import {
  jsonRequest,
  login,
  resetData,
  setupAdmin,
  TEST_ORIGIN,
  withCookie,
} from './helpers'

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)

const SEED_NOW = '2026-01-01T00:00:00.000Z'
const SEED: Array<[string, string, number, string]> = [
  ['auto', '自动识别', 0, 'auto'],
  ['mihomo', 'Mihomo', 10, 'mihomo'],
  ['clash', 'Clash', 20, 'mihomo'],
  ['clash-meta', 'Clash Meta', 30, 'mihomo'],
  ['stash', 'Stash', 40, 'mihomo'],
  ['singbox', 'sing-box', 50, 'singbox'],
  ['karing', 'Karing', 60, 'singbox'],
  ['surge', 'Surge', 70, 'surge'],
  ['loon', 'Loon', 80, 'loon'],
  ['quantumultx', 'Quantumult X', 90, 'quantumultx'],
  ['v2rayn', 'v2rayN', 100, 'v2rayn'],
  ['nekobox', 'NekoBox', 110, 'nekobox'],
  ['shadowrocket', 'Shadowrocket', 120, 'shadowrocket'],
]

let adminCookie: string

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM subscription_platform_settings'),
    ...SEED.map(([platform, displayName, sortOrder, renderer]) =>
      env.DB.prepare(
        'INSERT INTO subscription_platform_settings (platform, display_name, enabled, sort_order, renderer, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
      ).bind(platform, displayName, sortOrder, renderer, SEED_NOW),
    ),
  ])
  invalidatePlatformRendererCache()
  await setupAdmin()
  adminCookie = await login()
})

const adminPlatforms = async () => {
  const response = await fetchApi('/api/admin/system/subscription-platforms', withCookie(adminCookie))
  expect(response.status).toBe(200)
  return ((await response.json()) as { platforms: PlatformSetting[] }).platforms
}

const putPlatforms = (platforms: unknown) =>
  fetchApi('/api/admin/system/subscription-platforms', withCookie(adminCookie, jsonRequest({ platforms }, { method: 'PUT' })))

describe('subscription platform management', () => {
  it('lists the seed platforms with their renderers', async () => {
    const platforms = await adminPlatforms()
    expect(platforms).toHaveLength(13)
    const rendererOf = (key: string) => platforms.find((entry) => entry.platform === key)?.renderer
    expect(rendererOf('auto')).toBe('auto')
    expect(rendererOf('mihomo')).toBe('mihomo')
    expect(rendererOf('clash')).toBe('mihomo')
    expect(rendererOf('clash-meta')).toBe('mihomo')
    expect(rendererOf('stash')).toBe('mihomo')
    expect(rendererOf('singbox')).toBe('singbox')
    expect(rendererOf('karing')).toBe('singbox')
    expect(rendererOf('surge')).toBe('surge')
    expect(rendererOf('loon')).toBe('loon')
    expect(rendererOf('quantumultx')).toBe('quantumultx')
    expect(rendererOf('v2rayn')).toBe('v2rayn')
    expect(rendererOf('nekobox')).toBe('nekobox')
    expect(rendererOf('shadowrocket')).toBe('shadowrocket')
  })

  it('adds a custom platform and serves it on the user view with a link', async () => {
    const current = await adminPlatforms()
    const put = await putPlatforms([
      ...current,
      { platform: 'myapp', displayName: 'My App', enabled: true, sortOrder: 130, renderer: 'singbox' },
    ])
    expect(put.status).toBe(200)
    const after = ((await put.json()) as { platforms: PlatformSetting[] }).platforms
    expect(after.find((entry) => entry.platform === 'myapp')).toMatchObject({ displayName: 'My App', renderer: 'singbox' })

    const userView = await fetchApi('/api/account/subscription-platforms', withCookie(adminCookie))
    expect(userView.status).toBe(200)
    const userPlatforms = ((await userView.json()) as { platforms: Array<{ platform: string; displayName: string }> }).platforms
    expect(userPlatforms).toContainEqual({ platform: 'myapp', displayName: 'My App' })

    const links = subscriptionLinks('https://sub.example.com', 'tok123', await listPlatformSettings(env.DB))
    expect(links.myapp).toBe('https://sub.example.com/sub/tok123/myapp')
    expect(links.auto).toBe('https://sub.example.com/sub/tok123')
    expect(links.clash).toBe('https://sub.example.com/sub/tok123/clash')
  })

  it('renames a platform key and the old key stops resolving', async () => {
    const current = await adminPlatforms()
    const renamed = current.map((entry) =>
      entry.platform === 'clash' ? { ...entry, platform: 'clash-new' } : entry)
    expect((await putPlatforms(renamed)).status).toBe(200)
    const after = await adminPlatforms()
    expect(after.map((entry) => entry.platform)).toContain('clash-new')
    expect(after.map((entry) => entry.platform)).not.toContain('clash')

    expect(await resolveSubscriptionClient(env.DB, 'clash')).toBeNull()
    expect(await resolveSubscriptionClient(env.DB, 'clash-new')).toBe('mihomo')
    const links = subscriptionLinks('https://sub.example.com', 'tok123', after)
    expect(links['clash-new']).toBe('https://sub.example.com/sub/tok123/clash-new')
    expect(links.clash).toBeUndefined()
  })

  it('deletes a platform and its link and resolver entry disappear', async () => {
    const current = await adminPlatforms()
    expect((await putPlatforms(current.filter((entry) => entry.platform !== 'surge'))).status).toBe(200)
    const after = await adminPlatforms()
    expect(after.map((entry) => entry.platform)).not.toContain('surge')
    expect(await resolveSubscriptionClient(env.DB, 'surge')).toBeNull()
    const links = subscriptionLinks('https://sub.example.com', 'tok123', after)
    expect(links.surge).toBeUndefined()
    const userView = await fetchApi('/api/account/subscription-platforms', withCookie(adminCookie))
    expect(((await userView.json()) as { platforms: Array<{ platform: string }> }).platforms
      .map((entry) => entry.platform)).not.toContain('surge')
  })

  it('lets auto change display, toggle and order but never take a fixed renderer', async () => {
    const current = await adminPlatforms()
    const changed = current.map((entry) =>
      entry.platform === 'auto' ? { ...entry, displayName: '自动', enabled: false } : entry)
    expect((await putPlatforms(changed)).status).toBe(200)
    expect((await adminPlatforms()).find((entry) => entry.platform === 'auto'))
      .toMatchObject({ displayName: '自动', enabled: false, renderer: 'auto' })
    const userView = await fetchApi('/api/account/subscription-platforms', withCookie(adminCookie))
    expect(((await userView.json()) as { platforms: Array<{ platform: string }> }).platforms
      .map((entry) => entry.platform)).not.toContain('auto')
    // /sub/<token>/auto never had a fixed format, and still has none.
    expect(await resolveSubscriptionClient(env.DB, 'auto')).toBeNull()
  })

  it('rejects invalid platform entries with 400 naming the key and leaves state unchanged', async () => {
    const current = await adminPlatforms()
    const cases: Array<[unknown, RegExp]> = [
      [current.map((entry) => entry.platform === 'mihomo' ? { ...entry, platform: 'Bad_Key' } : entry), /Bad_Key/],
      [[...current, current[1]], /mihomo/],
      [current.map((entry) => entry.platform === 'clash' ? { ...entry, renderer: 'not-a-client' } : entry), /clash/],
      [current.map((entry) => entry.platform === 'auto' ? { ...entry, renderer: 'mihomo' } : entry), /auto/],
      [current.map((entry) => {
        if (entry.platform !== 'loon') return entry
        const { displayName: _displayName, ...rest } = entry
        return rest
      }), /loon/],
      [current.map((entry) => entry.platform === 'loon' ? { ...entry, sortOrder: -1 } : entry), /loon/],
      [current.map((entry) => entry.platform === 'loon' ? { ...entry, enabled: 'yes' } : entry), /loon/],
    ]
    for (const [list, pattern] of cases) {
      await expect(updatePlatformSettings(env.DB, list)).rejects.toMatchObject({ status: 400, code: 'PLATFORM_INVALID' })
      await expect(updatePlatformSettings(env.DB, list)).rejects.toThrow(pattern)
    }
    expect(await listPlatformSettings(env.DB)).toEqual(current)
  })

  it('resolves renderers database-first with alias fallback and unknown keys to null', async () => {
    // The database wins over the hardcoded alias: clash renders sing-box now.
    const current = await listPlatformSettings(env.DB)
    await updatePlatformSettings(env.DB, current.map((entry) =>
      entry.platform === 'clash' ? { ...entry, renderer: 'singbox' } : entry))
    expect(await resolveSubscriptionClient(env.DB, 'clash')).toBe('singbox')

    // Legacy alias spellings that were never platform keys still resolve.
    expect(await resolveSubscriptionClient(env.DB, 'sing-box')).toBe('singbox')
    expect(await resolveSubscriptionClient(env.DB, 'quantumult-x')).toBe('quantumultx')
    expect(await resolveSubscriptionClient(env.DB, 'v2rayng')).toBe('v2rayn')
    expect(await resolveSubscriptionClient(env.DB, 'neko-box')).toBe('nekobox')
    // Bare client ids keep working.
    expect(await resolveSubscriptionClient(env.DB, 'generic')).toBe('generic')
    expect(await resolveSubscriptionClient(env.DB, 'mihomo')).toBe('mihomo')
    // Unknown keys resolve to nothing (the route answers 404).
    expect(await resolveSubscriptionClient(env.DB, 'definitely-not-a-client')).toBeNull()

    // A deleted seed key 404s instead of falling back to its alias.
    const afterDelete = (await listPlatformSettings(env.DB)).filter((entry) => entry.platform !== 'stash')
    await updatePlatformSettings(env.DB, afterDelete)
    expect(await resolveSubscriptionClient(env.DB, 'stash')).toBeNull()
  })
})
