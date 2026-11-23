import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { windowStartFor } from '../../../worker/accounts/rate-limit'
import { limitAttempts } from '../../../worker/redemption/limits'
import { allowSubscriptionFetch } from '../../../worker/delivery/public-rate-limit'
import { readCatalogFromD1 } from '../../../worker/catalog/d1-repository'
import { fetchRemoteTextWithPolicy } from '../../../worker/catalog/egress-policy'
import { assertYamlBudget } from '../../../worker/platform/yaml-budget'
import { consumeVerifySlotD1 } from '../../../worker/shares/d1-repository'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

it('preserves node credentials through encrypted D1 writes after deployment rollback', async () => {
  const cookie = await login()
  const credential = crypto.randomUUID()
  const content = `ss://${btoa(`aes-128-gcm:${credential}`)}@fixture.example.test:8388#Fixture`
  env.CATALOG_ENCRYPT_AT_REST = 'true'
  try {
    const create = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog/sources',
      jsonRequest({ name: 'Fixture', type: 'manual', content }, withCookie(cookie)))
    expect(create.status).toBe(201)
  } finally {
    delete env.CATALOG_ENCRYPT_AT_REST
  }
  const verifyStorage = async () => {
    const node = await env.DB.prepare('SELECT credentials FROM nodes').first<{ credentials: string }>()
    const variant = await env.DB.prepare('SELECT raw FROM node_raw_variants').first<{ raw: string }>()
    expect(node?.credentials).toContain('subpanelEncrypted')
    expect(node?.credentials).not.toContain(credential)
    expect(variant?.raw).not.toContain(content)
    expect(JSON.stringify(await readCatalogFromD1(env.DB))).toContain(credential)
  }
  await verifyStorage()
  const updated = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog/sources/src_1',
    jsonRequest({ content }, withCookie(cookie, { method: 'PUT' })))
  expect(updated.status).toBe(200)
  await verifyStorage()
})

it('rejects over-budget JSON and YAML before schema validation or composition', async () => {
  const cookie = await login()
  const path = TEST_ORIGIN + '/api/admin/catalog/sources'
  const oversized = await exports.default.fetch(path, jsonRequest({ content: 'x'.repeat(2 * 1024 * 1024) }, withCookie(cookie)))
  expect(oversized.status).toBe(413)
  const deep = await exports.default.fetch(path, {
    ...jsonRequest(null, withCookie(cookie)),
    body: '['.repeat(65) + '0' + ']'.repeat(65),
  })
  expect(deep.status).toBe(413)
  expect(() => assertYamlBudget('['.repeat(65) + '0' + ']'.repeat(65))).toThrow('YAML nesting budget exceeded')
})

it('uses a stable authenticated redemption gate while leaving history available', async () => {
  const cookie = await login()
  const base = TEST_ORIGIN + '/api/me/redemptions'
  env.REDEMPTION_ROLLOUT_PERCENT = '0'
  try {
    const response = await exports.default.fetch(base + '/preview', jsonRequest({}, withCookie(cookie)))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'REDEMPTION_ROLLOUT_PENDING' } })
    expect((await exports.default.fetch(base, withCookie(cookie))).status).toBe(200)
  } finally {
    delete env.REDEMPTION_ROLLOUT_PERCENT
  }
})

it('atomically limits concurrent share password attempts', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () =>
    consumeVerifySlotD1(env.DB, 'local-fixture', Date.now())))
  expect(results.filter(Boolean)).toHaveLength(10)
})

it('fails closed before contacting a remote origin without a configured gateway', async () => {
  env.REQUIRE_WORKER_SECRETS = 'true'
  try {
    await expect(fetchRemoteTextWithPolicy({ url: 'https://fixture.example.test/feed', headers: {} }))
      .rejects.toMatchObject({ code: 'REMOTE_FETCH_FAILED' })
  } finally {
    delete env.REQUIRE_WORKER_SECRETS
  }
})


it('enforces global public and redemption windows under concurrent admission', async () => {
  const now = Math.floor(Date.now() / 1000)
  const start = windowStartFor(now, 60)
  const nextStart = start + 60
  await env.DB.batch([start, nextStart].map(window =>
    env.DB.prepare(`INSERT INTO rate_limits VALUES ('redemption_attempt', 'global', ?, 1190, ?)`)
      .bind(window, window + 60),
  ))
  const redemption = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    limitAttempts(env.DB, `fixture-${i}`, undefined, 0)))
  expect(redemption.filter(result => result.status === 'fulfilled')).toHaveLength(10)
  const publicFetch = await Promise.all(Array.from({ length: 100 }, () =>
    allowSubscriptionFetch(env.DB, 'global', 'all', 90)))
  expect(publicFetch.filter(Boolean)).toHaveLength(90)
})

it('keeps Cron and its error state available only to administrators', async () => {
  const path = TEST_ORIGIN + '/api/admin/operations/status'
  expect((await exports.default.fetch(path)).status).toBe(401)
  const cookie = await login()
  const result = await exports.default.fetch(path, withCookie(cookie))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ ok: true, cron: null })
})
