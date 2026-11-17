import { describe, expect, it, vi } from 'vitest'
import { api, ApiClientError, loadAdminUserOptions } from '../../../src/app/api'

describe('frontend API client', () => {
  it('loads selector users across every server page', async () => {
    const fetcher = vi.fn(async (path: string) => {
      const page = Number(new URL(path,'https://panel.test').searchParams.get('page'))
      const users = Array.from({ length: page < 3 ? 100 : 5 },(_,i) => ({ id: `usr_${(page-1)*100+i}` }))
      return Response.json({ users, total: 205 })
    })
    vi.stubGlobal('fetch',fetcher)
    try {
      const result = await loadAdminUserOptions()
      expect(result.users).toHaveLength(205)
      expect(result.users.at(-1)?.id).toBe('usr_204')
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally { vi.unstubAllGlobals() }
  })

  it('fails incomplete selector pages instead of silently truncating or looping', async () => {
    vi.stubGlobal('fetch',vi.fn(async () => Response.json({ users: [], total: 101 })))
    try { await expect(loadAdminUserOptions()).rejects.toThrow('用户列表不完整') }
    finally { vi.unstubAllGlobals() }
  })
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
