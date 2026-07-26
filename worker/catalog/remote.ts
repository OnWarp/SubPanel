export const MAX_REMOTE_BYTES = 5 * 1024 * 1024
export const REMOTE_TIMEOUT_MS = 15_000
export const MAX_REDIRECTS = 3

export type RemoteErrorCode =
  | 'REMOTE_URL_INVALID'
  | 'REMOTE_TARGET_BLOCKED'
  | 'REMOTE_HEADERS_INVALID'
  | 'REMOTE_REDIRECT_INVALID'
  | 'REMOTE_TOO_MANY_REDIRECTS'
  | 'REMOTE_HTTP_ERROR'
  | 'REMOTE_BODY_TOO_LARGE'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_BODY_INVALID'
  | 'REMOTE_FETCH_FAILED'

export class RemoteFetchError extends Error {
  readonly code: RemoteErrorCode

  constructor(code: RemoteErrorCode) {
    super(code)
    this.name = 'RemoteFetchError'
    this.code = code
  }
}

function fail(code: RemoteErrorCode): never {
  throw new RemoteFetchError(code)
}

function ipv4Words(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null
  const words = parts.map(Number)
  return words.every((part) => part <= 255) ? words : null
}

function isReservedIpv4(value: string): boolean {
  const words = ipv4Words(value)
  if (!words) return false
  const [first, second, third, fourth] = words
  if (first === 0 || first === 10 || first === 127 || first >= 224) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 0 && third === 0) return true
  if (first === 192 && second === 0 && third === 2) return true
  if (first === 192 && second === 88 && third === 99) return true
  if (first === 192 && second === 168) return true
  if (first === 198 && (second === 18 || second === 19)) return true
  if (first === 198 && second === 51 && third === 100) return true
  if (first === 203 && second === 0 && third === 113) return true
  return first === 255 && second === 255 && third === 255 && fourth === 255
}

function parseIpv6(value: string): number[] | null {
  let text = value.toLowerCase()
  if (text.includes('.')) {
    const separator = text.lastIndexOf(':')
    if (separator < 0) return null
    const embedded = ipv4Words(text.slice(separator + 1))
    if (!embedded) return null
    const high = (embedded[0] << 8) | embedded[1]
    const low = (embedded[2] << 8) | embedded[3]
    text = `${text.slice(0, separator)}${high.toString(16)}:${low.toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0
  if (missing < (halves.length === 2 ? 1 : 0) || left.length + right.length + missing !== 8) return null
  return [...left.map((part) => Number.parseInt(part, 16)), ...Array.from({ length: missing }, () => 0), ...right.map((part) => Number.parseInt(part, 16))]
}

function isReservedIpv6(value: string): boolean {
  const words = parseIpv6(value)
  if (!words) return false
  const allZero = words.every((word) => word === 0)
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
  if (allZero || loopback) return true
  if ((words[0] & 0xfe00) === 0xfc00) return true
  if ((words[0] & 0xffc0) === 0xfe80) return true
  if ((words[0] & 0xff00) === 0xff00) return true
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true

  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  if (mapped) {
    const ipv4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`
    return isReservedIpv4(ipv4)
  }
  return false
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, '').replace(/\.+$/u, '').toLowerCase()
}

export function validateRemoteUrl(value: string | URL): URL {
  let url: URL
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value)
  } catch {
    fail('REMOTE_URL_INVALID')
  }
  if (url.protocol !== 'https:' || url.username || url.password) fail('REMOTE_URL_INVALID')

  const host = normalizedHostname(url)
  if (!host) fail('REMOTE_URL_INVALID')
  if (host === 'localhost' || host === 'internal' || host === 'local' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    fail('REMOTE_TARGET_BLOCKED')
  }
  if (host.includes(':') ? isReservedIpv6(host) : isReservedIpv4(host)) fail('REMOTE_TARGET_BLOCKED')
  return url
}

const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const blockedHeader = /^(?:host|connection|content-length|transfer-encoding|cookie|set-cookie)$/iu

export function validateRemoteHeaders(input: Record<string, string>): Record<string, string> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('REMOTE_HEADERS_INVALID')
  const entries = Object.entries(input)
  if (entries.length > 20) fail('REMOTE_HEADERS_INVALID')
  const result: Record<string, string> = {}
  const names = new Set<string>()
  for (const [name, value] of entries) {
    const normalizedName = name.toLowerCase()
    if (!headerName.test(name) || blockedHeader.test(name) || normalizedName.startsWith('proxy-') || normalizedName.startsWith('cf-') || names.has(normalizedName)) {
      fail('REMOTE_HEADERS_INVALID')
    }
    if (typeof value !== 'string' || value.length > 1024 || value.includes('\u0000') || value.includes('\r') || value.includes('\n')) {
      fail('REMOTE_HEADERS_INVALID')
    }
    names.add(normalizedName)
    result[name] = value
  }
  return result
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // The stream is already closed or cleanup failed.
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  const chunks: string[] = []
  let total = 0
  let done = false
  try {
    while (true) {
      if (signal.aborted) fail('REMOTE_TIMEOUT')
      const result = await reader.read()
      if (result.done) {
        done = true
        break
      }
      total += result.value.byteLength
      if (total > MAX_REMOTE_BYTES) {
        await cancelReader(reader)
        done = true
        fail('REMOTE_BODY_TOO_LARGE')
      }
      chunks.push(decoder.decode(result.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch (error) {
    if (error instanceof RemoteFetchError) throw error
    if (signal.aborted || isAbortError(error)) fail('REMOTE_TIMEOUT')
    await cancelReader(reader)
    fail('REMOTE_BODY_INVALID')
  } finally {
    if (!done) await cancelReader(reader)
  }
  return ''
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response error remains more useful than a stream cleanup failure.
  }
}

export async function fetchRemoteText(
  encryptedSafeRequest: { url: string; headers: Record<string, string> },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let current = validateRemoteUrl(encryptedSafeRequest.url)
  let headers = validateRemoteHeaders(encryptedSafeRequest.headers)
  const signal = AbortSignal.timeout(REMOTE_TIMEOUT_MS)

  for (let redirects = 0; ; redirects += 1) {
    let response: Response
    try {
      response = await fetcher(current.href, { headers, redirect: 'manual', signal })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) fail('REMOTE_TIMEOUT')
      fail('REMOTE_FETCH_FAILED')
    }

    if (redirectStatuses.has(response.status)) {
      if (redirects >= MAX_REDIRECTS) fail('REMOTE_TOO_MANY_REDIRECTS')
      const location = response.headers.get('location')
      if (!location) fail('REMOTE_REDIRECT_INVALID')
      let target: URL
      try {
        target = new URL(location, current)
      } catch {
        fail('REMOTE_REDIRECT_INVALID')
      }
      const previousOrigin = current.origin
      current = validateRemoteUrl(target)
      if (current.origin !== previousOrigin) headers = {}
      await cancelBody(response)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      await cancelBody(response)
      fail('REMOTE_HTTP_ERROR')
    }
    return readBoundedBody(response, signal)
  }
}
