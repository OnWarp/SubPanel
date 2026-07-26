import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AppEnv } from '../../../worker/app-env'
import { ApiError, apiError } from '../../../worker/platform/api-error'
import { noStore, originGuard, readJson, securityHeaders } from '../../../worker/platform/http'

const testApp = new Hono<AppEnv>()
testApp.use('*', securityHeaders)
testApp.use('/api/*', noStore)
testApp.use('/api/*', originGuard)
testApp.post('/api/echo', async (c) => {
  const body = await readJson(c, z.object({ value: z.string().min(1) }))
  return c.json(body)
})
testApp.get('/api/fail', () => {
  throw apiError(409, 'CONFLICT', '冲突')
})
testApp.get('/api/internal-fail', () => {
  throw new Error('secret internal detail')
})
testApp.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    )
  }
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, 500)
})

describe('API boundary', () => {
  it('rejects a state-changing request without an exact Origin', async () => {
    const response = await testApp.request('https://subpanel.test/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'ok' }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: { code: 'ORIGIN_REQUIRED', message: '请求来源无效' },
    })
  })

  it('validates JSON and prevents API caching', async () => {
    const response = await testApp.request('https://subpanel.test/api/echo', {
      method: 'POST',
      headers: {
        origin: 'https://subpanel.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: '' }),
    })

    expect(response.status).toBe(422)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('permissions-policy')).toContain('camera=()')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe('VALIDATION_FAILED')
  })

  it('adds security headers and a fixed body to internal errors', async () => {
    const response = await testApp.request('https://subpanel.test/api/internal-fail')
    expect(response.status).toBe(500)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await response.text()).not.toContain('secret internal detail')
  })
})
