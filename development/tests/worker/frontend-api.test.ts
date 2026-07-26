import { describe, expect, it, vi } from 'vitest'
import { api, ApiClientError } from '../../../src/app/api'

describe('frontend API client', () => {
  it('rejects a successful response that is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } })))
    await expect(api('/api/test')).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_RESPONSE',
      status: 200,
    } satisfies Partial<ApiClientError>)
    vi.unstubAllGlobals()
  })

  it('normalizes network failures to ApiClientError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await expect(api('/api/test')).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NETWORK_ERROR',
      status: 0,
    } satisfies Partial<ApiClientError>)
    vi.unstubAllGlobals()
  })

  it('rejects a successful null JSON payload as an invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(api('/api/test')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 })
    vi.unstubAllGlobals()
  })
})
