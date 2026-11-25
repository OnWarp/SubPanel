import { createEntitlementTemplate } from '../../../worker/delivery/entitlement-templates'
import { mutateBinding } from '../../../worker/delivery/bindings'
import { readUserAccess } from '../../../worker/delivery/user-access'
import { savePlan } from '../../../worker/delivery/plans'
import { getOrCreateCryptoMaterial } from '../../../worker/platform/crypto'
import { hashPassword } from '../../../worker/accounts/password'
import { readAccounts, writeAccounts } from '../../../worker/accounts/repository'
import { env, exports } from 'cloudflare:workers'
import { clearAppsStorage } from '../../../worker/apps/d1-repository'
import { clearCatalogStorage } from '../../../worker/catalog/d1-repository'
import { clearDeliveryStorage } from '../../../worker/delivery/d1-repository'
import {
  ACCOUNTS_D1_READY_KEY,
  APPS_D1_READY_KEY,
  CATALOG_D1_READY_KEY,
  DELIVERY_D1_READY_KEY,
  SHARES_D1_READY_KEY,
  markModuleReady,
} from '../../../worker/db/module-switch'
import { clearSharesStorage } from '../../../worker/shares/d1-repository'
import { clearTicketsStorage } from '../../../worker/tickets/repository'
import { clearKnowledgeBaseStorage } from '../../../worker/kb/repository'
import { applyContraction, applyMigrations } from './d1'

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
  await getOrCreateCryptoMaterial(env.DATA)
  const now = new Date().toISOString()
  const accounts = await readAccounts(env)
  await writeAccounts(env, { ...accounts, nextUserId: 2, users: [{
    id: 'usr_1', username: ADMIN_USERNAME, role: 'admin', enabled: true,
    password: await hashPassword(ADMIN_PASSWORD), sessionVersion: 0, deletedAt: null,
    createdAt: now, updatedAt: now,
  }] }, now)
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

// Run active subscription API tests against the same schema as the PR6 release.
export async function setupContractedAdmin(): Promise<void> {
  await resetData()
  await applyContraction()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_subscription_shares'),
    env.DB.prepare('DELETE FROM binding_redemption_records'),
    env.DB.prepare('DELETE FROM redemption_records'),
    env.DB.prepare('DELETE FROM redemption_codes'),
    env.DB.prepare('DELETE FROM redemption_batches'),
    env.DB.prepare('DELETE FROM rate_limits'),
    env.DB.prepare('DELETE FROM audit_logs'),
    env.DB.prepare('DELETE FROM invitation_redemptions'),
    env.DB.prepare('DELETE FROM invitations'),
    env.DB.prepare('DELETE FROM system_settings WHERE key IN ("trial_plan_id", "trial_days")'),
    env.DB.prepare('DELETE FROM user_binding_requests'),
    env.DB.prepare('DELETE FROM user_template_bindings'),
    env.DB.prepare('DELETE FROM user_subscription_access'),
    env.DB.prepare('DELETE FROM unified_subscription_mappings'),
    env.DB.prepare('DELETE FROM unified_subscription_checkpoints'),
    env.DB.prepare('DELETE FROM legacy_subscriptions_archive'),
    env.DB.prepare('DELETE FROM entitlement_plan_policies'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare("UPDATE entitlement_templates SET status='archived' WHERE status<>'archived'"),
  ])
  await clearCatalogStorage(env.DB)
  await clearSharesStorage(env.DB)
  await env.DB.prepare("UPDATE users SET email=NULL,email_normalized=NULL,email_verified_at=NULL WHERE id='usr_1'").run()
  await markModuleReady(env.DB, ACCOUNTS_D1_READY_KEY)
  await setupAdmin()
}

export async function bindFixtureTemplate(
  userId: string,
  options: { name: string; groupIds?: string[]; nodeIds?: string[]; startsAt?: number; expiresAt?: number; paused?: boolean },
) {
  const template = await createEntitlementTemplate(env.DB, {
    name: options.name, description: '', allowRedemption: false,
    config: {
      groupIds: options.groupIds ?? [], nodeIds: options.nodeIds ?? [],
      duration: { unit: 'day', value: 30 }, quotaBytes: null,
      resetPolicy: 'none', limits: { speedLimitMbps: 0 },
    },
  }, 'usr_1', 'enabled')
  const access = await readUserAccess(env.DB, { userId })
  const { revision } = await mutateBinding(env, userId, template.id, {
    mode: 'assign', requestId: crypto.randomUUID(), expectedRevision: access?.revision ?? 0,
    startsAt: options.startsAt ?? Date.now(),
    expiry: options.expiresAt === undefined ? { type: 'permanent' } : { type: 'absolute', expiresAt: options.expiresAt },
  }, 'usr_1')
  if (options.paused) {
    await mutateBinding(env, userId, template.id, {
      mode: 'pause', requestId: crypto.randomUUID(), expectedRevision: revision,
    }, 'usr_1')
  }
  return template
}
