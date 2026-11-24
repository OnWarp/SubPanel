import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const origin = new URL(process.env.SUBPANEL_BROWSER_ORIGIN ?? 'http://127.0.0.1:4178').origin
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Run against the local preview')
const setupSecret = process.env.BOOTSTRAP_SECRET
assert.ok(setupSecret, 'Set BOOTSTRAP_SECRET for the local preview and browser process')
const password = randomUUID()
const folder = 'development/screenshots/sub-unified-pr2'
await mkdir(folder, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const context = await browser.newContext({ baseURL: origin })
  const page = await context.newPage()
  const api = async (path, method, data, expected) => {
    const response = await context.request.fetch(path, { method, data, headers: { origin } })
    assert.equal(response.status(), expected, `${method} ${path} returned ${response.status()}`)
    return response.json()
  }
  const { user } = await api('/api/setup', 'POST', { username: 'admin', password, setupSecret }, 201)
  await api('/api/login', 'POST', { username: 'admin', password }, 200)
  const nodeAuth = Buffer.from(`aes-128-gcm:${randomUUID()}`).toString('base64url')
  const { source } = await api('/api/admin/catalog/sources', 'POST', {
    name: 'Browser regression', type: 'manual',
    content: `ss://${nodeAuth}@one.example:8388#One\nss://${nodeAuth}@two.example:8388#Two`,
  }, 201)
  const { group } = await api('/api/admin/catalog/groups', 'POST', {
    name: 'Browser group', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  }, 201)
  const { template } = await api('/api/admin/subscription-templates', 'POST', {
    name: 'Browser entitlement', config: {
      groupIds: [group.id], nodeIds: [], duration: { value: 1, unit: 'month' },
      quotaBytes: null, resetPolicy: 'none', limits: { speedLimitMbps: 0 },
    },
  }, 201)
  const start = Date.now() - 1000
  const admin = `/api/admin/users/${user.id}`
  const binding = `${admin}/template-bindings/${template.id}`
  const preview = await api(`${binding}/preview?expectedRevision=0&expiry=permanent&startsAt=${start}`, 'GET', undefined, 200)
  assert.equal(preview.changes[0].after.expiresAt, null)
  await api(binding, 'PUT', {
    mode: 'assign', expectedRevision: 0, requestId: randomUUID(), expiry: { type: 'permanent' }, startsAt: start,
  }, 200)
  const old = await api('/api/admin/subscriptions', 'POST', {
    userId: user.id, name: 'Legacy browser baseline', groupIds: [group.id], startsAt: start,
    expiresAt: null, defaultClient: 'mihomo', enabled: true,
  }, 201)
  const legacyPath = `/sub/${old.token}/mihomo`
  const shadow = await api(`${admin}/subscription/shadow`, 'GET', undefined, 200)
  assert.equal(shadow.matches, true, JSON.stringify(shadow.reasons))

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/dashboard')
    await page.getByRole('region', { name: '概览统计与待办' }).waitFor()
    const summary = await api('/api/user/subscription', 'GET', undefined, 200)
    assert.equal(summary.status, 'active')
    assert.ok(!Object.hasOwn(summary, 'bindings') && !Object.hasOwn(summary, 'revision'))
    const path = new URL(summary.subscriptionUrl).pathname

    const publicResult = await page.evaluate(async ({ path, legacyPath }) => {
      const config = await fetch(`${path}/mihomo`, { credentials: 'omit' })
      const body = await config.text()
      const etag = config.headers.get('ETag')
      const conditional = await fetch(`${path}/mihomo`, { credentials: 'omit', headers: { 'If-None-Match': etag } })
      const legacy = await fetch(legacyPath, { credentials: 'omit' })
      return {
        status: config.status, conditional: conditional.status, cache: config.headers.get('Cache-Control'),
        nodeUnion: body.includes('one.example') && body.includes('two.example'),
        legacy: legacy.status,
      }
    }, { path, legacyPath })
    assert.equal(publicResult.status, 200)
    assert.equal(publicResult.conditional, 304)
    assert.equal(publicResult.cache, 'private, no-store')
    assert.equal(publicResult.nodeUnion, true)
    assert.equal(publicResult.legacy, 200)
    await api('/api/user/subscription/reset-token', 'POST', {}, 200)
    const invalid = await page.evaluate(async path => (await fetch(path, { credentials: 'omit' })).status, path)
    assert.equal(invalid, 404)
    await page.screenshot({ path: `${folder}/dashboard-${width}.png`, animations: 'disabled' })
    console.log(`${width}: aggregate 200, conditional 304, rotated link 404, legacy 200`)
  }
} finally {
  await browser.close()
}
