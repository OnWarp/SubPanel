import { env, exports } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { readAppsFromD1 } from '../../../worker/apps/d1-repository'
import { getShowAppDownloads, putShowAppDownloads } from '../../../worker/db/settings-repository'
import { appRefactorMigration, emptyDatabase, initMigration } from './d1'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const NOW = '2026-07-23T00:00:00.000Z'

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)

let adminCookie: string
let userCookie: string

async function createUser(): Promise<string> {
  const invite = await fetchApi('/api/admin/invites', jsonRequest({ username: 'member' }, withCookie(adminCookie)))
  const link = ((await invite.json()) as { invite: { link: string } }).invite.link
  const token = new URL(link).pathname.split('/').at(-1) ?? ''
  await fetchApi(`/api/invites/${token}`, jsonRequest({ password: 'member-password' }))
  return login('member', 'member-password')
}

const APP_ONE = {
  name: '客户端',
  description: '简介一',
  enabled: true,
  sortOrder: 0,
  platforms: [
    { platform: 'windows', downloadUrl: 'https://cdn.example.com/a.exe', documentationUrl: 'https://example.com/docs' },
    { platform: 'android', downloadUrl: 'https://cdn.example.com/a.apk' },
  ],
}

async function createAppOne(): Promise<{ id: string, platforms: Array<{ id: string, platform: string }> }> {
  const response = await fetchApi('/api/admin/apps', jsonRequest(APP_ONE, withCookie(adminCookie, { method: 'POST' })))
  expect(response.status).toBe(201)
  const body = await response.json() as { app: { id: string, platforms: Array<{ id: string, platform: string }> } }
  return body.app
}

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await env.DB.prepare('DELETE FROM system_settings WHERE key = ?').bind('show_app_downloads').run()
  await setupAdmin()
  adminCookie = await login()
})

describe('migration 0006 reshapes legacy apps data', () => {
  it('slims the schema, filters invalid platforms and disables apps without valid platforms', async () => {
    await emptyDatabase(env.DB)
    await applyD1Migrations(env.DB, [initMigration])

    const insertApp = `INSERT INTO apps (
      id, name, icon, summary, description, category, official_website, developer,
      is_recommended, is_official, is_popular, is_enabled, is_public, sort_order, created_at, updated_at
    ) VALUES (?, ?, '', ?, ?, '工具', '', NULL, 0, 0, 0, ?, ?, ?, ?, ?)`
    const legacyApps: Array<[string, string, string, string, number, number, number]> = [
      ['app_1', '客户端A', '旧简介', '旧长介绍', 1, 1, 0],
      ['app_2', '客户端B', '', '说明二', 1, 0, 1],
      ['app_3', '客户端C', '简介三', '', 1, 1, 2],
      ['app_4', '客户端D', '简介四', '', 1, 1, 3],
    ]
    for (const [id, name, summary, description, isEnabled, isPublic, sortOrder] of legacyApps) {
      await env.DB.prepare(insertApp).bind(id, name, summary, description, isEnabled, isPublic, sortOrder, NOW, NOW).run()
    }

    const insertPlatform = `INSERT INTO app_platforms (
      id, app_id, platform, version, download_url, download_type, file_size_kb,
      official_store_url, official_download_url, update_notes,
      import_supported, import_protocol, import_url_template, import_instructions,
      is_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, '1.0.0', ?, 'direct', NULL, ?, ?, '', 0, '', '', '', ?, ?, ?)`
    const legacyPlatforms: Array<[string, string, string, string, string, string, number, string]> = [
      ['plt_1', 'app_1', 'windows', 'https://cdn.example.com/a.exe', '', '', 1, '2024-01-01T00:00:00.000Z'],
      ['plt_2', 'app_1', 'windows', 'https://cdn.example.com/a2.exe', '', '', 1, '2024-01-02T00:00:00.000Z'],
      ['plt_3', 'app_1', 'android', '', '', 'https://cdn.example.com/a.apk', 1, '2024-01-01T00:00:00.000Z'],
      ['plt_4', 'app_1', 'ios', 'http://cdn.example.com/a.ipa', '', '', 1, '2024-01-01T00:00:00.000Z'],
      ['plt_5', 'app_1', 'macos', 'https://cdn.example.com/a.dmg', '', '', 0, '2024-01-01T00:00:00.000Z'],
      ['plt_6', 'app_1', 'linux', '', 'https://store.example.com/a', '', 1, '2024-01-01T00:00:00.000Z'],
      ['plt_7', 'app_2', 'windows', 'https://cdn.example.com/b.exe', '', '', 1, '2024-01-01T00:00:00.000Z'],
      ['plt_8', 'app_3', 'windows', 'http://cdn.example.com/c.exe', '', '', 1, '2024-01-01T00:00:00.000Z'],
    ]
    for (const [id, appId, platform, downloadUrl, storeUrl, officialUrl, isEnabled, createdAt] of legacyPlatforms) {
      await env.DB.prepare(insertPlatform)
        .bind(id, appId, platform, downloadUrl, storeUrl, officialUrl, isEnabled, createdAt, createdAt)
        .run()
    }

    const settings: Array<[string, string]> = [
      ['apps_schema_version', '1'],
      ['apps_revision', '1'],
      ['apps_updated_at', '"2024-01-01T00:00:00.000Z"'],
      ['next_app_id', '5'],
      ['next_platform_id', '9'],
      ['apps_entity_order', JSON.stringify({
        apps: ['app_1', 'app_2', 'app_3', 'app_4'],
        platforms: ['plt_1', 'plt_2', 'plt_3', 'plt_4', 'plt_5', 'plt_6', 'plt_7', 'plt_8'],
      })],
    ]
    for (const [key, value] of settings) {
      await env.DB.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(key, value, NOW).run()
    }

    await applyD1Migrations(env.DB, [appRefactorMigration])

    const appColumns = await env.DB.prepare("SELECT name FROM pragma_table_info('apps') ORDER BY cid").all<{ name: string }>()
    expect(appColumns.results.map((row) => row.name)).toEqual([
      'id', 'name', 'description', 'enabled', 'sort_order', 'created_at', 'updated_at',
    ])
    const platformColumns = await env.DB.prepare("SELECT name FROM pragma_table_info('app_platforms') ORDER BY cid").all<{ name: string }>()
    expect(platformColumns.results.map((row) => row.name)).toEqual([
      'id', 'app_id', 'platform', 'download_url', 'documentation_url', 'sort_order', 'created_at', 'updated_at',
    ])
    const platformTableSql = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_platforms'",
    ).first<{ sql: string }>()
    expect(platformTableSql?.sql).toContain('UNIQUE')

    const snapshot = await readAppsFromD1(env.DB)
    expect(snapshot.apps.map((app) => [app.id, app.enabled])).toEqual([
      ['app_1', true],
      ['app_2', false],
      ['app_3', false],
      ['app_4', false],
    ])
    expect(snapshot.apps[0].description).toBe('旧简介')
    expect(snapshot.apps[1].description).toBe('说明二')
    expect(snapshot.platforms.map((platform) => platform.id)).toEqual(['plt_1', 'plt_3', 'plt_6', 'plt_7'])
    const byId = new Map(snapshot.platforms.map((platform) => [platform.id, platform]))
    expect(byId.get('plt_1')?.downloadUrl).toBe('https://cdn.example.com/a.exe')
    expect(byId.get('plt_3')?.downloadUrl).toBe('https://cdn.example.com/a.apk')
    expect(byId.get('plt_6')?.downloadUrl).toBe('https://store.example.com/a')
    expect(byId.get('plt_7')?.appId).toBe('app_2')
  })
})

describe('admin apps API', () => {
  it('creates an app with platforms in one save and returns the nested shape', async () => {
    const app = await createAppOne()
    expect(app.id).toBe('app_1')
    expect(app.platforms.map((platform) => platform.platform)).toEqual(['windows', 'android'])

    const list = await fetchApi('/api/admin/apps', withCookie(adminCookie))
    expect(list.status).toBe(200)
    const body = await list.json() as { apps: Array<{ id: string, name: string, platforms: unknown[] }> }
    expect(body.apps).toHaveLength(1)
    expect(body.apps[0].name).toBe('客户端')
    expect(body.apps[0].platforms).toHaveLength(2)
  })

  it('rejects invalid payloads with 422', async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...APP_ONE, platforms: [APP_ONE.platforms[0], APP_ONE.platforms[0]] },
      { ...APP_ONE, platforms: [] },
      { ...APP_ONE, platforms: [{ platform: 'windows', downloadUrl: 'http://cdn.example.com/a.exe' }] },
      { ...APP_ONE, platforms: [{ platform: 'windows', downloadUrl: 'https://cdn.example.com/a.exe', documentationUrl: 'http://example.com/docs' }] },
      { ...APP_ONE, platforms: [{ platform: 'win', downloadUrl: 'https://cdn.example.com/a.exe' }] },
      { ...APP_ONE, name: '  ' },
    ]
    for (const payload of cases) {
      const response = await fetchApi('/api/admin/apps', jsonRequest(payload, withCookie(adminCookie, { method: 'POST' })))
      expect(response.status).toBe(422)
    }
    const list = await fetchApi('/api/admin/apps', withCookie(adminCookie))
    const body = await list.json() as { apps: unknown[] }
    expect(body.apps).toHaveLength(0)
  })

  it('requires admin and forbids anonymous and member writes', async () => {
    const anonymous = await fetchApi('/api/admin/apps', jsonRequest(APP_ONE, { method: 'POST' }))
    expect(anonymous.status).toBe(401)
    userCookie = await createUser()
    const member = await fetchApi('/api/admin/apps', jsonRequest(APP_ONE, withCookie(userCookie, { method: 'POST' })))
    expect(member.status).toBe(403)
  })

  it('updates an app wholesale, preserving kept platform ids and dropping removed ones', async () => {
    const app = await createAppOne()
    const windowsId = app.platforms.find((platform) => platform.platform === 'windows')?.id

    const update = {
      name: '客户端改',
      description: '新简介',
      enabled: true,
      sortOrder: 5,
      platforms: [
        { platform: 'windows', downloadUrl: 'https://cdn.example.com/a-new.exe' },
        { platform: 'ios', downloadUrl: 'https://cdn.example.com/a.ipa' },
      ],
    }
    const response = await fetchApi(`/api/admin/apps/${app.id}`, jsonRequest(update, withCookie(adminCookie, { method: 'PUT' })))
    expect(response.status).toBe(200)
    const body = await response.json() as { app: { name: string, platforms: Array<{ id: string, platform: string, downloadUrl: string }> } }
    expect(body.app.name).toBe('客户端改')
    expect(body.app.platforms.map((platform) => platform.platform)).toEqual(['windows', 'ios'])
    expect(body.app.platforms.find((platform) => platform.platform === 'windows')?.id).toBe(windowsId)
    expect(body.app.platforms.find((platform) => platform.platform === 'windows')?.downloadUrl).toBe('https://cdn.example.com/a-new.exe')

    const invalid = await fetchApi(`/api/admin/apps/${app.id}`, jsonRequest(
      { ...update, platforms: [update.platforms[0], update.platforms[0]] },
      withCookie(adminCookie, { method: 'PUT' }),
    ))
    expect(invalid.status).toBe(422)
    const after = await fetchApi('/api/admin/apps', withCookie(adminCookie))
    const afterBody = await after.json() as { apps: Array<{ name: string }> }
    expect(afterBody.apps[0].name).toBe('客户端改')
  })

  it('toggles enabled and deletes with platform cascade', async () => {
    const app = await createAppOne()
    const off = await fetchApi(`/api/admin/apps/${app.id}/enabled`, jsonRequest({ enabled: false }, withCookie(adminCookie, { method: 'POST' })))
    expect(off.status).toBe(200)
    expect(((await off.json()) as { app: { enabled: boolean } }).app.enabled).toBe(false)

    const removed = await fetchApi(`/api/admin/apps/${app.id}`, withCookie(adminCookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }))
    expect(removed.status).toBe(204)
    const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM app_platforms WHERE app_id = ?')
      .bind(app.id).first<{ count: number }>()
    expect(remaining?.count).toBe(0)
    const missing = await fetchApi(`/api/admin/apps/${app.id}`, withCookie(adminCookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }))
    expect(missing.status).toBe(404)
  })
})

describe('user apps API and the downloads switch', () => {
  it('defaults the switch on and only exposes enabled apps with valid platforms', async () => {
    await createAppOne()
    const second = await fetchApi('/api/admin/apps', jsonRequest({
      name: '停用应用',
      description: '',
      enabled: false,
      sortOrder: 1,
      platforms: [{ platform: 'windows', downloadUrl: 'https://cdn.example.com/b.exe' }],
    }, withCookie(adminCookie, { method: 'POST' })))
    expect(second.status).toBe(201)

    const setting = await fetchApi('/api/admin/system/app-downloads', withCookie(adminCookie))
    expect(setting.status).toBe(200)
    expect(await setting.json()).toEqual({ enabled: true })
    expect(await getShowAppDownloads(env.DB)).toBe(true)

    userCookie = await createUser()
    const list = await fetchApi('/api/apps', withCookie(userCookie))
    expect(list.status).toBe(200)
    const body = await list.json() as {
      downloadsEnabled: boolean
      apps: Array<{ id: string, name: string, platforms: Array<{ platform: string, downloadUrl: string, documentationUrl: string | null }> }>
    }
    expect(body.downloadsEnabled).toBe(true)
    expect(body.apps.map((app) => app.name)).toEqual(['客户端'])
    expect(body.apps[0].platforms.map((platform) => platform.platform)).toEqual(['windows', 'android'])
    expect(body.apps[0].platforms[0].documentationUrl).toBe('https://example.com/docs')
    expect(body.apps[0].platforms[1].documentationUrl).toBeNull()
    expect(JSON.stringify(body)).not.toContain('停用应用')

    const detail = await fetchApi(`/api/apps/${body.apps[0].id}`, withCookie(userCookie))
    expect(detail.status).toBe(200)
    const anonymous = await fetchApi('/api/apps')
    expect(anonymous.status).toBe(401)
  })

  it('leaks nothing when the switch is off and restores visibility when back on', async () => {
    const app = await createAppOne()
    userCookie = await createUser()

    const off = await fetchApi('/api/admin/system/app-downloads', jsonRequest({ enabled: false }, withCookie(adminCookie, { method: 'PUT' })))
    expect(off.status).toBe(200)
    expect(await getShowAppDownloads(env.DB)).toBe(false)

    const list = await fetchApi('/api/apps', withCookie(userCookie))
    expect(list.status).toBe(200)
    const text = await list.text()
    expect(JSON.parse(text)).toEqual({ downloadsEnabled: false, apps: [] })
    expect(text).not.toContain('客户端')
    expect(text).not.toContain('cdn.example.com')

    const detail = await fetchApi(`/api/apps/${app.id}`, withCookie(userCookie))
    expect(detail.status).toBe(404)

    const adminList = await fetchApi('/api/admin/apps', withCookie(adminCookie))
    expect(adminList.status).toBe(200)
    expect(((await adminList.json()) as { apps: unknown[] }).apps).toHaveLength(1)

    const on = await fetchApi('/api/admin/system/app-downloads', jsonRequest({ enabled: true }, withCookie(adminCookie, { method: 'PUT' })))
    expect(on.status).toBe(200)
    const restored = await fetchApi('/api/apps', withCookie(userCookie))
    const restoredBody = await restored.json() as { downloadsEnabled: boolean, apps: unknown[] }
    expect(restoredBody.downloadsEnabled).toBe(true)
    expect(restoredBody.apps).toHaveLength(1)
  })

  it('rejects an invalid switch payload and round-trips the repository helpers', async () => {
    const invalid = await fetchApi('/api/admin/system/app-downloads', jsonRequest({ enabled: 'yes' }, withCookie(adminCookie, { method: 'PUT' })))
    expect(invalid.status).toBe(422)
    await putShowAppDownloads(env.DB, false)
    expect(await getShowAppDownloads(env.DB)).toBe(false)
    await putShowAppDownloads(env.DB, true)
    expect(await getShowAppDownloads(env.DB)).toBe(true)
  })
})
