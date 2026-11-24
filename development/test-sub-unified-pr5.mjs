import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const origin = new URL(process.env.SUBPANEL_BROWSER_ORIGIN ?? 'http://127.0.0.1:4185').origin
assert.equal(new URL(origin).hostname, '127.0.0.1')
const folder = 'development/screenshots/sub-unified-pr5'
await mkdir(folder, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })

try {
  const session = await browser.newContext({ baseURL: origin })
  await session.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const request = async (path, expected, method = 'GET', data) => {
    const response = await session.request.fetch(path, { method, data, headers: { origin } })
    assert.equal(response.status(), expected, `${method} ${path.replace(/\/sub\/[^/]+/u, '/sub/[redacted]')}`)
    return response.json()
  }
  const password = randomUUID()
  assert.ok(process.env.BOOTSTRAP_SECRET, 'Set BOOTSTRAP_SECRET for a fresh fixture')
  await request('/api/setup', 201, 'POST', { username: 'admin', password, setupSecret: process.env.BOOTSTRAP_SECRET })
  await request('/api/login', 200, 'POST', { username: 'admin', password })
  const page = await session.newPage()
  const widths = [1440, 1024, 390]
  const path = '/delivery/migration'
  const endpoint = '/api/admin/unified-subscription-migration'
  const shots = async (name, width, target = page) => {
    assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await target.screenshot({ path: `${folder}/${name}-${width}.png`, animations: 'disabled' })
  }
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(path)
    await expect(page.getByText('没有待预检用户')).toBeVisible()
    await shots('empty', width)
    await page.route(`**${endpoint}?after=`, route => route.fulfill({ status: 503, json: { message: '迁移数据尚未就绪' } }))
    await page.reload()
    await expect(page.getByRole('alert')).toBeVisible()
    await shots('error', width)
    await page.unroute(`**${endpoint}?after=`)
  }

  const proxy = Buffer.from(`aes-128-gcm:${randomUUID()}`).toString('base64url')
  const { source } = await request('/api/admin/catalog/sources', 201, 'POST', {
    name: 'Migration fixture source', type: 'manual', content: `ss://${proxy}@one.example:8388#Fixture node`,
  })
  const { group } = await request('/api/admin/catalog/groups', 201, 'POST', {
    name: 'Migration fixture group', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  })
  const old = await request('/api/admin/subscriptions', 201, 'POST', {
    userId: 'usr_1', name: 'Legacy fixture', groupIds: [group.id], startsAt: Date.now() - 1000, expiresAt: null, enabled: true,
  })
  const legacyPath = `/sub/${old.token ?? old.subscription?.token}`
  const preview = await request(`${endpoint}/usr_1/preview`, 200)
  assert.deepEqual(preview.blockers, [])
  await request(`${endpoint}/usr_1/execute`, 422, 'POST', { digest: preview.digest })
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(path)
    await page.getByRole('combobox', { name: '用户', exact: true }).selectOption('usr_1')
    await page.getByRole('button', { name: '预检', exact: true }).click()
    await expect(page.getByText('预检通过')).toBeVisible()
    await shots('preview', width)
    await page.getByRole('button', { name: '执行影子迁移' }).click()
    await expect(page.getByRole('dialog', { name: '确认影子迁移' })).toBeVisible()
    await shots('confirm', width)
    if (width === widths.at(-1)) {
      await page.getByRole('button', { name: '确认执行' }).click()
      await expect(page.getByRole('heading', { name: '对账一致' })).toBeVisible()
    } else await page.getByRole('button', { name: '取消' }).click()
  }
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await shots('reconciliation', width)
  }
  const before = await session.request.get(legacyPath)
  assert.equal(before.status(), 200)
  const cutover = spawnSync('npx', ['wrangler', 'd1', 'execute', 'subpanel-d1', '--local', '--command',
    `INSERT INTO system_settings (key,value,updated_at) VALUES ('unified_subscription_cutover_at','${Date.now()}',datetime('now'))`],
  { encoding: 'utf8' })
  assert.equal(cutover.status, 0, 'Local fixture cutover marker failed')
  for (const width of widths) {
    const response = await session.request.get(legacyPath, { headers: { 'If-None-Match': before.headers().etag } })
    assert.equal(response.status(), 200)
    assert.equal(response.headers().location, undefined)
    assert.equal(await response.text(), await before.text())
    const invalid = await session.request.get('/sub/invalid')
    assert.equal(invalid.status(), 404)
    const rejected = await session.newPage({ viewport: { width, height: 900 } })
    await rejected.goto('/sub/invalid')
    await shots('compatibility-error', width, rejected)
    await rejected.close()
  }
  const current = await request('/api/user/subscription', 200)
  assert.ok(current.subscriptionUrl)
  const unified = new URL(current.subscriptionUrl)
  // wrangler dev rewrites the worker request URL to the configured
  // custom-domain route (sub.warp.dpdns.org), so the fallback origin is the
  // route host, not the local dev origin, when no primary domain is set.
  // Accept the local origin (no rewrite) and either route-origin scheme (the rewrite scheme varies by wrangler dev environment; production is https).
  assert.ok([origin, 'http://sub.warp.dpdns.org', 'https://sub.warp.dpdns.org'].includes(unified.origin), 'unexpected subscription origin ' + unified.origin)
  const addresses = Array.from({ length: 12 }, (_, index) => `192.0.2.${index + 1}`)
  for (const [kind, url] of [['legacy', legacyPath], ['unified', `${unified.pathname}/singbox`]]) {
    const started = performance.now()
    const samples = await Promise.all(addresses.map(async address => {
      const requestStart = performance.now()
      const response = await session.request.get(url, { headers: { 'CF-Connecting-IP': address } })
      return { status: response.status(), outputKB: (await response.body()).length / 1024, wallMs: performance.now() - requestStart }
    }))
    assert.ok(samples.every(sample => sample.status === 200 || sample.status === 503))
    assert.ok(samples.some(sample => sample.status === 200))
    console.log(JSON.stringify({ kind, requests: samples.length, wallMs: performance.now() - started,
      status: Object.fromEntries([200, 503].map(code => [code, samples.filter(sample => sample.status === code).length])),
      maxWallMs: Math.max(...samples.map(sample => sample.wallMs)),
      maxOutputKB: Math.max(...samples.filter(sample => sample.status === 200).map(sample => sample.outputKB)) }))
  }
  console.log('Browser migration, reconciliation and legacy compatibility passed at 1440, 1024 and 390')
} finally {
  await browser.close()
}
