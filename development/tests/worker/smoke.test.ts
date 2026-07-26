import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { resetData } from './helpers.js'
import staticHeaders from '../../public/_headers?raw'

beforeEach(resetData)

it('serves the stable health endpoint with initialization and Cron state', async () => {
  const response = await exports.default.fetch('https://subpanel.test/api/health')

  expect(response.status).toBe(200)
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await response.json()).toMatchObject({ ok: true, version: '0.1.0', initialized: false, cron: null })
})

it('fails closed when the stored Cron status is corrupt', async () => {
  await env.DATA.put('state:cron', '{bad')
  const response = await exports.default.fetch('https://subpanel.test/api/health')

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    ok: false,
    version: '0.1.0',
    error: { code: 'HEALTH_STATE_INVALID', message: '健康状态不可用' },
  })
})

it('ships static asset security rules', async () => {
  expect(staticHeaders).toContain('X-Content-Type-Options: nosniff')
  expect(staticHeaders).toContain("Content-Security-Policy: default-src 'self'")
})
