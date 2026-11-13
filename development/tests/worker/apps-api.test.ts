import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

type ErrorBody = { error: { code: string, message: string } }

type AdminPlatformDto = {
  id: string
  appId: string
  platform: string
  downloadUrl: string
  documentationUrl: string | null
  sortOrder: number
}

type AdminAppDto = {
  id: string
  name: string
  description: string
  enabled: boolean
  sortOrder: number
  platforms: AdminPlatformDto[]
}

function appInput(overrides: Record<string, unknown> = {}) {
  return {
    name: '示例应用',
    description: '详细介绍',
    enabled: true,
    sortOrder: 0,
    platforms: [{ platform: 'android', downloadUrl: 'https://cdn.example.com/app.apk' }],
    ...overrides,
  }
}

function authed(cookie: string, method: string, path: string, body?: unknown) {
  if (body === undefined) {
    const headers = method === 'GET' || method === 'HEAD' ? {} : { origin: TEST_ORIGIN }
    return exports.default.fetch(`${TEST_ORIGIN}${path}`, withCookie(cookie, { method, headers }))
  }
  return exports.default.fetch(`${TEST_ORIGIN}${path}`, jsonRequest(body, withCookie(cookie, { method })))
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  const body = await response.json() as ErrorBody
  expect(body.error.code).toBe(code)
  expect(body.error.message.endsWith('。')).toBe(false)
  expect(body.error.message.endsWith('.')).toBe(false)
}

async function provisionUser(adminCookie: string): Promise<string> {
  const invite = await authed(adminCookie, 'POST', '/api/admin/invites', { username: 'reader' })
  expect(invite.status).toBe(201)
  const link = (await invite.json() as { invite: { link: string } }).invite.link
  const token = new URL(link).pathname.split('/').at(-1) ?? ''
  const redeemed = await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`, jsonRequest({ password: 'reader-password' }))
  expect(redeemed.status).toBe(201)
  return login('reader', 'reader-password')
}

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

describe('admin app catalog', () => {
  it('requires an admin session', async () => {
    const admin = await login()
    const reader = await provisionUser(admin)
    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/admin/apps`), 401, 'AUTH_REQUIRED')
    await expectError(await authed(reader, 'GET', '/api/admin/apps'), 403, 'ADMIN_REQUIRED')
    await expectError(await authed(reader, 'POST', '/api/admin/apps', appInput()), 403, 'ADMIN_REQUIRED')
  })

  it('creates, updates, and deletes apps with cascaded platforms', async () => {
    const admin = await login()
    const created = await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '面板',
      sortOrder: 2,
      platforms: [
        { platform: 'windows', downloadUrl: 'https://cdn.example.com/panel.exe', documentationUrl: 'https://example.com/docs' },
        { platform: 'android', downloadUrl: 'https://cdn.example.com/panel.apk' },
      ],
    }))
    expect(created.status).toBe(201)
    const app = (await created.json() as { app: AdminAppDto }).app
    expect(app.id).toMatch(/^app_[1-9]\d*$/)
    expect(app.name).toBe('面板')
    expect(app.enabled).toBe(true)
    expect(app.platforms.map((item) => item.platform)).toEqual(['windows', 'android'])
    const windows = app.platforms[0]
    expect(windows?.id).toMatch(/^plt_[1-9]\d*$/)
    expect(windows?.documentationUrl).toBe('https://example.com/docs')
    expect(app.platforms[1]?.documentationUrl).toBeNull()

    const replaced = await authed(admin, 'PUT', `/api/admin/apps/${app.id}`, appInput({
      name: '面板 Pro',
      platforms: [
        { platform: 'windows', downloadUrl: 'https://cdn.example.com/panel-pro.exe' },
        { platform: 'ios', downloadUrl: 'https://cdn.example.com/panel.ipa' },
      ],
    }))
    expect(replaced.status).toBe(200)
    const replacedApp = (await replaced.json() as { app: AdminAppDto }).app
    expect(replacedApp.name).toBe('面板 Pro')
    expect(replacedApp.platforms.map((item) => item.platform)).toEqual(['windows', 'ios'])
    expect(replacedApp.platforms[0]?.id).toBe(windows?.id)
    expect(replacedApp.platforms[0]?.downloadUrl).toBe('https://cdn.example.com/panel-pro.exe')

    const other = await authed(admin, 'POST', '/api/admin/apps', appInput({ name: '另一个' }))
    const otherApp = (await other.json() as { app: AdminAppDto }).app

    await expectError(await authed(admin, 'GET', '/api/admin/apps/missing'), 404, 'NOT_FOUND')
    await expectError(await authed(admin, 'DELETE', '/api/admin/apps/nope'), 404, 'APP_NOT_FOUND')

    const removedApp = await authed(admin, 'DELETE', `/api/admin/apps/${otherApp.id}`)
    expect(removedApp.status).toBe(204)

    const list = await authed(admin, 'GET', '/api/admin/apps')
    expect(list.status).toBe(200)
    const body = await list.json() as {
      schemaVersion: number
      apps: AdminAppDto[]
      platforms?: unknown
      nextAppId?: number
    }
    expect(body.schemaVersion).toBe(1)
    expect(body.nextAppId).toBeUndefined()
    expect(body.platforms).toBeUndefined()
    expect(body.apps.map((item) => item.id)).toEqual([app.id])
    expect(body.apps[0]?.platforms.map((item) => item.platform)).toEqual(['windows', 'ios'])
  })

  it('rejects non-https download and documentation URLs', async () => {
    const admin = await login()
    for (const downloadUrl of ['http://cdn.example.com/app.apk', 'javascript:alert(1)', 'ftp://files.example.com/a.apk', 'file:///tmp/a.apk', 'data:text/plain,hi']) {
      await expectError(
        await authed(admin, 'POST', '/api/admin/apps', appInput({
          platforms: [{ platform: 'android', downloadUrl }],
        })),
        422,
        'VALIDATION_FAILED',
      )
    }
    await expectError(
      await authed(admin, 'POST', '/api/admin/apps', appInput({
        platforms: [{ platform: 'android', downloadUrl: 'https://cdn.example.com/app.apk', documentationUrl: 'http://example.com/docs' }],
      })),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await authed(admin, 'POST', '/api/admin/apps', appInput({
        platforms: [
          { platform: 'android', downloadUrl: 'https://cdn.example.com/a.apk' },
          { platform: 'android', downloadUrl: 'https://cdn.example.com/b.apk' },
        ],
      })),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await authed(admin, 'POST', '/api/admin/apps', appInput({ platforms: [] })),
      422,
      'VALIDATION_FAILED',
    )
    const allowed = await authed(admin, 'POST', '/api/admin/apps', appInput())
    expect(allowed.status).toBe(201)
  })
})

describe('user app catalog', () => {
  it('returns only enabled apps with their configured platforms', async () => {
    const admin = await login()
    const reader = await provisionUser(admin)
    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/apps`), 401, 'AUTH_REQUIRED')

    const visible = (await (await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '公开应用',
      sortOrder: 5,
      platforms: [
        { platform: 'ios', downloadUrl: 'https://cdn.example.com/visible-ios.ipa' },
        { platform: 'android', downloadUrl: 'https://cdn.example.com/visible-android.apk', documentationUrl: 'https://example.com/guide' },
      ],
    }))).json() as { app: AdminAppDto }).app
    const earlier = (await (await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '靠前应用',
      sortOrder: 1,
      platforms: [{ platform: 'windows', downloadUrl: 'https://cdn.example.com/earlier.exe' }],
    }))).json() as { app: AdminAppDto }).app
    const disabled = (await (await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '停用应用',
      enabled: false,
      platforms: [{ platform: 'windows', downloadUrl: 'https://cdn.example.com/disabled.exe' }],
    }))).json() as { app: AdminAppDto }).app

    const listResponse = await authed(reader, 'GET', '/api/apps')
    expect(listResponse.status).toBe(200)
    const list = await listResponse.json() as {
      downloadsEnabled: boolean
      apps: Array<{ id: string, name: string, platforms: Array<{ platform: string, downloadUrl: string, documentationUrl: string | null }> }>
      revision?: number
      platforms?: unknown
      nextAppId?: number
    }
    expect(list.downloadsEnabled).toBe(true)
    expect(list.revision).toBeUndefined()
    expect(list.platforms).toBeUndefined()
    expect(list.nextAppId).toBeUndefined()
    expect(list.apps.map((item) => item.id)).toEqual([earlier.id, visible.id])
    const visibleDto = list.apps[1]
    expect(visibleDto?.platforms.map((item) => item.platform)).toEqual(['android', 'ios'])
    expect(visibleDto?.platforms.map((item) => item.downloadUrl)).toEqual([
      'https://cdn.example.com/visible-android.apk',
      'https://cdn.example.com/visible-ios.ipa',
    ])
    expect(visibleDto?.platforms[0]?.documentationUrl).toBe('https://example.com/guide')
    expect(visibleDto?.platforms[1]?.documentationUrl).toBeNull()
    expect(Object.keys(visibleDto ?? {}).sort()).toEqual([
      'description', 'id', 'name', 'platforms', 'sortOrder',
    ])
    expect(Object.keys(visibleDto?.platforms[0] ?? {}).sort()).toEqual([
      'documentationUrl', 'downloadUrl', 'id', 'platform', 'sortOrder',
    ])
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain('停用应用')
    expect(serialized).not.toContain('disabled.exe')
    expect(serialized).not.toContain('nextPlatformId')

    const detail = await authed(reader, 'GET', `/api/apps/${visible.id}`)
    expect(detail.status).toBe(200)
    const detailBody = await detail.json() as { app: { id: string, enabled?: unknown } }
    expect(detailBody.app.id).toBe(visible.id)
    expect(detailBody.app.enabled).toBeUndefined()
    await expectError(await authed(reader, 'GET', `/api/apps/${disabled.id}`), 404, 'APP_NOT_FOUND')
    await expectError(await authed(reader, 'GET', '/api/apps/app_999'), 404, 'APP_NOT_FOUND')
  })
})
