import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import {
  createDomain,
  deleteDomain,
  DomainError,
  getDomainRestrictionEnabled,
  getOrCreateInstanceId,
  getPrimaryDomainId,
  listDomains,
  listEnabledPlatforms,
  listPlatformSettings,
  putDomainRestrictionEnabled,
  setDomainEnabled,
  setPrimaryDomain,
  updateDomainNote,
  updatePlatformSettings,
  verifyDomain,
  type DomainKind,
  type DomainRecord,
} from './service.js'

function raise(error: unknown): never {
  if (error instanceof DomainError) throw error
  throw error
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    raise(error)
  }
}

function kindFromParam(c: Context<AppEnv>): DomainKind {
  const kind = c.req.param('kind')
  if (kind === 'panel' || kind === 'subscription') return kind
  throw apiError(404, 'DOMAIN_NOT_FOUND', '域名不存在')
}

function domainIdFromParam(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!/^dom_[A-Za-z0-9_-]+$/.test(id)) throw apiError(404, 'DOMAIN_NOT_FOUND', '域名不存在')
  return id
}

function toPublicDomain(record: DomainRecord) {
  return {
    id: record.id,
    hostname: record.hostname,
    enabled: record.enabled,
    verificationStatus: record.verificationStatus,
    verifiedAt: record.verifiedAt,
    lastCheckAt: record.lastCheckAt,
    lastCheckError: record.lastCheckError,
    note: record.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

const createDomainSchema = z.object({
  hostname: z.string().min(1).max(253),
  note: z.string().max(200).optional(),
}).strict()

const patchDomainSchema = z.object({
  note: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required')

const restrictionSchema = z.object({ enabled: z.boolean() }).strict()

const platformSettingsSchema = z.object({
  platforms: z.array(z.object({
    platform: z.string().min(1).max(64),
    enabled: z.boolean(),
  }).strict()).min(1).max(64),
}).strict()

export const adminDomainRoutes = new Hono<AppEnv>()

adminDomainRoutes.get('/system/domains', async (c) => {
  const [panel, subscription, primaryPanelDomainId, primarySubscriptionDomainId, restrictionEnabled] =
    await run(() => Promise.all([
      listDomains(c.env.DB, 'panel'),
      listDomains(c.env.DB, 'subscription'),
      getPrimaryDomainId(c.env.DB, 'panel'),
      getPrimaryDomainId(c.env.DB, 'subscription'),
      getDomainRestrictionEnabled(c.env.DB),
    ]))
  return c.json({
    panel: panel.map(toPublicDomain),
    subscription: subscription.map(toPublicDomain),
    primaryPanelDomainId,
    primarySubscriptionDomainId,
    restrictionEnabled,
  })
})

adminDomainRoutes.post('/system/domains/:kind', async (c) => {
  const kind = kindFromParam(c)
  const input = await readJson(c, createDomainSchema)
  const record = await run(() => createDomain(c.env.DB, kind, input))
  return c.json({ domain: toPublicDomain(record) }, 201)
})

adminDomainRoutes.patch('/system/domains/:kind/:id', async (c) => {
  const kind = kindFromParam(c)
  const id = domainIdFromParam(c)
  const input = await readJson(c, patchDomainSchema)
  const record = await run(async () => {
    let current: DomainRecord | undefined
    if (input.note !== undefined) current = await updateDomainNote(c.env.DB, kind, id, input.note)
    if (input.enabled !== undefined) current = await setDomainEnabled(c.env.DB, kind, id, input.enabled)
    if (!current) throw apiError(422, 'REQUEST_INVALID', '请求内容无效')
    return current
  })
  return c.json({ domain: toPublicDomain(record) })
})

adminDomainRoutes.delete('/system/domains/:kind/:id', async (c) => {
  const kind = kindFromParam(c)
  const id = domainIdFromParam(c)
  await run(() => deleteDomain(c.env.DB, kind, id))
  return c.body(null, 204)
})

adminDomainRoutes.post('/system/domains/:kind/:id/verify', async (c) => {
  const kind = kindFromParam(c)
  const id = domainIdFromParam(c)
  const record = await run(() => verifyDomain(c.env.DB, kind, id))
  return c.json({ domain: toPublicDomain(record) })
})

adminDomainRoutes.post('/system/domains/:kind/:id/primary', async (c) => {
  const kind = kindFromParam(c)
  const id = domainIdFromParam(c)
  const record = await run(() => setPrimaryDomain(c.env.DB, kind, id))
  return c.json({ domain: toPublicDomain(record) })
})

adminDomainRoutes.put('/system/domain-restriction', async (c) => {
  const input = await readJson(c, restrictionSchema)
  await run(() => putDomainRestrictionEnabled(c.env.DB, input.enabled))
  return c.json({ enabled: input.enabled })
})

adminDomainRoutes.get('/system/subscription-platforms', async (c) => {
  const platforms = await run(() => listPlatformSettings(c.env.DB))
  return c.json({ platforms })
})

adminDomainRoutes.put('/system/subscription-platforms', async (c) => {
  const input = await readJson(c, platformSettingsSchema)
  const platforms = await run(() => updatePlatformSettings(c.env.DB, input.platforms))
  return c.json({ platforms })
})

export const userDomainRoutes = new Hono<AppEnv>()

userDomainRoutes.get('/subscription-platforms', async (c) => {
  const platforms = await listEnabledPlatforms(c.env.DB)
  return c.json({
    platforms: platforms.map((entry) => ({ platform: entry.platform, displayName: entry.displayName })),
  })
})

export const publicSystemRoutes = new Hono<AppEnv>()

// Public deployment identity for domain verification (plan §7.3). Returns
// no user data; the value is also what the admin domain list works with.
publicSystemRoutes.get('/system/instance', async (c) => {
  const instanceId = await getOrCreateInstanceId(c.env.DB)
  return c.json({ instanceId })
})
