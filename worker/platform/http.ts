import type { Context, MiddlewareHandler } from 'hono'
import type { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { ApiError, apiError } from './api-error.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: https://www.gravatar.com https://api.dicebear.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*/api/system/instance https://*/.well-known/subpanel-verify",
} as const

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next()
  } finally {
    const referrer = new URL(c.req.url).pathname.startsWith('/sub/') ? 'no-referrer' : SECURITY_HEADERS['Referrer-Policy']
    if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000')
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.header(name, name === 'Referrer-Policy' ? referrer : value)
    }
  }
}

export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next()
  } finally {
    const existing = c.res.headers.get('Cache-Control')
    if (!existing?.split(',').some(directive => directive.trim().toLowerCase() === 'no-store')) {
      c.header('Cache-Control', 'no-store')
    }
  }
}

export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('Origin')
    if (!origin || origin !== new URL(c.req.url).origin) {
      throw apiError(403, 'ORIGIN_REQUIRED', '请求来源无效')
    }
  }
  await next()
}

function withinJsonDepth(text: string): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (!escaped && char === '"') inString = false
      escaped = !escaped && char === '\\'
    } else if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      if (++depth > 64) return false
    } else if (char === '}' || char === ']') {
      depth--
    }
  }
  return true
}

export async function readJson<TSchema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw apiError(415, 'JSON_REQUIRED', '请求必须使用 JSON')
  }

  const maxBytes = 2 * 1024 * 1024
  if (Number(c.req.header('Content-Length')) > maxBytes) {
    throw apiError(413, 'BODY_TOO_LARGE', '请求内容过大')
  }
  const reader = c.req.raw.body?.getReader()
  if (!reader) throw apiError(400, 'INVALID_JSON', 'JSON 格式无效')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let size = 0
  let body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw apiError(413, 'BODY_TOO_LARGE', '请求内容过大')
      }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw apiError(400, 'INVALID_JSON', 'JSON 格式无效')
  } finally {
    reader.releaseLock()
  }
  if (!withinJsonDepth(body)) throw apiError(413, 'BODY_TOO_COMPLEX', '请求结构过深')
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw apiError(400, 'INVALID_JSON', 'JSON 格式无效')
  }

  const result = schema.safeParse(value)
  if (!result.success) {
    throw apiError(422, 'VALIDATION_FAILED', '输入校验失败', result.error.flatten())
  }
  c.set('validatedBody', result.data)
  return result.data
}
