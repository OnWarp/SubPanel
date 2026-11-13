import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

type Flags = {
  isRecommended: boolean
  isOfficial: boolean
  isPopular: boolean
  isEnabled: boolean
  isPublic: boolean
}

type ErrorBody = { error: { code: string, message: string } }

const baseFlags: Flags = {
  isRecommended: false,
  isOfficial: false,
  isPopular: false,
  isEnabled: true,
  isPublic: true,
}

function appInput(overrides: { flags?: Partial<Flags> } & Record<string, unknown> = {}) {
  const { flags, ...rest } = overrides
  return {
    name: '示例应用',
    icon: '',
    summary: '一句话简介',
    description: '详细介绍',
    category: '工具',
    officialWebsite: '',
    developer: 'Example Lab',
    sortOrder: 0,
    ...rest,
    flags: { ...baseFlags, ...flags },
  }
}

function platformInput(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'android',
    version: '1.2.0',
    downloadUrl: 'https://cdn.example.com/app.apk',
    downloadType: 'direct',
    fileSizeKb: 1024,
    officialStoreUrl: '',
    officialDownloadUrl: '',
    updateNotes: '',
    importSupported: true,
    importProtocol: 'clash',
    importUrlTemplate: 'clash://install-config?url={url}',
    importInstructions: '打开客户端后导入',
    isEnabled: true,
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
    const created = await authed(admin, 'POST', '/api/admin/apps', appInput({ name: '面板', sortOrder: 2, flags: { isRecommended: true } }))
    expect(created.status).toBe(201)
    const app = (await created.json() as { app: { id: string, name: string, flags: Flags, developer?: string } }).app
    expect(app.id).toMatch(/^app_[1-9]\d*$/)
    expect(app.name).toBe('面板')
    expect(app.flags.isRecommended).toBe(true)
    expect(app.developer).toBe('Example Lab')

    const platform = await authed(admin, 'POST', `/api/admin/apps/${app.id}/platforms`, platformInput())
    expect(platform.status).toBe(201)
    const storedPlatform = (await platform.json() as { platform: { id: string, importUrlTemplate: string, downloadUrl: string } }).platform
    expect(storedPlatform.id).toMatch(/^plt_[1-9]\d*$/)
    expect(storedPlatform.importUrlTemplate).toBe('clash://install-config?url={url}')

    const renamed = await authed(admin, 'PUT', `/api/admin/apps/${app.id}`, appInput({ name: '面板 Pro', developer: null, flags: { isRecommended: true } }))
    expect(renamed.status).toBe(200)
    const renamedApp = (await renamed.json() as { app: { name: string, developer?: string } }).app
    expect(renamedApp.name).toBe('面板 Pro')
    expect(renamedApp.developer).toBeUndefined()

    const versioned = await authed(admin, 'PUT', `/api/admin/apps/${app.id}/platforms/${storedPlatform.id}`, platformInput({ version: '1.3.0' }))
    expect(versioned.status).toBe(200)
    expect((await versioned.json() as { platform: { version: string } }).platform.version).toBe('1.3.0')

    const other = await authed(admin, 'POST', '/api/admin/apps', appInput({ name: '另一个', category: '系统' }))
    const otherApp = (await other.json() as { app: { id: string } }).app
    const otherPlatform = await authed(admin, 'POST', `/api/admin/apps/${otherApp.id}/platforms`, platformInput({
      downloadUrl: 'https://cdn.example.com/other.apk',
    }))
    const otherPlatformId = (await otherPlatform.json() as { platform: { id: string } }).platform.id

    await expectError(
      await authed(admin, 'PUT', `/api/admin/apps/${otherApp.id}/platforms/${storedPlatform.id}`, platformInput({ version: '9.9.9' })),
      404,
      'PLATFORM_NOT_FOUND',
    )
    await expectError(await authed(admin, 'GET', '/api/admin/apps/missing'), 404, 'NOT_FOUND')
    await expectError(await authed(admin, 'DELETE', '/api/admin/apps/nope'), 404, 'APP_NOT_FOUND')

    const removedPlatform = await authed(admin, 'DELETE', `/api/admin/apps/${app.id}/platforms/${storedPlatform.id}`)
    expect(removedPlatform.status).toBe(204)
    const removedApp = await authed(admin, 'DELETE', `/api/admin/apps/${otherApp.id}`)
    expect(removedApp.status).toBe(204)

    const list = await authed(admin, 'GET', '/api/admin/apps')
    expect(list.status).toBe(200)
    const body = await list.json() as {
      schemaVersion: number
      apps: Array<{ id: string, name: string }>
      platforms: Array<{ id: string, appId: string }>
      nextAppId?: number
    }
    expect(body.schemaVersion).toBe(1)
    expect(body.nextAppId).toBeUndefined()
    expect(body.apps.map((item) => item.id)).toEqual([app.id])
    expect(body.platforms.map((item) => item.id)).toEqual([])
    expect(body.platforms.some((item) => item.id === otherPlatformId)).toBe(false)
  })

  it('rejects non-http download and store URLs', async () => {
    const admin = await login()
    const app = (await (await authed(admin, 'POST', '/api/admin/apps', appInput())).json() as { app: { id: string } }).app
    for (const downloadUrl of ['javascript:alert(1)', 'ftp://files.example.com/a.apk', 'file:///tmp/a.apk', 'data:text/plain,hi']) {
      await expectError(
        await authed(admin, 'POST', `/api/admin/apps/${app.id}/platforms`, platformInput({ downloadUrl })),
        422,
        'VALIDATION_FAILED',
      )
    }
    await expectError(
      await authed(admin, 'POST', `/api/admin/apps/${app.id}/platforms`, platformInput({ officialStoreUrl: 'ftp://files.example.com/a' })),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await authed(admin, 'POST', '/api/admin/apps', appInput({ icon: 'javascript:alert(1)' })),
      422,
      'VALIDATION_FAILED',
    )
    const allowed = await authed(admin, 'POST', `/api/admin/apps/${app.id}/platforms`, platformInput({
      downloadUrl: 'http://cdn.example.com/app.apk',
      officialDownloadUrl: 'https://example.com/download',
    }))
    expect(allowed.status).toBe(201)
  })
})

describe('user app catalog', () => {
  it('returns only enabled public apps and enabled platforms', async () => {
    const admin = await login()
    const reader = await provisionUser(admin)
    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/apps`), 401, 'AUTH_REQUIRED')

    const visible = (await (await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '公开应用',
      sortOrder: 5,
      developer: null,
      flags: { isRecommended: true, isOfficial: true },
    }))).json() as { app: { id: string } }).app
    const earlier = (await (await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '靠前应用',
      sortOrder: 1,
      category: '网络',
    }))).json() as { app: { id: string } }).app
    const hidden = (await (await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '内部应用',
      flags: { isPublic: false },
    }))).json() as { app: { id: string } }).app
    const disabled = (await (await authed(admin, 'POST', '/api/admin/apps', appInput({
      name: '停用应用',
      flags: { isEnabled: false },
    }))).json() as { app: { id: string } }).app

    await authed(admin, 'POST', `/api/admin/apps/${visible.id}/platforms`, platformInput({
      platform: 'ios',
      version: '2.0.0',
      downloadUrl: 'https://cdn.example.com/visible-ios.ipa',
    }))
    await authed(admin, 'POST', `/api/admin/apps/${visible.id}/platforms`, platformInput({
      platform: 'android',
      version: '2.1.0',
      downloadUrl: 'https://cdn.example.com/secret-android.apk',
      isEnabled: false,
    }))
    await authed(admin, 'POST', `/api/admin/apps/${hidden.id}/platforms`, platformInput({
      downloadUrl: 'https://cdn.example.com/hidden.apk',
    }))

    const listResponse = await authed(reader, 'GET', '/api/apps')
    expect(listResponse.status).toBe(200)
    const list = await listResponse.json() as {
      apps: Array<{ id: string, name: string, developer: string | null, platforms: Array<{ downloadUrl: string, isEnabled: boolean }> }>
      revision?: number
      platforms?: unknown
      nextAppId?: number
    }
    expect(list.revision).toBeUndefined()
    expect(list.platforms).toBeUndefined()
    expect(list.nextAppId).toBeUndefined()
    expect(list.apps.map((item) => item.id)).toEqual([earlier.id, visible.id])
    const visibleDto = list.apps[1]
    expect(visibleDto?.developer).toBeNull()
    expect(visibleDto?.platforms.map((item) => item.downloadUrl)).toEqual(['https://cdn.example.com/visible-ios.ipa'])
    expect(Object.keys(visibleDto ?? {}).sort()).toEqual([
      'category', 'createdAt', 'description', 'developer', 'flags', 'icon', 'id', 'name', 'officialWebsite', 'platforms', 'sortOrder', 'summary', 'updatedAt',
    ])
    expect(Object.keys(visibleDto?.platforms[0] ?? {}).sort()).toEqual([
      'appId', 'createdAt', 'downloadType', 'downloadUrl', 'fileSizeKb', 'id', 'importInstructions', 'importProtocol', 'importSupported', 'importUrlTemplate', 'isEnabled', 'officialDownloadUrl', 'officialStoreUrl', 'platform', 'updateNotes', 'updatedAt', 'version',
    ])
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain('内部应用')
    expect(serialized).not.toContain('停用应用')
    expect(serialized).not.toContain('secret-android.apk')
    expect(serialized).not.toContain('hidden.apk')
    expect(serialized).not.toContain('nextPlatformId')

    const detail = await authed(reader, 'GET', `/api/apps/${visible.id}`)
    expect(detail.status).toBe(200)
    const detailBody = await detail.json() as { app: { id: string, flags: Flags } }
    expect(detailBody.app.id).toBe(visible.id)
    expect(detailBody.app.flags.isEnabled).toBe(true)
    expect(detailBody.app.flags.isPublic).toBe(true)
    await expectError(await authed(reader, 'GET', `/api/apps/${hidden.id}`), 404, 'APP_NOT_FOUND')
    await expectError(await authed(reader, 'GET', `/api/apps/${disabled.id}`), 404, 'APP_NOT_FOUND')
    await expectError(await authed(reader, 'GET', '/api/apps/app_999'), 404, 'APP_NOT_FOUND')
  })
})
