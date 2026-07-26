import type { Context, MiddlewareHandler } from 'hono'
import type { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from './api-error.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
} as const

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next()
  } finally {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.header(name, value)
    }
  }
}

export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next()
  } finally {
    c.header('Cache-Control', 'no-store')
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

export async function readJson<TSchema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw apiError(415, 'JSON_REQUIRED', '请求必须使用 JSON')
  }

  let value: unknown
  try {
    value = await c.req.json()
  } catch {
    throw apiError(400, 'INVALID_JSON', 'JSON 格式无效')
  }

  const result = schema.safeParse(value)
  if (!result.success) {
    throw apiError(422, 'VALIDATION_FAILED', '输入校验失败', result.error.flatten())
  }
  return result.data
}
