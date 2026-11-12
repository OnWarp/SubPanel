import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { resolveSessionUser, requireAuth } from '../accounts/auth.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { readShareSettings } from './repository.js'
import {
  adminShareQuerySchema,
  createShareSchema,
  shareSettingsSchema,
  updateShareSchema,
  verifyShareSchema,
} from './schema.js'
import {
  adminChangeStatus,
  changeOwnStatus,
  createShare,
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
const shareIdPattern = /^shr_[1-9]\d*$/u

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
  if (!value || !shareIdPattern.test(value)) throw apiError(404, 'SHARE_NOT_FOUND', '分享不存在')
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
  const shares = await run(() => listOwnShares(c.env.DATA, c.get('principal').id))
  return c.json({ shares })
})

shareRoutes.post('/', async (c) => {
  const input = await readJson(c, createShareSchema)
  const result = await run(() => createShare(c.env.DATA, c.get('principal').id, input))
  return c.json(result, 201)
})

shareRoutes.put('/:id', async (c) => {
  const input = await readJson(c, updateShareSchema)
  const share = await run(() => updateShare(c.env.DATA, requireShareId(c.req.param('id')), c.get('principal').id, input))
  return c.json({ share })
})

shareRoutes.post('/:id/disable', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => changeOwnStatus(c.env.DATA, requireShareId(c.req.param('id')), c.get('principal').id, 'disabled'))
  return c.json({ share })
})

shareRoutes.post('/:id/enable', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => changeOwnStatus(c.env.DATA, requireShareId(c.req.param('id')), c.get('principal').id, 'active'))
  return c.json({ share })
})

shareRoutes.post('/:id/revoke', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => changeOwnStatus(c.env.DATA, requireShareId(c.req.param('id')), c.get('principal').id, 'revoked'))
  return c.json({ share })
})

shareRoutes.post('/:id/reset-token', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => resetShareToken(c.env.DATA, requireShareId(c.req.param('id')), c.get('principal').id))
  return c.json(result)
})

shareRoutes.post('/:id/reveal', async (c) => {
  await readJson(c, emptySchema)
  const result = await run(() => revealOriginalLink(c.env.DATA, requireShareId(c.req.param('id')), c.get('principal').id, c.req.url))
  return c.json(result)
})

shareRoutes.delete('/:id', async (c) => {
  await run(() => removeShare(c.env.DATA, requireShareId(c.req.param('id')), c.get('principal').id))
  return c.body(null, 204)
})

shareRoutes.get('/:token/meta', async (c) => {
  const token = requireShareToken(c.req.param('token'))
  const [actor, sessionHash] = await Promise.all([resolveSessionUser(c), readShareSessionHash(c)])
  const meta = await run(() => readShareMeta(c.env.DATA, token, actor, sessionHash))
  return c.json({ meta })
})

shareRoutes.post('/:token/verify', async (c) => {
  const token = requireShareToken(c.req.param('token'))
  const input = await readJson(c, verifyShareSchema)
  const actor = await resolveSessionUser(c)
  const result = await run(() => verifyShare(c.env.DATA, token, input.password, actor))
  const expiresAt = await issueShareSession(c, result.tokenHash)
  return c.json({ verified: true, expiresAt })
})

shareRoutes.get('/:token/export', async (c) => {
  const token = requireShareToken(c.req.param('token'))
  const [actor, sessionHash] = await Promise.all([resolveSessionUser(c), readShareSessionHash(c)])
  const result = await run(() => exportShare(
    c.env.DATA,
    token,
    c.req.query('type'),
    c.req.query('client'),
    actor,
    sessionHash,
    c.req.url,
  ))
  if (result.kind === 'link') return c.json({ link: result.link })
  c.header('ETag', result.etag)
  c.header('Last-Modified', new Date(result.lastModified).toUTCString())
  c.header('Content-Type', result.contentType)
  c.header('Content-Disposition', contentDisposition(result.fileName, result.downloadName))
  if (result.profileTitle) c.header('profile-title', encodeURIComponent(result.profileTitle))
  return c.body(result.body)
})

export const adminShareRoutes = new Hono<AppEnv>()

adminShareRoutes.get('/shares', async (c) => {
  const parsed = adminShareQuerySchema.safeParse({
    user: queryValue(c.req.query('user')),
    subscription: queryValue(c.req.query('subscription')),
    status: queryValue(c.req.query('status')),
  })
  if (!parsed.success) throw apiError(422, 'VALIDATION_FAILED', '输入校验失败', parsed.error.flatten())
  const shares = await run(() => listAdminShares(c.env.DATA, parsed.data))
  return c.json({ shares })
})

adminShareRoutes.post('/shares/:id/disable', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => adminChangeStatus(c.env.DATA, requireShareId(c.req.param('id')), 'disabled'))
  return c.json({ share })
})

adminShareRoutes.post('/shares/:id/revoke', async (c) => {
  await readJson(c, emptySchema)
  const share = await run(() => adminChangeStatus(c.env.DATA, requireShareId(c.req.param('id')), 'revoked'))
  return c.json({ share })
})

adminShareRoutes.get('/share-settings', async (c) => {
  const settings = await run(() => readShareSettings(c.env.DATA))
  return c.json({ settings })
})

adminShareRoutes.put('/share-settings', async (c) => {
  const input = await readJson(c, shareSettingsSchema)
  const settings = await run(() => updateSettings(c.env.DATA, input))
  return c.json({ settings })
})
