import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { resetData } from './helpers.js'
import staticHeaders from '../../../public/_headers?raw'

beforeEach(resetData)

it('serves the liveness endpoint with security headers', async () => {
  const response = await exports.default.fetch('https://subpanel.test/api/health')

  expect(response.status).toBe(200)
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await response.json()).toMatchObject({ ok: true })
})

it('keeps Cron state private when it is corrupt', async () => {
  await env.DATA.put('state:cron', '{bad')
  const response = await exports.default.fetch('https://subpanel.test/api/health')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000')
})

it('ships static asset security rules', async () => {
  expect(staticHeaders).toContain('X-Content-Type-Options: nosniff')
  expect(staticHeaders).toContain("Content-Security-Policy: default-src 'self'")
})
