import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, peekApi, readData, watchApi } from '../../../src/app/api'
import { invalidateCache } from '../../../src/app/data-cache'

const path = '/api/admin/catalog'
const json = (revision: number) => Response.json({ revision })

beforeEach(() => invalidateCache())
afterEach(() => vi.unstubAllGlobals())

describe('frontend response cache', () => {
  it('publishes a hit immediately, then delivers changed data to the same consumer', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(json(1)).mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    await api(path)
    const render = vi.fn()
    const refresh = watchApi(path, render)
    expect(render.mock.calls).toEqual([[{ revision: 1 }]])
    pending.resolve(json(2))
    await refresh
    expect(render.mock.calls).toEqual([[{ revision: 1 }], [{ revision: 2 }]])
    fetcher.mockResolvedValueOnce(json(2))
    render.mockClear()
    await watchApi(path, render)
    expect(render).toHaveBeenCalledExactlyOnceWith({ revision: 2 })
  })

  it('deduplicates simultaneous GETs while keeping query variants separate', async () => {
    const fetcher = vi.fn(async () => json(1))
    vi.stubGlobal('fetch', fetcher)
    const results = await Promise.all([api(path), api(path), api(path + '?page=2')])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(results[0]).toBe(results[1])
  })

  it('invalidates every variant after a successful related write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(1)))
    const related = [path, path + '?v=2', '/api/admin/users?page=2', '/api/user/nodes']
    const unrelated = '/api/kb'
    await Promise.all([...related, unrelated].map((url) => api(url)))
    await api(path + '/sources/source_1', { method: 'PUT' })
    for (const url of related) expect(peekApi(url)).toBeUndefined()
    expect(peekApi(unrelated)).toEqual({ revision: 1 })
  })

  it('clears cached data on login, logout and a bootstrap identity change', async () => {
    const user = (id: string) => Response.json({ initialized: true, user: { id, role: 'admin' } })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(user('user-a')).mockResolvedValueOnce(json(1))
      .mockResolvedValueOnce(user('user-b')).mockResolvedValueOnce(json(2))
      .mockResolvedValueOnce(json(0)).mockResolvedValueOnce(json(3))
      .mockResolvedValueOnce(user('user-c'))
    vi.stubGlobal('fetch', fetcher)
    await api('/api/login', { method: 'POST' })
    await api(path)
    await api('/api/bootstrap')
    expect(peekApi(path)).toBeUndefined()
    await api(path)
    await api('/api/account/logout', { method: 'POST' })
    expect(peekApi(path)).toBeUndefined()
    await api(path)
    await api('/api/login', { method: 'POST' })
    expect(peekApi(path)).toBeUndefined()
  })

  it.each([
    '/api/bootstrap', '/api/account', '/api/account/profile', '/api/login', '/api/setup',
    '/api/register/config', '/api/register/send-code', '/api/password/forgot', '/api/password/reset',
    '/api/invites/token', '/api/admin/invites', '/api/admin/invitations',
    '/api/admin/subscriptions?page=2', '/api/admin/delivery', '/api/admin/delivery/subscriptions',
    '/api/account/subscriptions', '/api/account/delivery', '/api/account/delivery/subscriptions',
    '/api/subscriptions', '/api/user/subscriptions',
    '/api/shares/token/meta', '/api/shares/token/verify', '/api/shares/token/export?type=link',
    '/api/s/token', '/s/token', '/sub/token', '/sub/token/mihomo',
  ])('bypasses the cache for %s', async (url) => {
    const fetcher = vi.fn(async () => json(1))
    vi.stubGlobal('fetch', fetcher)
    await Promise.all([api(url), api(url)])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(peekApi(url)).toBeUndefined()
  })

  it('keeps a cached view on refresh failure and propagates failures for cold reads', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(1)).mockImplementation(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    await api(path)
    const render = vi.fn()
    await watchApi(path, render)
    expect(render).toHaveBeenCalledExactlyOnceWith({ revision: 1 })
    await expect(watchApi('/api/admin/stats', render)).rejects.toMatchObject({ status: 503 })
    expect(peekApi('/api/admin/stats')).toBeUndefined()
    await expect(api(path, { method: 'PUT' })).rejects.toMatchObject({ status: 503 })
    expect(peekApi(path)).toEqual({ revision: 1 })
  })

  it('aborts each consumer independently and caches results for surviving consumers', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn(() => pending.promise)
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const aborted = api(path, { signal: controller.signal })
    const retained = api(path)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(fetcher.mock.calls).toHaveLength(1)
    pending.resolve(json(1))
    await expect(retained).resolves.toEqual({ revision: 1 })
    expect(peekApi(path)).toEqual({ revision: 1 })
  })

  it('does not cache a response arriving after its last consumer aborts', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn((_url: string, _init: RequestInit) => pending.promise)
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const aborted = api(path, { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
    pending.resolve(json(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peekApi(path)).toBeUndefined()
  })

  it('discards a pre-write response and joins a post-write read instead', async () => {
    const old = Promise.withResolvers<Response>()
    const fetcher = vi.fn()
      .mockReturnValueOnce(old.promise).mockResolvedValueOnce(json(0)).mockResolvedValueOnce(json(2))
    vi.stubGlobal('fetch', fetcher)
    const first = api(path)
    await Promise.resolve()
    await api(path + '/sources', { method: 'POST' })
    old.resolve(json(1))
    await expect(first).resolves.toEqual({ revision: 2 })
    expect(peekApi(path)).toEqual({ revision: 2 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not expose a request sent before logout to the next session', async () => {
    const old = Promise.withResolvers<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(json(0))
    vi.stubGlobal('fetch', fetcher)
    const first = api(path)
    await Promise.resolve()
    await api('/api/account/logout', { method: 'POST' })
    old.resolve(json(1))
    await expect(first).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(peekApi(path)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps object identity for unchanged JSON with different property order', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ a: 1, b: [2, 3] }))
      .mockResolvedValueOnce(Response.json({ b: [2, 3], a: 1 }))
      .mockResolvedValueOnce(Response.json({ a: 1, b: [3, 2] })))
    const original = await api(path)
    expect(await api(path)).toBe(original)
    expect(await api(path)).not.toBe(original)
  })

  it('publishes an aggregate from cache and refreshes when one input changes', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(1)).mockResolvedValueOnce(json(2))
      .mockResolvedValueOnce(json(1)).mockResolvedValueOnce(json(3))
    vi.stubGlobal('fetch', fetcher)
    const stats = '/api/admin/stats'
    await Promise.all([api(path), api(stats)])
    const render = vi.fn()
    await readData((read) => Promise.all([read(path), read(stats)]), render)
    expect(render.mock.calls).toEqual([[[{ revision: 1 }, { revision: 2 }]], [[{ revision: 1 }, { revision: 3 }]]])
  })
})
