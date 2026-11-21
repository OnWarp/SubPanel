import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.HOME_TRAFFIC_BASE_URL ?? 'http://127.0.0.1:4182'
const output = 'development/screenshots/home-traffic'
const now = Date.parse('2026-11-21T08:30:00.000Z')
const iso = new Date(now).toISOString()
const expires = now + 12 * 86400000
const user = { id: 'usr_1', username: 'alice', role: 'user', enabled: true, email: 'alice@example.com', emailVerifiedAt: iso }
const subscription = {
  id: 'sub_1', userId: 'usr_1', name: '主订阅', groupIds: ['grp_1'], tokenPrefix: 'abcd', enabled: true,
  planId: 'plan_1', planName: '标准计划', planState: 'active', trafficGb: 200, speedLimitMbps: 0, deviceLimit: 3,
  defaultClient: 'mihomo', revision: 1, startsAt: now - 86400000, expiresAt: expires, createdAt: iso, updatedAt: iso,
  links: { mihomo: 'https://example.com/sub/mihomo' },
  diagnostics: { mihomo: { inputNodes: 2, outputNodes: 2, skippedNodes: 0, diagnostics: [], available: true } },
}
const nodes = [
  { id: 'node_1', name: '香港 01', protocol: 'vmess', groups: [{ id: 'grp_1', name: '默认分组' }], subscriptions: [{ id: 'sub_1', name: '主订阅' }] },
  { id: 'node_2', name: '东京 02', protocol: 'trojan', groups: [{ id: 'grp_1', name: '默认分组' }], subscriptions: [{ id: 'sub_1', name: '主订阅' }] },
]
const nodeBody = {
  hasActiveSubscription: true, nodes, total: nodes.length, page: 1, pageSize: 20,
  subscriptionOptions: [{ id: 'sub_1', name: '主订阅' }], groupOptions: [{ id: 'grp_1', name: '默认分组' }],
}

let usage = null
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ baseURL })
await page.route('**/api/**', (route) => {
  const path = new URL(route.request().url()).pathname
  const current = usage ? { ...subscription, usedGb: 42.5, remainingGb: 157.5 } : subscription
  const fixtures = {
    '/api/bootstrap': { initialized: true, user },
    '/api/account/profile': { user, emailBound: true, avatar: { url: '/logo.png' }, session: { issuedAt: iso, expiresAt: new Date(now + 86400000).toISOString() } },
    '/api/account/subscriptions': { subscriptions: [current], shareEnabled: false },
    '/api/account/subscription-platforms': { platforms: [{ platform: 'mihomo', displayName: 'Mihomo' }] },
    '/api/notices': { notices: [{ id: 1, title: '线路维护已完成' }] },
    '/api/apps': { downloadsEnabled: false, apps: [] },
    '/api/user/nodes': nodeBody,
  }
  return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
})

const clipped = async () => page.evaluate(() => [...document.querySelectorAll('button, a, input, summary, .sp-switch')].flatMap((element) => {
  const box = element.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return []
  if (box.left >= -1 && box.right <= window.innerWidth + 1) return []
  return [`${element.tagName}.${element.className} ${box.left.toFixed(0)}..${box.right.toFixed(0)}`]
}))

try {
  await mkdir(output, { recursive: true })
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height })
    usage = { usedGb: 42.5, remainingGb: 157.5 }
    await page.goto('/home')
    await page.evaluate(() => {
      localStorage.setItem('subpanel.theme', 'light')
      document.documentElement.dataset.theme = 'light'
      document.documentElement.style.colorScheme = 'light'
    })
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: '首页', exact: true })).toBeVisible()
    await expect(page.getByText('有效期剩余 12 天 · 已用 42.5 GB · 剩余 157.5 GB')).toBeVisible()
    await expect(page.getByRole('link', { name: '导入客户端' })).toBeVisible()
    assert.deepEqual(await page.locator('.upd-home .sp-stat-label').allTextContents(), ['订阅', '分组 / 节点'])
    assert.equal(await page.locator('.upd-home .object-card').count(), 2)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `with usage overflows at ${width}`)
    assert.deepEqual(await clipped(), [], `with usage clips a control at ${width}`)
    await page.screenshot({ path: join(output, `home-${width}-with-usage.png`), animations: 'disabled' })

    usage = null
    await page.goto('/home')
    await expect(page.getByText('有效期剩余 12 天', { exact: true })).toBeVisible()
    await expect(page.getByText('已用')).toHaveCount(0)
    await expect(page.getByText('剩余不限')).toHaveCount(0)
    assert.deepEqual(await page.locator('.upd-home .sp-stat-label').allTextContents(), ['订阅', '分组 / 节点'])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `without usage overflows at ${width}`)
    assert.deepEqual(await clipped(), [], `without usage clips a control at ${width}`)
    await page.screenshot({ path: join(output, `home-${width}-without-usage.png`), animations: 'disabled' })
  }

  usage = { usedGb: 42.5, remainingGb: 157.5 }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/home')
  await page.getByRole('link', { name: '打开订阅' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '我的订阅', exact: true })).toBeVisible()
  await expect(page.getByText('200 GB')).toBeVisible()
  await page.goto('/home')
  await page.getByRole('button', { name: /分组 \/ 节点/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: '我的节点', exact: true })).toBeVisible()
  await expect(page.getByText('香港 01')).toBeVisible()
  console.log('Home traffic states, subscription quota and node navigation passed')
} finally {
  await browser.close()
}
