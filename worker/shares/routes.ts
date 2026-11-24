import { getSubscription, DeliveryError } from '../delivery/service.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { resolveSessionUser, requireAuth } from '../accounts/auth.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { primaryDomainOriginSafe } from '../domains/service.js'
import { readShareSettings } from './repository.js'
import {
  adminShareQuerySchema,
  createShareSchema,
  shareSettingsSchema,
  shareIdSchema,
  updateShareSchema,
  verifyShareSchema,
} from './schema.js'
import {
  adminChangeStatus,
  changeOwnStatus,
  createShare,
  revokeAllShares,
  exportShare,
  listAdminShares,
  listOwnShares,
  readShareMeta,
  removeShare,
  resetShareToken,
  revealOriginalLink,
  ShareError,
  updateSettings,
  updateShare,
  verifyShare,
} from './service.js'
import { issueShareSession, readShareSessionHash } from './session.js'

// Token shape is checked in the handler. A short or malformed token must stay on this public path so it returns 404 instead of 401.
const PUBLIC_SHARE_PATH = /^\/api\/shares\/[^/]+\/(meta|verify|export)$/u
const emptySchema = z.object({}).default({})

function isPublicShareRequest(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname
  if (!PUBLIC_SHARE_PATH.test(path)) return false
  if (path.endsWith('/verify')) return c.req.method === 'POST'
  return c.req.method === 'GET'
}

function raise(error: unknown): never {
  if (error instanceof ShareError) throw apiError(error.status, error.code, error.message)
  throw error
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    raise(error)
  }
}

function requireShareToken(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw apiError(404, 'SHARE_NOT_FOUND', '分享不存在')
  return value
}

function requireShareId(value: string | undefined): string {
  if (!value || !shareIdSchema.safeParse(value).success) throw apiError(404, 'SHARE_NOT_FOUND', '分享不存在')
  return value
}

function contentDisposition(fileName: string, downloadName: string): string {
  const fallback = fileName.replaceAll('"', '')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
}

function queryValue(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  return value
}

export const shareRoutes = new Hono<AppEnv>()

shareRoutes.use('*', async (c, next) => {
  if (isPublicShareRequest(c)) {
    await next()
    return
  }
  await requireAuth(c, next)
})

shareRoutes.get('/', async (c) => {
  const shares = await run(() => listOwnShares(c.env, c.get('principal').id))
  return c.json({ shares })
})

shareRoutes.post('/', async (c) => {
  const input = await readJson(c, createShareSchema)
  const actor = c.get('principal')
  const result = await run(() => createShare(c.env, actor.id, input, undefined, actor.role))
  const linkBaseUrl = await primaryDomainOriginSafe(c.env.DB, 'subscription')
  return c.json({ ...result, linkBaseUrl }, 201)
})

shareRoutes.post('/revoke-all', async c => {
  await readJson(c, emptySchema)
  await run(() => revokeAllShares(c.env, c.get('principal').id))
  return c.body(null, 204)
})

shareRoutes.put('/:id', async (c) => {
  const input = await readJson(c, updateShareSchema)
  const actor = c.get('principal')
  const share = await run(() => updateShare(c.env, requireShareId(c.req.param('id')), actor.id, input, undefined, actor.role))
  return c.json({ share })
})

shareRoutes.post('/:id/disable', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => changeOwnStatus(c.env, requireShareId(c.req.param('id')), c.get('principal').id, 'disabled'))
  return c.json({ share })
})

shareRoutes.post('/:id/enable', async (c) => {
  await readJson(c, emptySchema)
  const actor = c.get('principal')
  const share = await run(() => changeOwnStatus(c.env, requireShareId(c.req.param('id')), actor.id, 'active', undefined, actor.role))
  return c.json({ share })
})

shareRoutes.post('/:id/revoke', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => changeOwnStatus(c.env, requireShareId(c.req.param('id')), c.get('principal').id, 'revoked'))
  return c.json({ share })
})

shareRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const actor = c.get('principal')
  const result = await run(() => resetShareToken(c.env, requireShareId(c.req.param('id')), actor.id, undefined, actor.role))
  const linkBaseUrl = await primaryDomainOriginSafe(c.env.DB, 'subscription')
  return c.json({ ...result, linkBaseUrl })
})

shareRoutes.post('/:id/reveal', async (c) => {
  await readJson(c, emptySchema)
  const actor = c.get('principal')
  const result = await run(() => revealOriginalLink(c.env, requireShareId(c.req.param('id')), actor.id, c.req.url, undefined, actor.role))
  return c.json(result)
})

shareRoutes.delete('/:id', async (c) => {
  await run(() => removeShare(c.env, requireShareId(c.req.param('id')), c.get('principal').id))
  return c.body(null, 204)
})

shareRoutes.get('/:token/meta', async (c) => {
  const token = requireShareToken(c.req.param('token'))
  const [actor, sessionHash] = await Promise.all([resolveSessionUser(c), readShareSessionHash(c)])
  const meta = await run(() => readShareMeta(c.env, token, actor, sessionHash))
  const linkBaseUrl = await primaryDomainOriginSafe(c.env.DB, 'subscription')
  return c.json({ meta, linkBaseUrl })
})

shareRoutes.post('/:token/verify', async (c) => {
  const token = requireShareToken(c.req.param('token'))
  const input = await readJson(c, verifyShareSchema)
  const actor = await resolveSessionUser(c)
  const result = await run(() => verifyShare(c.env, token, input.password, actor))
  const expiresAt = await issueShareSession(c, result.tokenHash)
  return c.json({ verified: true, expiresAt })
})

shareRoutes.get('/:token/export', async (c) => {
  const token = requireShareToken(c.req.param('token'))
  const [actor, sessionHash] = await Promise.all([resolveSessionUser(c), readShareSessionHash(c)])
  const result = await run(() => exportShare(
    c.env,
    token,
    c.req.query('type'),
    c.req.query('client'),
    actor,
    sessionHash,
    c.req.url,
  ))
  if (result.kind === 'link') return c.json({ link: result.link })
  c.header('ETag', result.etag)
  c.header('Content-Type', result.contentType)
  c.header('Content-Disposition', contentDisposition(result.fileName, result.downloadName))
  if (result.profileTitle) c.header('profile-title', encodeURIComponent(result.profileTitle))
  return c.body(result.body)
})

export const adminShareRoutes = new Hono<AppEnv>()

adminShareRoutes.post('/shares', async (c) => {
  const input = await readJson(c, createShareSchema)
  if (!input.subscriptionId) throw apiError(422, 'SHARE_SCOPE_REQUIRED', '请选择订阅')
  const subscription = await getSubscription(c.env, input.subscriptionId).catch(error => {
    if (error instanceof DeliveryError) throw apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
    throw error
  })
  const ownerUserId = subscription.userId
  if (!ownerUserId) throw apiError(409, 'SUBSCRIPTION_UNASSIGNED', '请先分配订阅')
  const result = await run(() => createShare(c.env, ownerUserId, input, undefined, c.get('principal').role))
  const linkBaseUrl = await primaryDomainOriginSafe(c.env.DB, 'subscription')
  return c.json({ ...result, linkBaseUrl }, 201)
})

adminShareRoutes.get('/shares', async (c) => {
  const parsed = adminShareQuerySchema.safeParse({
    user: queryValue(c.req.query('user')),
    subscription: queryValue(c.req.query('subscription')),
    status: queryValue(c.req.query('status')),
  })
  if (!parsed.success) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败', parsed.error.flatten())
  const shares = await run(() => listAdminShares(c.env, parsed.data))
  return c.json({ shares })
})

adminShareRoutes.post('/shares/:id/disable', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => adminChangeStatus(c.env, requireShareId(c.req.param('id')), 'disabled', undefined, c.get('principal').id))
  return c.json({ share })
})

adminShareRoutes.post('/shares/:id/revoke', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => adminChangeStatus(c.env, requireShareId(c.req.param('id')), 'revoked', undefined, c.get('principal').id))
  return c.json({ share })
})

adminShareRoutes.get('/share-settings', async (c) => {
  const settings = await run(() => readShareSettings(c.env))
  return c.json({ settings })
})

adminShareRoutes.put('/share-settings', async (c) => {
  const input = await readJson(c, shareSettingsSchema)
  const settings = await run(() => updateSettings(c.env, input))
  return c.json({ settings })
})
