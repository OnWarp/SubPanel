type Flight = { controller: AbortController; consumers: number; invalidated: boolean; result: Promise<unknown> }

export const superseded = Symbol('invalidated request')

const entries = new Map<string, unknown>()
const flights = new Map<string, Flight>()

export function requestPath(path: string) {
  return new URL(path, 'https://subpanel.invalid').pathname.replace(/\/$/, '')
}

export function inFamily(path: string, family: string) {
  return path === family || path.startsWith(family + '/')
}

// Several display routes also perform maintenance writes. Their GETs must reach the server.
const excludedPaths = [
  '/api/bootstrap', '/api/account', '/api/account/profile', '/api/login', '/api/setup',
  '/api/admin/invites', '/api/admin/invitations',
  '/api/admin/subscriptions', '/api/admin/delivery', '/api/admin/delivery/subscriptions',
  '/api/account/subscriptions', '/api/account/delivery', '/api/account/delivery/subscriptions',
  '/api/subscriptions', '/api/user/subscriptions',
]

export function cacheable(path: string) {
  if (!path.startsWith('/api/')) return false
  const url = requestPath(path)
  return !excludedPaths.includes(url) && !['/api/register', '/api/password', '/api/invites', '/api/s']
    .some((family) => inFamily(url, family)) && !/^\/api\/shares\/[^/]+\/(meta|verify|export)$/.test(url)
}

export function cacheKey(path: string, init: RequestInit) {
  return JSON.stringify([path, Array.from(new Headers(init.headers).entries()).sort(), init.cache, init.mode, init.redirect,
    init.integrity, init.referrer, init.referrerPolicy, init.keepalive])
}

export function cachedValue<T>(key: string): T | undefined {
  return entries.get(key) as T | undefined
}

export function invalidateCache(families?: readonly string[]) {
  const matches = (key: string) => !families || families.some((family) => inFamily(requestPath(JSON.parse(key)[0]), family))
  for (const key of entries.keys()) if (matches(key)) entries.delete(key)
  // An invalidated request cannot publish or refill the cache.
  for (const [key, flight] of flights) {
    if (!matches(key)) continue
    flight.invalidated = true
    flights.delete(key)
  }
}

// Object property order is incidental in JSON; array order is part of the data.
function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]))
}

export function cachedRequest<T>(key: string, signal: AbortSignal | null | undefined, fetchData: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  let flight = flights.get(key)
  if (!flight) {
    const controller = new AbortController()
    const current: Flight = {
      controller,
      consumers: 0,
      invalidated: false,
      result: Promise.resolve().then(() => fetchData(controller.signal)).then((value) => {
        if (controller.signal.aborted) throw controller.signal.reason
        if (current.invalidated) throw superseded
        const previous = entries.get(key)
        if (sameData(previous, value)) return previous
        entries.set(key, value)
        return value
      }).finally(() => {
        if (flights.get(key) === current) flights.delete(key)
      }),
    }
    flights.set(key, current)
    flight = current
  }

  const current = flight
  current.consumers++
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      current.consumers--
    }
    const abort = () => {
      cleanup()
      if (current.consumers === 0) {
        if (flights.get(key) === current) flights.delete(key)
        current.controller.abort()
      }
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    current.result.then(
      (value) => { if (!signal?.aborted) { cleanup(); resolve(value as T) } },
      (error) => { if (!signal?.aborted) { cleanup(); reject(current.invalidated ? superseded : error) } },
    )
  })
}
