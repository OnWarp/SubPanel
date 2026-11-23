import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import worker from '../../../worker/index'
import { windowStartFor } from '../../../worker/accounts/rate-limit'
import { hashToken } from '../../../worker/platform/crypto'
import { readDeliverySubscription } from '../../../worker/delivery/d1-repository'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const root = '/api/admin/compile-jobs'
const catalog = '/api/admin/catalog'
let admin: string

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
  admin = await login()
})

const adminGet = (path: string) => exports.default.fetch(TEST_ORIGIN + path, withCookie(admin))
const adminPost = (path: string, body: unknown = {}, method = 'POST') =>
  exports.default.fetch(TEST_ORIGIN + path, jsonRequest(body, withCookie(admin, { method })))
const ss = (label: string) => `ss://${btoa(`aes-128-gcm:${crypto.randomUUID()}`)}@${label}.example.test:8388#${label}`

async function createFixture(label: string) {
  const { source } = await (await adminPost(catalog + '/sources', { name: label, type: 'manual', content: ss(label) }))
    .json<{ source: { id: string } }>()
  const { group } = await (await adminPost(catalog + '/groups', { name: label, sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [] }))
    .json<{ group: { id: string } }>()
  const { plan } = await (await adminPost('/api/admin/plans', { name: label, groupIds: [group.id], durationDays: 30 }))
    .json<{ plan: { id: string } }>()
  return { source, group, plan }
}

async function createSubscription(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const response = await adminPost('/api/admin/subscriptions', {
    name: 'CORE-08 fixture', planId: fixture.plan.id, groupIds: [fixture.group.id],
  })
  expect(response.status).toBe(201)
  return response.json<{ token: string; subscription: { id: string } }>()
}

async function pull(token: string, platform: string, etag?: string) {
  const ctx = createExecutionContext()
  const response = await worker.fetch(new Request(`${TEST_ORIGIN}/sub/${token}/${platform}`, {
    headers: etag ? { 'If-None-Match': etag } : undefined,
  }), env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

const status = async (id: string, platform: string) =>
  (await (await adminGet(`${root}/artifacts/${id}/${platform}`)).json<{ status: string }>()).status

it('invalidates only the source dependents, the published platform, and the changed plan', async () => {
  const east = await createFixture('east')
  const west = await createFixture('west')
  const affected = await createSubscription(east)
  const independent = await createSubscription(west)
  const affectedId = affected.subscription.id
  const independentId = independent.subscription.id

  const mihomo = await pull(affected.token, 'mihomo')
  const oldEtag = mihomo.headers.get('etag')!
  expect(mihomo.status).toBe(200)
  expect((await pull(affected.token, 'generic')).status).toBe(200)
  expect((await pull(independent.token, 'mihomo')).status).toBe(200)

  const changed = await adminPost(`${catalog}/sources/${east.source.id}`, { content: ss('eastnew') }, 'PUT')
  expect(changed.status).toBe(200)
  expect(await status(affectedId, 'mihomo')).toBe('needsCompilation')
  expect(await status(affectedId, 'generic')).toBe('needsCompilation')
  expect(await status(independentId, 'mihomo')).toBe('current')
  const audit = await env.DB.prepare("SELECT detail FROM audit_logs WHERE action='compile.invalidate.catalog' ORDER BY created_at DESC LIMIT 1")
    .first<{ detail: string }>()
  expect(JSON.parse(audit!.detail)).toMatchObject({ groupIds: [east.group.id], candidateSubscriptions: 1 })
  const refreshed = await pull(affected.token, 'mihomo', oldEtag)
  expect(refreshed.status).toBe(200)
  expect(await refreshed.text()).toContain('eastnew')
  expect((await pull(affected.token, 'generic')).status).toBe(200)

  const policy = `proxy-groups:
  - name: Policy
    type: select
    proxies: ["$SUBPANEL_NODES", DIRECT]
rules:
  - MATCH,Policy
`
  const configuration = '/api/admin/system/subscription-templates'
  const { id, draftHash } = await (await adminPost(configuration, {
    name: 'Fixture policy', yaml: policy,
  })).json<{ id: string; draftHash: string }>()
  const published = await adminPost(`${configuration}/${id}/publish`, { expectedRevision: 1, draftHash })
  expect(published.status, await published.clone().text()).toBe(200)
  const bound = await adminPost(`${configuration}/bindings/${affectedId}`, { mode: 'specific', templateId: id, expectedRevision: 1 }, 'PUT')
  expect(bound.status).toBe(200)
  expect((await pull(affected.token, 'mihomo')).status).toBe(200)
  const changedDraft = await adminPost(`${configuration}/${id}`, {
    name: 'Fixture policy', yaml: policy.replace('  - MATCH,Policy', '  - DOMAIN,example.test,DIRECT\n  - MATCH,Policy'), expectedRevision: 2,
  }, 'PUT')
  expect(changedDraft.status).toBe(200)
  const next = await changedDraft.json<{ draftHash: string }>()
  expect((await adminPost(`${configuration}/${id}/publish`, { expectedRevision: 3, draftHash: next.draftHash })).status).toBe(200)
  expect(await status(affectedId, 'mihomo')).toBe('needsCompilation')
  expect(await status(affectedId, 'generic')).toBe('current')
  expect(await status(independentId, 'mihomo')).toBe('current')

  const disabled = await adminPost(`/api/admin/plans/${east.plan.id}`, {
    name: 'Disabled', groupIds: [east.group.id], durationDays: 30, enabled: false,
  }, 'PUT')
  expect(disabled.status).toBe(200)
  expect(await status(affectedId, 'mihomo')).toBe('blocked')
  expect(await status(independentId, 'mihomo')).toBe('current')
  expect((await pull(affected.token, 'mihomo', oldEtag)).status).toBe(404)
})

it('uses bounded pages, reports a failed item, retries, and cancels with audit records', async () => {
  const fixture = await createFixture('job')
  const first = await createSubscription(fixture)
  const row = await readDeliverySubscription(env.DB, { id: first.subscription.id })
  expect(row).toBeTruthy()
  for (let i = 2; i <= 6; i++) await createSubscription(fixture)
  const input = { platform: 'mihomo', groupId: fixture.group.id }
  expect((await exports.default.fetch(TEST_ORIGIN + root)).status).toBe(401)
  const created = await adminPost(root, input)
  expect(created.status).toBe(201)
  const { job } = await created.json<{ job: { id: string } }>()
  const path = `${root}/${job.id}`

  const originalPut = env.DATA.put.bind(env.DATA)
  const put = vi.spyOn(env.DATA, 'put').mockImplementation((key, value, options) => {
    if (key.startsWith(`compiled:${row!.tokenHash}:`)) return Promise.reject(new Error('fixture cache failure'))
    return originalPut(key, value, options)
  })
  try {
    const ctx = createExecutionContext()
    const page = await worker.fetch(new Request(TEST_ORIGIN + path + '/run', jsonRequest({}, withCookie(admin))), env, ctx)
    await waitOnExecutionContext(ctx)
    expect(await page.json()).toMatchObject({ job: { status: 'running', total: 6, compiled: 3, failures: 1 } })
    const finalPage = await adminPost(path + '/run')
    expect(await finalPage.json()).toMatchObject({ job: {
      status: 'failed', compiled: 5, failures: 1, lastFailureId: first.subscription.id, errorCode: 'COMPILE_ITEM_FAILED',
    } })
  } finally {
    put.mockRestore()
  }
  expect((await adminPost(path + '/run')).status).toBe(409)

  const retry = await (await adminPost(path + '/retry')).json<{ job: { id: string } }>()
  const retryPath = `${root}/${retry.job.id}`
  await adminPost(retryPath + '/run')
  expect(await (await adminPost(retryPath + '/run')).json()).toMatchObject({
    job: { status: 'completed', compiled: 1, cacheHits: 5, total: 6 },
  })
  const cancelled = await (await adminPost(root, input)).json<{ job: { id: string } }>()
  const cancelPath = `${root}/${cancelled.job.id}`
  expect(await (await adminPost(cancelPath + '/cancel')).json()).toMatchObject({ job: { status: 'cancelled' } })
  expect((await adminPost(cancelPath + '/run')).status).toBe(409)
  const events = (await env.DB.prepare("SELECT action FROM audit_logs WHERE action LIKE 'compile_job.%'").all<{ action: string }>()).results
  expect(events.map(event => event.action)).toEqual(expect.arrayContaining(['compile_job.failed', 'compile_job.completed', 'compile_job.cancelled']))
})

it('rate limits a scraping source before using any subscription artifact', async () => {
  const address = '192.0.2.42'
  const bucket = 'subscription_address'
  const subject = await hashToken(`${bucket}:${address}`)
  const window = windowStartFor(Math.floor(Date.now() / 1000), 60)
  await env.DB.prepare('INSERT INTO rate_limits VALUES (?, ?, ?, ?, ?)').bind(bucket, subject, window, 240, window + 60).run()
  const response = await exports.default.fetch(TEST_ORIGIN + '/sub/' + 'A'.repeat(43), {
    headers: { 'CF-Connecting-IP': address },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(await response.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_RATE_LIMITED' } })
})

it.skipIf(import.meta.env.VITE_CORE_F_BENCH !== '1')('measures scoped invalidation and warming against full compilation', async () => {
  const { CLIENT_IDS } = await import('../../../worker/renderers/index')
  const { renderResolvedSubscription, resolveEntitlement } = await import('../../../worker/delivery/compiler')
  const { readDeliveryFromD1 } = await import('../../../worker/delivery/d1-repository')
  const east = await createFixture('bench-east')
  const west = await createFixture('bench-west')
  const seed = await createSubscription(east)
  const now = new Date().toISOString()

  for (const size of [100, 500, 1000]) {
    const first = size * 100
    const affected = size / 100
    await env.DB.batch([
      env.DB.prepare("DELETE FROM subscriptions WHERE id<>?").bind(seed.subscription.id),
      env.DB.prepare(`WITH RECURSIVE sequence(i) AS (
        SELECT 1 UNION ALL SELECT i+1 FROM sequence WHERE i < ?
      ) INSERT INTO subscriptions (id, name, token_hash, token_prefix, encrypted_token, enabled, default_client,
        revision, created_at, updated_at, plan_id)
      SELECT 'sub_' || cast(?+i AS INTEGER), printf('Fixture %d', i), printf('%043d', ?+i), 'fixture0',
        (SELECT encrypted_token FROM subscriptions WHERE id=?), 1, 'mihomo', 1, ?, ?,
        CASE WHEN i <= ? THEN ? ELSE ? END FROM sequence`)
        .bind(size, first, first, seed.subscription.id, now, now, affected, east.plan.id, west.plan.id),
      env.DB.prepare(`INSERT INTO subscription_groups (subscription_id, group_id, position)
        SELECT id, CASE WHEN plan_id=? THEN ? ELSE ? END, 0 FROM subscriptions WHERE id<>?`)
        .bind(east.plan.id, east.group.id, west.group.id, seed.subscription.id),
      env.DB.prepare('UPDATE subscriptions SET enabled=0 WHERE id=?').bind(seed.subscription.id),
    ])

    const sample = await readDeliverySubscription(env.DB, { id: `sub_${first + 1}` })
    expect(sample?.groupIds).toEqual([east.group.id])
    const started = Date.now()
    const changed = await adminPost(`${catalog}/sources/${east.source.id}`, { content: ss(`bench-${size}`) }, 'PUT')
    expect(changed.status).toBe(200)
    await changed.json()
    const invalidationMs = Date.now() - started
    const startWarm = Date.now()
    let maxPageMs = 0
    for (const platform of CLIENT_IDS) {
      const { job } = await (await adminPost(root, { platform, groupId: east.group.id })).json<{
        job: { id: string; status: string }
      }>()
      let result: { status: string; compiled?: number; skipped?: number }
      do {
        const page = Date.now()
        const response = await adminPost(`${root}/${job.id}/run`)
        expect(response.status).toBe(200)
        result = (await response.json<{ job: typeof result }>()).job
        maxPageMs = Math.max(maxPageMs, Date.now() - page)
      } while (result.status === 'running')
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed', compiled: affected, skipped: 1 })
    }
    const warmMs = Date.now() - startWarm

    const startFull = Date.now()
    const snapshot = await readDeliveryFromD1(env.DB)
    for (const sub of snapshot.subscriptions) {
      if (!sub.enabled) continue
      const access = await resolveEntitlement(env, sub, now)
      const artifacts = await Promise.all(CLIENT_IDS.map(client => renderResolvedSubscription(env, sub, client, access, now)))
      const prefix = `bench-full:${sub.tokenHash}:`
      await Promise.all(artifacts.flatMap(artifact => [
        env.DATA.put(prefix + artifact.client, JSON.stringify(artifact)),
        env.DATA.put(prefix + 'version:' + artifact.client, JSON.stringify(artifact)),
      ]))
      await env.DATA.list({ prefix })
    }
    const fullMs = Date.now() - startFull
    console.info(JSON.stringify({ event: 'core_f_benchmark', subscriptions: size, affected, invalidationMs, warmMs, maxPageMs, fullMs }))
  }
  const startBulk = Date.now()
  const { job } = await (await adminPost(root, { platform: 'generic' })).json<{ job: { id: string } }>()
  let pages = 0
  let maxPageMs = 0
  let result: { status: string }
  do {
    const page = Date.now()
    const response = await adminPost(`${root}/${job.id}/run`)
    expect(response.status).toBe(200)
    result = (await response.json<{ job: typeof result }>()).job
    maxPageMs = Math.max(maxPageMs, Date.now() - page)
    pages++
  } while (result.status === 'running')
  expect(result).toMatchObject({ status: 'completed', processed: 1001, compiled: 990, cacheHits: 10, skipped: 1, failures: 0 })
  console.info(JSON.stringify({ event: 'core_f_bulk_benchmark', subscriptions: 1000, pages, durationMs: Date.now() - startBulk, maxPageMs }))

}, 360_000)

it.skipIf(import.meta.env.VITE_SUB_V2_P4_BENCH !== '1')('measures P4 public fetch and bulk source update', async () => {
  const fixture = await createFixture('p4-bench')
  const seed = await createSubscription(fixture)
  const now = new Date().toISOString()
  const samples = Array.from({ length: 10_000 }, (_, i) => ({
    id: `sub_${i + 100}`, token: String(i + 100).padStart(43, '0'),
  }))
  const sourceUpdate = (size: number) => adminPost(`${catalog}/sources/${fixture.source.id}`, { content: ss(`update-${size}`) }, 'PUT')
  const operations: Record<string, number> = {}
  const increment = (name: string) => { operations[name] = (operations[name] ?? 0) + 1 }
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        increment(/^\s*SELECT\b/i.test(sql) ? 'd1ReadStatements' : 'd1WriteStatements')
        return target.prepare(sql)
      }
      if (property === 'batch') return (statements: D1PreparedStatement[]) => {
        increment('d1Batches')
        return target.batch(statements)
      }
      return Reflect.get(target, property, target)
    },
  })
  const kv = new Proxy(env.DATA, {
    get(target, property) {
      if (property === 'get') return (...args: [string]) => { increment('kvGets'); return target.get(...args) }
      if (property === 'put') return (...args: [string, string, KVNamespacePutOptions?]) => { increment('kvPuts'); return target.put(...args) }
      return Reflect.get(target, property, target)
    },
  })
  const bindings = { ...env, DB: db, DATA: kv }
  const logger = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  try {
    for (const size of [1, 100, 1_000, 10_000]) {
      const active = samples.slice(0, size)
      const writeStart = performance.now()
      let rowsWritten = 0
      for (let i = 0; i < active.length; i += 100) {
        const page = await Promise.all(active.slice(i, i + 100).map(async item => ({ id: item.id, hash: await hashToken(item.token) })))
        const results = await env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO subscriptions
            (id,name,token_hash,token_prefix,encrypted_token,enabled,default_client,revision,created_at,updated_at,plan_id)
            SELECT json_extract(value,'$.id'), 'Fixture', json_extract(value,'$.hash'), 'fixture0',
              (SELECT encrypted_token FROM subscriptions WHERE id=?), 1, 'generic', 1, ?, ?, ?
              FROM json_each(?)`).bind(seed.subscription.id, now, now, fixture.plan.id, JSON.stringify(page)),
          env.DB.prepare(`INSERT OR IGNORE INTO subscription_groups (subscription_id, group_id, position)
            SELECT json_extract(value,'$.id'), ?, 0 FROM json_each(?)`).bind(fixture.group.id, JSON.stringify(page)),
        ])
        rowsWritten += results.reduce((n, result) => n + result.meta.rows_written, 0)
      }
      const writeMs = Math.round(performance.now() - writeStart)
      const updateStart = performance.now()
      const updated = await sourceUpdate(size)
      expect(updated.status).toBe(200)
      await updated.json()
      const updateMs = Math.round(performance.now() - updateStart)
      for (const pass of ['cold', 'warm']) {
        for (const key of Object.keys(operations)) delete operations[key]
        const started = performance.now()
        const latencies: number[] = []
        const statuses: Record<number, number> = {}
        let cursor = 0
        await Promise.all(Array.from({ length: Math.min(size, 64) }, async () => {
          while (cursor < active.length) {
            const i = cursor++
            const start = performance.now()
            const ctx = createExecutionContext()
            const response = await worker.fetch(new Request(`${TEST_ORIGIN}/sub/${active[i].token}/generic`, {
              headers: { 'CF-Connecting-IP': `2001:db8::${(i + 1).toString(16)}` },
            }), bindings, ctx)
            await response.arrayBuffer()
            latencies.push(performance.now() - start)
            statuses[response.status] = (statuses[response.status] ?? 0) + 1
            await waitOnExecutionContext(ctx)
          }
        }))
        latencies.sort((a, b) => a - b)
        console.warn(JSON.stringify({
          event: 'p4_benchmark', size, pass, wallMs: Math.round(performance.now() - started),
          p50: Math.round(latencies[Math.floor(size * 0.5)]),
          p95: Math.round(latencies[Math.floor(size * 0.95)]), statuses, writeMs, rowsWritten, updateMs, operations,
        }))
        expect(statuses[200]).toBe(size)
        logger.mockClear()
      }
    }
  } finally {
    logger.mockRestore()
  }
}, 300_000)

it.skipIf(import.meta.env.VITE_SUB_V2_P4_BENCH !== '1')('measures concurrent P4 source changes', async () => {
  const sources = []
  for (let index = 0; index < 20; index++) {
    const { source } = await createFixture(`p4-source-${index}`)
    sources.push(source.id)
  }
  const update = (id: string, index: number) => adminPost(`${catalog}/sources/${id}`, { content: ss(`p4-change-${index}`) }, 'PUT')
  const started = performance.now()
  const responses = await Promise.all(sources.map(update))
  const statusCounts: Record<number, number> = {}
  for (const response of responses) {
    await response.arrayBuffer()
    statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1
  }
  const concurrentMs = Math.round(performance.now() - started)
  const retry = performance.now()
  for (const [index, response] of responses.entries()) {
    if (response.status === 200) continue
    expect(response.status).toBe(409)
    const result = await update(sources[index], index)
    expect(result.status).toBe(200)
    await result.arrayBuffer()
  }
  console.info(JSON.stringify({
    event: 'p4_source_batch', sources: sources.length, statuses: statusCounts, concurrentMs,
    sequentialRetryMs: Math.round(performance.now() - retry),
  }))
}, 60_000)
