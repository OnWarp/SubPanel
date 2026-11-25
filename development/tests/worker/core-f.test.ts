import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { windowStartFor } from '../../../worker/accounts/rate-limit'
import { hashToken } from '../../../worker/platform/crypto'
import { jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

beforeEach(setupContractedAdmin)

it('limits a scraping address before looking up a unified subscription', async () => {
  const address = '192.0.2.42'
  const bucket = 'unified_subscription_address'
  const subject = await hashToken(`${bucket}:${address}`)
  const window = windowStartFor(Math.floor(Date.now() / 1000), 60)
  await env.DB.batch([window, window + 60].map(start =>
    env.DB.prepare('INSERT INTO rate_limits VALUES (?, ?, ?, ?, ?)').bind(bucket, subject, start, 240, start + 60)))
  const response = await exports.default.fetch(TEST_ORIGIN + '/s/' + 'A'.repeat(43), {
    headers: { 'CF-Connecting-IP': address },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(await response.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_RATE_LIMITED' } })
})

it('lists historical compile jobs and retires their execution and retry', async () => {
  const root = TEST_ORIGIN + '/api/admin/compile-jobs'
  const now = new Date().toISOString()
  await env.DB.prepare(`INSERT INTO compile_jobs (id,actor_user_id,platform,status,total,created_at,updated_at)
    VALUES ('legacy-job','usr_1','mihomo','failed',0,?,?)`).bind(now, now).run()
  expect((await exports.default.fetch(root)).status).toBe(401)
  const auth = withCookie(await login())
  expect(await (await exports.default.fetch(root, auth)).json()).toMatchObject({ jobs: [{ id: 'legacy-job', status: 'failed' }] })
  for (const action of ['run', 'retry']) {
    const response = await exports.default.fetch(root + '/legacy-job/' + action, jsonRequest({}, auth))
    expect(response.status).toBe(action === 'run' ? 409 : 410)
    expect(await response.json()).toMatchObject({ error: { code: action === 'run' ? 'COMPILE_JOB_UNAVAILABLE' : 'COMPILE_JOB_RETIRED' } })
  }
})
