import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const ORIGIN = 'https://subpanel.test'
const browserHeaders = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

type ErrorBody = { error: { code: string; message: string } }

describe('SPA fallback', () => {
  it('serves the app shell for a browser navigation to a deep link', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/login`, {
      headers: browserHeaders,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('spa-shell-test-fixture')
  })

  it('serves the app shell for a HEAD request to a deep link', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/kb`, {
      method: 'HEAD',
      headers: browserHeaders,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('keeps the JSON 404 for unknown API routes even for browsers', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/api/no-such-route`, {
      headers: browserHeaders,
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: '请求的资源不存在' },
    })
  })

  it('keeps the JSON 404 for non-HTML clients on page paths', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/login`, {
      headers: { accept: 'application/json' },
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as ErrorBody).error.code).toBe('NOT_FOUND')
  })

  it('keeps the JSON 404 for non-GET requests on page paths', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { ...browserHeaders, origin: ORIGIN },
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as ErrorBody).error.code).toBe('NOT_FOUND')
  })
})
