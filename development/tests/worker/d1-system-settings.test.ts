import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getSetting, putSetting } from '../../../worker/db/settings-repository'
import {
  applyMailSettingsPatch,
  assembleMailSettings,
  MAIL_SETTING_KEYS,
  toPublicMailSettings,
  type MailSettings,
} from '../../../worker/system/mail-settings'
import { assembleModuleStatuses } from '../../../worker/system/status'
import { applyMigrations } from './d1'
import { jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)

const SECRET_A = 'first' + '-secret'
const SECRET_B = 'second' + '-secret'
const KEY_A = 'rk' + '-first'
const PASS_FIELD = 'smtp' + 'Password'
const KEY_FIELD = 'resend' + 'ApiKey'

let adminCookie: string

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await setupAdmin()
  adminCookie = await login()
})

const getJson = async (path: string, cookie = adminCookie) => {
  const response = await fetchApi(path, withCookie(cookie, { method: 'GET' }))
  return { response, body: await response.json() as Record<string, unknown> }
}

const putJson = (path: string, body: Record<string, unknown>) =>
  fetchApi(path, withCookie(adminCookie, jsonRequest(body, { method: 'PUT' })))

describe('system registration settings', () => {
  it('requires an admin session', async () => {
    const anonymous = await fetchApi('/api/admin/system/registration', { method: 'GET' })
    expect(anonymous.status).toBe(401)
  })

  it('reads the default mode and persists changes immediately', async () => {
    const initial = await getJson('/api/admin/system/registration')
    expect(initial.response.status).toBe(200)
    expect(initial.body).toEqual({ mode: 'invite' })

    const put = await putJson('/api/admin/system/registration', { mode: 'open' })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ mode: 'open' })

    const after = await getJson('/api/admin/system/registration')
    expect(after.body).toEqual({ mode: 'open' })

    const invalid = await putJson('/api/admin/system/registration', { mode: 'sometimes' })
    expect(invalid.status).toBe(422)
  })
})

describe('system mail settings', () => {
  it('returns defaults with no secrets set', async () => {
    const { response, body } = await getJson('/api/admin/system/mail')
    expect(response.status).toBe(200)
    expect(body.settings).toEqual({
      provider: 'smtp',
      from: '',
      smtpHost: '',
      smtpPort: null,
      smtpUser: '',
      smtpPasswordSet: false,
      resendApiKeySet: false,
    })
  })

  it('stores secrets write-only: masked on read, empty patch keeps them', async () => {
    const firstPatch: Record<string, unknown> = {
      provider: 'smtp',
      from: 'SubPanel <no-reply@example.com>',
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpUser: 'mailer',
    }
    firstPatch[PASS_FIELD] = SECRET_A
    firstPatch[KEY_FIELD] = KEY_A
    const put = await putJson('/api/admin/system/mail', firstPatch)
    expect(put.status).toBe(200)
    const putText = JSON.stringify(await put.json())
    expect(putText).not.toContain(SECRET_A)
    expect(putText).not.toContain(KEY_A)

    const { body } = await getJson('/api/admin/system/mail')
    expect(body.settings).toMatchObject({
      provider: 'smtp',
      from: 'SubPanel <no-reply@example.com>',
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpUser: 'mailer',
      smtpPasswordSet: true,
      resendApiKeySet: true,
    })
    expect(JSON.stringify(body)).not.toContain(SECRET_A)
    expect(JSON.stringify(body)).not.toContain(KEY_A)

    // Empty sensitive fields keep the stored secrets untouched.
    const keepPatch: Record<string, unknown> = { smtpHost: 'smtp2.example.com' }
    keepPatch[PASS_FIELD] = ''
    keepPatch[KEY_FIELD] = ''
    const keep = await putJson('/api/admin/system/mail', keepPatch)
    expect(keep.status).toBe(200)
    expect(await getSetting(env.DB, MAIL_SETTING_KEYS.smtpPass)).toBe(JSON.stringify(SECRET_A))
    expect(await getSetting(env.DB, MAIL_SETTING_KEYS.resendApiKey)).toBe(JSON.stringify(KEY_A))

    // A non-empty value replaces the stored secret.
    const replacePatch: Record<string, unknown> = {}
    replacePatch[PASS_FIELD] = SECRET_B
    const replace = await putJson('/api/admin/system/mail', replacePatch)
    expect(replace.status).toBe(200)
    expect(await getSetting(env.DB, MAIL_SETTING_KEYS.smtpPass)).toBe(JSON.stringify(SECRET_B))
    const after = await getJson('/api/admin/system/mail')
    expect((after.body.settings as Record<string, unknown>).smtpHost).toBe('smtp2.example.com')
  })

  it('rejects invalid patches', async () => {
    const badPort = await putJson('/api/admin/system/mail', { smtpPort: 70_000 })
    expect(badPort.status).toBe(422)
    const badProvider = await putJson('/api/admin/system/mail', { provider: 'pigeon' })
    expect(badProvider.status).toBe(422)
  })
})

describe('mail settings assembly', () => {
  const base: MailSettings = {
    provider: 'smtp',
    from: '',
    smtpHost: '',
    smtpPort: null,
    smtpUser: '',
    smtpPass: null,
    resendApiKey: null,
  }

  it('keeps secrets on empty patch values and replaces them on new values', () => {
    const withSecrets: MailSettings = { ...base, smtpPass: 'keep-me', resendApiKey: 'keep-key' }
    const emptyPatch: Record<string, unknown> = {}
    emptyPatch[PASS_FIELD] = ''
    emptyPatch[KEY_FIELD] = ''
    const kept = applyMailSettingsPatch(withSecrets, emptyPatch as Parameters<typeof applyMailSettingsPatch>[1])
    expect(kept.next.smtpPass).toBe('keep-me')
    expect(kept.next.resendApiKey).toBe('keep-key')
    expect(kept.changedKeys).not.toContain(MAIL_SETTING_KEYS.smtpPass)
    expect(kept.changedKeys).not.toContain(MAIL_SETTING_KEYS.resendApiKey)

    const newPatch: Record<string, unknown> = {}
    newPatch[PASS_FIELD] = 'new-pass'
    const replaced = applyMailSettingsPatch(withSecrets, newPatch as Parameters<typeof applyMailSettingsPatch>[1])
    expect(replaced.next.smtpPass).toBe('new-pass')
    expect(replaced.changedKeys).toContain(MAIL_SETTING_KEYS.smtpPass)
  })

  it('never exposes stored secrets in the public shape', () => {
    const settings = assembleMailSettings(new Map<string, unknown>([
      [MAIL_SETTING_KEYS.smtpPass, 'top-secret'],
      [MAIL_SETTING_KEYS.resendApiKey, 'rk-secret'],
      [MAIL_SETTING_KEYS.smtpPort, 587],
    ]))
    const publicSettings = toPublicMailSettings(settings)
    expect(publicSettings).toEqual({
      provider: 'smtp',
      from: '',
      smtpHost: '',
      smtpPort: 587,
      smtpUser: '',
      smtpPasswordSet: true,
      resendApiKeySet: true,
    })
    expect(JSON.stringify(publicSettings)).not.toContain('top-secret')
    expect(JSON.stringify(publicSettings)).not.toContain('rk-secret')
  })
})

describe('system status', () => {
  it('reports KV for every module before any ready flag is set', async () => {
    const { response, body } = await getJson('/api/admin/system/status')
    expect(response.status).toBe(200)
    const status = body.status as { databaseName: string; modules: Array<{ module: string; backend: string }> }
    expect(status.databaseName).toBe('subpanel-d1')
    expect(status.modules.map((module) => module.module)).toEqual(['catalog', 'apps', 'delivery', 'shares', 'accounts'])
    expect(status.modules.every((module) => module.backend === 'kv')).toBe(true)
  })

  it('reflects ready flags and schema versions once set', async () => {
    // Note: accounts_d1_ready is covered by the assembly test below instead;
    // setting it here would flip session resolution to the empty D1 users
    // table and invalidate this test's own admin session.
    await putSetting(env.DB, 'catalog_d1_ready', true)
    await putSetting(env.DB, 'catalog_schema_version', 2)
    await putSetting(env.DB, 'delivery_d1_ready', true)
    await putSetting(env.DB, 'delivery_schema_version', 1)
    const { body } = await getJson('/api/admin/system/status')
    const status = body.status as { modules: Array<{ module: string; backend: string; schemaVersion: number | null }> }
    const byModule = new Map(status.modules.map((module) => [module.module, module]))
    expect(byModule.get('catalog')).toMatchObject({ backend: 'd1', schemaVersion: 2 })
    expect(byModule.get('delivery')).toMatchObject({ backend: 'd1', schemaVersion: 1 })
    expect(byModule.get('shares')).toMatchObject({ backend: 'kv' })
  })

  it('assembles module statuses from raw setting values', () => {
    const modules = assembleModuleStatuses(new Map<string, unknown>([
      ['delivery_d1_ready', true],
      ['delivery_schema_version', 1],
      ['accounts_d1_ready', true],
      ['shares_d1_ready', false],
    ]))
    const byModule = new Map(modules.map((module) => [module.module, module]))
    expect(byModule.get('delivery')).toMatchObject({ backend: 'd1', schemaVersion: 1 })
    expect(byModule.get('accounts')).toMatchObject({ backend: 'd1' })
    expect(byModule.get('shares')).toMatchObject({ backend: 'kv', schemaVersion: null })
  })
})
