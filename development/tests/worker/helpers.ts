import { savePlan } from '../../../worker/delivery/plans'
import { hashPassword } from '../../../worker/accounts/password'
import { readAccounts, writeAccounts } from '../../../worker/accounts/repository'
import { env, exports } from 'cloudflare:workers'
import { clearAppsStorage } from '../../../worker/apps/d1-repository'
import { clearCatalogStorage } from '../../../worker/catalog/d1-repository'
import { clearDeliveryStorage } from '../../../worker/delivery/d1-repository'
import {
  APPS_D1_READY_KEY,
  CATALOG_D1_READY_KEY,
  DELIVERY_D1_READY_KEY,
  SHARES_D1_READY_KEY,
  markModuleReady,
} from '../../../worker/db/module-switch'
import { clearSharesStorage } from '../../../worker/shares/d1-repository'
import { clearTicketsStorage } from '../../../worker/tickets/repository'
import { clearKnowledgeBaseStorage } from '../../../worker/kb/repository'
import { applyMigrations } from './d1'

export const TEST_ORIGIN = 'https://subpanel.test'
export const ADMIN_USERNAME = 'admin'
export const ADMIN_PASSWORD = 'correct horse battery staple'

export async function enableD1Modules(): Promise<void> {
  await applyMigrations()
  await clearSharesStorage(env.DB)
  await clearDeliveryStorage(env.DB)
  await clearCatalogStorage(env.DB)
  await clearAppsStorage(env.DB)
  await clearTicketsStorage(env.DB)
  await clearKnowledgeBaseStorage(env.DB)
  const now = '1970-01-01T00:00:00.000Z'
  await markModuleReady(env.DB, CATALOG_D1_READY_KEY, now)
  await markModuleReady(env.DB, APPS_D1_READY_KEY, now)
  await markModuleReady(env.DB, DELIVERY_D1_READY_KEY, now)
  await markModuleReady(env.DB, SHARES_D1_READY_KEY, now)
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

// Delivery fixtures attach a plan to each subscription that can serve nodes.
export async function createDeliveryFixturePlan(groupIds: string[], now = new Date().toISOString()) {
  await applyMigrations()
  for (const groupId of groupIds) await env.DB.prepare('INSERT OR IGNORE INTO groups(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(groupId,groupId,now,now).run()
  return savePlan(env.DB,{ name: 'Delivery fixture',groupIds,durationDays: 3650 })
}

// Non-registration suites need an account fixture in either KV or D1 mode.
// Registration behavior itself is covered through HTTP in d1-registration.
export async function createFixtureAccount(username: string, password: string): Promise<Response> {
  const accounts = await readAccounts(env)
  const now = new Date().toISOString()
  const user = { id: `usr_${accounts.nextUserId}`, username, role: 'user' as const,
    enabled: true, password: await hashPassword(password), sessionVersion: 0,
    deletedAt: null, createdAt: now, updatedAt: now }
  await writeAccounts(env, { ...accounts, users: [...accounts.users, user], nextUserId: accounts.nextUserId + 1 }, now)
  return Response.json({ user }, { status: 201 })
}
