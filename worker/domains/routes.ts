import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { ApiError, apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { logAudit } from '../admin/audit.js'
import {
  DomainService,
  getDomainRestrictionEnabled,
  putDomainRestrictionEnabled,
  type DomainBinding,
  type DomainKind,
} from './domain-service.js'
import { listEnabledPlatforms, listPlatformSettings, updatePlatformSettings } from './service.js'
import { DOMAIN_VERIFY_PATH } from './verification-contract.js'
import { allowDomainProbe, createDomainProof, getOrCreateInstanceId, issueDomainChallenge, verifyDomain } from './verification.js'

function kindFromParam(c: Context<AppEnv>): DomainKind {
  const kind = c.req.param('kind')
  if (kind === 'panel' || kind === 'subscription') return kind
  throw apiError(404, 'NOT_FOUND', '域名不存在')
}

function domainIdFromParam(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!/^dom_[A-Za-z0-9_-]+$/.test(id)) throw apiError(404, 'NOT_FOUND', '域名不存在')
  return id
}

const createDomainSchema = z.object({
  hostname: z.unknown(),
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

function auditDomain(c: Context<AppEnv>, action: string, before: DomainBinding | null, after: DomainBinding | null,
  detail: Record<string, unknown> = {}) {
  const domain = after ?? before!
  return logAudit(c.env.DB, c.get('principal').id, `domain.${action}`, 'domain_binding', domain.id, {
    purpose: domain.purpose, hostname: domain.hostname, before, after, ...detail,
  })
}

adminDomainRoutes.get('/system/domains', async (c) => {
  const purpose = c.req.query('purpose')
  const service = new DomainService(c.env.DB)
  if (purpose !== undefined) {
    if (purpose !== 'panel' && purpose !== 'subscription') throw apiError(400, 'REQUEST_INVALID', '域名用途无效')
    return c.json({ domains: await service.list(purpose) })
  }
  const [panel, subscription, restrictionEnabled] = await Promise.all([
    service.list('panel'), service.list('subscription'), getDomainRestrictionEnabled(c.env.DB),
  ])
  return c.json({
    panel,
    subscription,
    primaryPanelDomainId: panel.find(domain => domain.isPrimary)?.id ?? null,
    primarySubscriptionDomainId: subscription.find(domain => domain.isPrimary)?.id ?? null,
    restrictionEnabled,
  })
})

adminDomainRoutes.post('/system/domains/:kind', async (c) => {
  const purpose = kindFromParam(c)
  const input = await readJson(c, createDomainSchema)
  if (typeof input.hostname !== 'string') throw apiError(400, 'INVALID_HOSTNAME', '域名格式无效')
  const domain = await new DomainService(c.env.DB).create(purpose, { ...input, hostname: input.hostname })
  await auditDomain(c, 'create', null, domain)
  return c.json({ domain }, 201)
})

adminDomainRoutes.patch('/system/domains/:kind/:id', async (c) => {
  const purpose = kindFromParam(c)
  const id = domainIdFromParam(c)
  const input = await readJson(c, patchDomainSchema)
  const service = new DomainService(c.env.DB)
  const before = await service.get(purpose, id)
  const result = await service.update(purpose, id, input)
  await auditDomain(c, 'update', before, result.domain, { autoPrimary: result.autoPrimary })
  return c.json(result)
})

adminDomainRoutes.delete('/system/domains/:kind/:id', async (c) => {
  const purpose = kindFromParam(c)
  const id = domainIdFromParam(c)
  const service = new DomainService(c.env.DB)
  const before = await service.get(purpose, id)
  await service.delete(purpose, id)
  await auditDomain(c, 'delete', before, null)
  return c.body(null, 204)
})

adminDomainRoutes.post('/system/domains/:kind/:id/challenge', async (c) => {
  const purpose = kindFromParam(c)
  const id = domainIdFromParam(c)
  const domain = await new DomainService(c.env.DB).get(purpose, id)
  const challenge = await issueDomainChallenge(c.env.DB, purpose, id)
  await auditDomain(c, 'challenge', domain, domain, { expiresAt: challenge.expiresAt, challengeId: challenge.challengeId })
  return c.json({ challenge }, 200, { 'Cache-Control': 'no-store' })
})

const challengeIdSchema = z.uuid()
const proofSchema = z.object({
  version: z.literal(1),
  hostname: z.string().min(1).max(253),
  challengeId: challengeIdSchema,
  expiresAt: z.iso.datetime(),
  instanceId: z.string().min(1).max(128),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict()
const verifySchema = z.union([
  z.object({ proof: proofSchema }).strict(),
  z.object({ challengeId: challengeIdSchema, reason: z.literal('PROBE_FAILED') }).strict(),
])
const malformedProofSchema = z.object({
  proof: z.object({ challengeId: challengeIdSchema }),
})

adminDomainRoutes.post('/system/domains/:kind/:id/verify', async (c) => {
  const purpose = kindFromParam(c)
  const id = domainIdFromParam(c)
  const before = await new DomainService(c.env.DB).get(purpose, id)
  const raw = await readJson(c, z.unknown()).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === 'INVALID_JSON') return null
    throw error
  })
  const parsed = verifySchema.safeParse(raw)
  const malformed = malformedProofSchema.safeParse(raw)
  const input = parsed.success ? parsed.data : { challengeId: malformed.data?.proof.challengeId }
  const { domain, failure } = await verifyDomain(c.env, purpose, id, input)
  await auditDomain(c, 'verify', before, domain)
  if (failure) throw apiError(422, 'VERIFY_FAILED', '域名验证失败', { reason: failure })
  return c.json({ domain })
})

adminDomainRoutes.post('/system/domains/:kind/:id/primary', async (c) => {
  const purpose = kindFromParam(c)
  const id = domainIdFromParam(c)
  const service = new DomainService(c.env.DB)
  const [before, previousPrimary] = await Promise.all([service.get(purpose, id), service.getPrimary(purpose)])
  const domain = await service.setPrimary(purpose, id)
  await auditDomain(c, 'primary', before, domain, { previousPrimary })
  return c.json({ domain, refreshList: true })
})

adminDomainRoutes.put('/system/domain-restriction', async (c) => {
  const { enabled } = await readJson(c, restrictionSchema)
  const before = await getDomainRestrictionEnabled(c.env.DB)
  await putDomainRestrictionEnabled(c.env.DB, enabled)
  await logAudit(c.env.DB, c.get('principal').id, 'domain.restriction', 'domain_restriction', null, {
    before: { enabled: before }, after: { enabled },
  })
  return c.json({ enabled })
})

adminDomainRoutes.get('/system/subscription-platforms', async (c) => {
  const platforms = await listPlatformSettings(c.env.DB)
  return c.json({ platforms })
})

adminDomainRoutes.put('/system/subscription-platforms', async (c) => {
  const input = await readJson(c, platformSettingsSchema)
  const platforms = await updatePlatformSettings(c.env.DB, input.platforms)
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
  return c.json({ instanceId }, 200, { 'Access-Control-Allow-Origin': '*' })
})

export const domainProbeRoutes = new Hono<AppEnv>()

domainProbeRoutes.get(DOMAIN_VERIFY_PATH, async (c) => {
  c.header('Cache-Control', 'no-store')
  const { hostname, search } = new URL(c.req.url)
  const nonce = /^\?challenge=([A-Za-z0-9_-]{43})$/u.exec(search)?.[1]
  if (!nonce || c.req.raw.body || c.req.header('Transfer-Encoding') || Number(c.req.header('Content-Length')) > 0) {
    return c.notFound()
  }
  const address = c.req.header('CF-Connecting-IP') ?? 'no-edge-address'
  if (!await allowDomainProbe(c.env.DB, address)) return c.notFound()
  const proof = await createDomainProof(c.env, hostname, nonce).catch(() => null)
  if (!proof) return c.notFound()
  return c.json(proof, 200, { 'Access-Control-Allow-Origin': '*' })
})
