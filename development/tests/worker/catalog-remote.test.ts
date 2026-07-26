import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_REDIRECTS,
  MAX_REMOTE_BYTES,
  REMOTE_TIMEOUT_MS,
  fetchRemoteText,
  validateRemoteHeaders,
  validateRemoteUrl,
} from '../../../worker/catalog/remote'

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => vi.restoreAllMocks())

describe('bounded remote catalog sources', () => {
  it('accepts public HTTPS URLs and rejects every other scheme', () => {
    expect(validateRemoteUrl('https://example.com/subscription').href).toBe('https://example.com/subscription')
    for (const value of [
      'http://example.com',
      'ftp://example.com',
      'https://user:password@example.com',
      'not a url',
    ]) {
      expect(() => validateRemoteUrl(value)).toThrow('REMOTE_URL_INVALID')
    }
  })

  it('rejects localhost, internal suffixes, and reserved IPv4/IPv6 literals', () => {
    for (const host of [
      'localhost',
      'service.internal',
      'printer.local',
      '127.0.0.1',
      '10.0.0.1',
      '169.254.1.1',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '[::1]',
      '[fc00::1]',
      '[fe80::1]',
      '[2001:db8::1]',
      '[::ffff:127.0.0.1]',
    ]) {
      expect(() => validateRemoteUrl(`https://${host}/subscription`)).toThrow('REMOTE_TARGET_BLOCKED')
    }
  })

  it('revalidates relative and absolute redirects and stops after three', async () => {
    const calls: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input)
      calls.push(url)
      if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: '/next' } })
      if (url.endsWith('/next')) return new Response(null, { status: 307, headers: { location: 'https://example.net/final' } })
      return new Response('ok')
    }
    await expect(fetchRemoteText({ url: 'https://example.com/start', headers: {} }, fetcher)).resolves.toBe('ok')
    expect(calls).toEqual(['https://example.com/start', 'https://example.com/next', 'https://example.net/final'])

    const blocked: typeof fetch = async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } })
    await expect(fetchRemoteText({ url: 'https://example.com/start', headers: {} }, blocked)).rejects.toThrow('REMOTE_TARGET_BLOCKED')

    let redirects = 0
    const looping: typeof fetch = async () => {
      redirects += 1
      return new Response(null, { status: 302, headers: { location: `/redirect-${redirects}` } })
    }
    await expect(fetchRemoteText({ url: 'https://example.com/start', headers: {} }, looping)).rejects.toThrow('REMOTE_TOO_MANY_REDIRECTS')
    expect(redirects).toBe(MAX_REDIRECTS + 1)
  })

  it('does not forward custom headers across an origin-changing redirect', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const fetcher: typeof fetch = async (input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const url = requestUrl(input)
      seen.push({ url, headers })
      if (url === 'https://example.com/start') return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/final' } })
      return new Response('ok')
    }
    await expect(fetchRemoteText({ url: 'https://example.com/start', headers: { Authorization: 'secret', 'X-Source-Key': 'key' } }, fetcher)).resolves.toBe('ok')
    expect(seen[0].headers).toMatchObject({ authorization: 'secret', 'x-source-key': 'key' })
    expect(seen[1].headers).toEqual({})
  })

  it('rejects non-success responses and unsafe custom headers', async () => {
    const failed: typeof fetch = async () => new Response(null, { status: 503 })
    await expect(fetchRemoteText({ url: 'https://example.com/source', headers: {} }, failed)).rejects.toThrow('REMOTE_HTTP_ERROR')

    for (const headers of [
      { Host: 'example.com' },
      { Cookie: 'session=value' },
      { 'CF-Connecting-IP': '203.0.113.1' },
      { 'Proxy-Authorization': 'secret' },
      { Authorization: 'one', authorization: 'two' },
      { 'bad header': 'value' },
      { 'X-Test': 'x'.repeat(1025) },
    ]) {
      expect(() => validateRemoteHeaders(headers)).toThrow('REMOTE_HEADERS_INVALID')
    }
  })

  it('preserves the remote error when response body cancellation fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error('cancel failed')
      },
    })
    const fetcher: typeof fetch = async () => new Response(body, { status: 503 })
    await expect(fetchRemoteText({ url: 'https://example.com/source', headers: {} }, fetcher))
      .rejects.toThrow('REMOTE_HTTP_ERROR')
  })

  it('streams no more than 5 MiB and cancels the reader', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REMOTE_BYTES + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetcher: typeof fetch = async () => new Response(body)
    await expect(fetchRemoteText({ url: 'https://example.com/source', headers: {} }, fetcher)).rejects.toThrow('REMOTE_BODY_TOO_LARGE')
    expect(cancelled).toBe(true)
  })

  it('preserves the body size error when reader cancellation fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REMOTE_BYTES + 1))
      },
      cancel() {
        throw new Error('cancel failed')
      },
    })
    const fetcher: typeof fetch = async () => new Response(body)
    await expect(fetchRemoteText({ url: 'https://example.com/source', headers: {} }, fetcher))
      .rejects.toThrow('REMOTE_BODY_TOO_LARGE')
  })

  it('aborts after the configured timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    const fetcher: typeof fetch = async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true)
      throw new DOMException('aborted', 'AbortError')
    }
    await expect(fetchRemoteText({ url: 'https://example.com/source', headers: {} }, fetcher)).rejects.toThrow('REMOTE_TIMEOUT')
    expect(timeout).toHaveBeenCalledWith(REMOTE_TIMEOUT_MS)
  })

  it('never includes URL or header values in thrown messages', async () => {
    const url = 'https://example.com/private?token=url-secret'
    const headers = { Authorization: 'header-secret' }
    const fetcher: typeof fetch = async () => new Response(null, { status: 500 })
    try {
      await fetchRemoteText({ url, headers }, fetcher)
      throw new Error('Expected remote fetch to fail')
    } catch (error) {
      expect((error as Error).message).not.toContain(url)
      expect((error as Error).message).not.toContain('url-secret')
      expect((error as Error).message).not.toContain('header-secret')
    }
  })
})
