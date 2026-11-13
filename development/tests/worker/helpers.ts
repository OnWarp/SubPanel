import { env, exports } from 'cloudflare:workers'
import { clearAppsStorage } from '../../../worker/apps/d1-repository'
import { clearCatalogStorage } from '../../../worker/catalog/d1-repository'
import { APPS_D1_READY_KEY, CATALOG_D1_READY_KEY, markModuleReady } from '../../../worker/db/module-switch'
import { applyMigrations } from './d1'

export const TEST_ORIGIN = 'https://subpanel.test'
export const ADMIN_USERNAME = 'admin'
export const ADMIN_PASSWORD = 'correct horse battery staple'

export async function enableD1Modules(): Promise<void> {
  await applyMigrations()
  await clearCatalogStorage(env.DB)
  await clearAppsStorage(env.DB)
  const now = '1970-01-01T00:00:00.000Z'
  await markModuleReady(env.DB, CATALOG_D1_READY_KEY, now)
  await markModuleReady(env.DB, APPS_D1_READY_KEY, now)
}

export async function resetData(): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await env.DATA.list({ cursor })
    await Promise.all(page.keys.map(({ name }) => env.DATA.delete(name)))
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

export const jsonRequest = (body: unknown, init: RequestInit = {}): RequestInit => ({
  ...init,
  method: init.method ?? 'POST',
  headers: {
    origin: TEST_ORIGIN,
    'content-type': 'application/json',
    ...init.headers,
  },
  body: JSON.stringify(body),
})

export async function setupAdmin(): Promise<void> {
  const response = await exports.default.fetch(
    `${TEST_ORIGIN}/api/setup`,
    jsonRequest({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  )
  if (response.status !== 201) throw new Error(`Setup failed with ${response.status}`)
}

export async function login(username = ADMIN_USERNAME, password = ADMIN_PASSWORD): Promise<string> {
  const response = await exports.default.fetch(
    `${TEST_ORIGIN}/api/login`,
    jsonRequest({ username, password }),
  )
  if (response.status !== 200) throw new Error(`Login failed with ${response.status}`)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Login did not return a session cookie')
  return cookie
}

export const withCookie = (cookie: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { cookie, ...init.headers },
})
