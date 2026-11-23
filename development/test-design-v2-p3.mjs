import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.DESIGN_V2_P3_BASE_URL ?? 'http://127.0.0.1:4182'
const output = 'development/screenshots/design-v2-p3'
const now = Date.parse('2026-11-21T08:30:00.000Z')
const iso = new Date(now).toISOString()
const expires = now + 12 * 86400000
const user = { id: 'usr_1', username: 'alice', role: 'user', enabled: true, email: 'alice@example.com', emailVerifiedAt: iso }
const subscription = {
  id: 'sub_1', userId: 'usr_1', name: '主订阅', groupIds: ['grp_1'], tokenPrefix: 'abcd', enabled: true,
  planId: 'plan_1', planName: '标准计划', planState: 'active', trafficGb: 200, speedLimitMbps: 0, deviceLimit: 3,
  defaultClient: 'clash', revision: 1, startsAt: now - 86400000, expiresAt: expires, createdAt: iso, updatedAt: iso,
  links: { clash: 'https://example.com/sub/clash', stash: 'https://example.com/sub/stash' },
  diagnostics: { clash: { inputNodes: 2, outputNodes: 2, skippedNodes: 0, diagnostics: [], available: true } },
}
const nodes = [
  { id: 'node_1', name: '香港 01', protocol: 'vmess', groups: [{ id: 'grp_1', name: '默认分组' }], subscriptions: [{ id: 'sub_1', name: '主订阅' }] },
  { id: 'node_2', name: '东京 02', protocol: 'trojan', groups: [{ id: 'grp_1', name: '默认分组' }], subscriptions: [{ id: 'sub_1', name: '主订阅' }] },
]
const routes = [
  ['home', '/home', '首页'],
  ['subscriptions', '/subscriptions', '我的订阅'],
  ['nodes', '/nodes', '我的节点'],
  ['me', '/me', '个人中心'],
]

let mode = 'ready'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ baseURL })
await page.clock.setFixedTime(now)
await page.route('**/api/**', async (route) => {
  const path = new URL(route.request().url()).pathname
  if (mode === 'slow' && (path === '/api/account/subscriptions' || path === '/api/user/nodes')) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  if (mode === 'error' && (path === '/api/account/subscriptions' || path === '/api/user/nodes' || path === '/api/account/profile')) {
    return route.abort()
  }
  const subscriptions = mode === 'empty' || mode === 'gate' ? [] : [subscription]
  const nodeBody = mode === 'gate'
    ? { hasActiveSubscription: false, nodes: [], total: 0, page: 1, pageSize: 20, subscriptionOptions: [], groupOptions: [] }
    : mode === 'empty'
      ? { hasActiveSubscription: true, nodes: [], total: 0, page: 1, pageSize: 20, subscriptionOptions: [], groupOptions: [] }
      : { hasActiveSubscription: true, nodes, total: nodes.length, page: 1, pageSize: 20, subscriptionOptions: [{ id: 'sub_1', name: '主订阅' }], groupOptions: [{ id: 'grp_1', name: '默认分组' }] }
  const fixtures = {
    '/api/bootstrap': { initialized: true, user },
    '/api/account/profile': { user, emailBound: true, avatar: { url: '/logo.png' }, session: { issuedAt: iso, expiresAt: new Date(now + 86400000).toISOString() } },
    '/api/account/subscriptions': { subscriptions, shareEnabled: true },
    '/api/account/subscription-platforms': { platforms: [{ platform: 'clash', displayName: 'Clash' }, { platform: 'stash', displayName: 'Stash' }] },
    '/api/notices': { notices: [{ id: 1, title: '线路维护已完成' }] },
    '/api/apps': { downloadsEnabled: true, apps: [] },
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
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    for (const theme of width === 1440 ? ['light'] : ['light', 'dark']) {
      await page.addInitScript((value) => localStorage.setItem('subpanel.theme', value), theme)
      for (const [name, path, title] of routes) {
        mode = 'ready'
        await page.goto(path)
        await page.evaluate((value) => {
          localStorage.setItem('subpanel.theme', value)
          document.documentElement.dataset.theme = value
          document.documentElement.style.colorScheme = value
        }, theme)
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
        await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name} ${width} ${theme} overflows`)
        assert.deepEqual(await clipped(), [], `${name} ${width} ${theme} clips a control`)
        await page.screenshot({ path: join(output, `${name}-${width}-${theme}.png`), animations: 'disabled' })
      }
    }
  }

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/home')
    await expect(page.getByRole('heading', { level: 1, name: '首页' })).toBeVisible()
    await expect(page.getByRole('link', { name: '打开订阅' })).toBeVisible()
    await expect(page.getByText('有效期剩余 12 天')).toBeVisible()
    await expect(page.getByRole('link', { name: '导入客户端' })).toBeVisible()
    await expect(page.getByText('线路维护已完成')).toBeVisible()
    assert.equal(await page.evaluate(() => {
      const names = [...document.querySelectorAll('h1, h2')].map((node) => node.textContent)
      const importAt = document.body.innerText.indexOf('导入客户端')
      const noticeAt = document.body.innerText.indexOf('线路维护已完成')
      return names.filter((name) => name === '首页').length === 1 && importAt > -1 && noticeAt > importAt
    }), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `home overflows at ${width}`)
    assert.deepEqual(await clipped(), [], `home clips a control at ${width}`)
    console.log(`Home order, title and fit passed at ${width}px`)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/subscriptions')
  await expect(page.getByRole('link', { name: '下载客户端' })).toBeVisible()
  const importLink = page.getByRole('link', { name: '导入到客户端' })
  await expect(importLink).toHaveAttribute('href', /^clash:\/\//)
  const copy = page.getByRole('button', { name: '复制', exact: true })
  await copy.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(copy).toBeFocused()
  assert.equal(await copy.evaluate((element) => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none'), true)
  await page.getByRole('button', { name: '重置订阅令牌' }).click()
  const dialog = page.getByRole('dialog', { name: '重置订阅令牌' })
  await expect(dialog).toBeVisible()
  assert.equal(await dialog.evaluate((element) => getComputedStyle(element).borderRadius), '12px')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '重置订阅令牌' })).toBeFocused()
  console.log('Subscription import, copy focus and reset dialog passed')

  const summary = page.locator('.sidebar .user-center summary')
  await summary.click()
  const menu = page.getByRole('navigation', { name: '账号菜单' })
  await expect(menu.getByRole('link', { name: '个人中心' })).toBeVisible()
  await expect(menu.getByRole('link', { name: '我的订阅' })).toBeVisible()
  await expect(menu.getByRole('link', { name: '安全与通知设置' })).toBeVisible()
  await expect(menu.getByRole('button', { name: '外观' })).toBeVisible()
  await expect(menu.getByRole('button', { name: '退出登录' })).toBeVisible()
  assert.equal(await menu.evaluate((element) => getComputedStyle(element).borderRadius), '12px')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(summary).toBeFocused()
  console.log('Account menu presentation and Escape focus passed')

  await page.goto('/nodes')
  const search = page.getByRole('searchbox', { name: '搜索节点名称' })
  await search.fill('香港')
  await page.getByRole('button', { name: '重置筛选' }).click()
  await expect(search).toHaveValue('')
  await page.getByText('更多筛选', { exact: true }).click()
  await expect(page.getByRole('combobox', { name: '按分组筛选' })).toBeVisible()
  assert.equal(await page.locator('.upd-nodes .sp-select-trigger').first().evaluate((element) => getComputedStyle(element).borderRadius), '6px')
  await page.setViewportSize({ width: 768, height: 900 })
  await expect(page.getByRole('columnheader', { name: '所属订阅' })).toBeHidden()
  await expect(page.getByRole('columnheader', { name: '协议' })).toBeVisible()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  console.log('Node filters, radius and medium-width column passed')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/me')
  await expect(page.getByRole('button', { name: '主题' })).toBeVisible()
  await expect(page.getByRole('switch', { name: '到期提醒' })).toBeVisible()
  assert.deepEqual(await clipped(), [], 'mine clips a control at 390')
  console.log('Mobile theme control and reminder switch passed')

  mode = 'slow'
  await page.goto('/home')
  await expect(page.getByText('正在加载首页')).toBeVisible()
  await expect(page.getByText('有效期剩余 12 天')).toBeVisible()
  mode = 'error'
  await page.goto('/home')
  await expect(page.getByRole('alert')).toContainText('无法连接服务，请稍后重试')
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  await page.goto('/subscriptions')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.goto('/nodes')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.goto('/me')
  await expect(page.getByRole('alert').first()).toContainText('无法连接服务，请稍后重试')
  mode = 'empty'
  await page.goto('/subscriptions')
  await expect(page.getByText('暂无可用订阅')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: '我的订阅' })).toBeVisible()
  await page.goto('/nodes')
  await expect(page.getByText('暂无可用节点')).toBeVisible()
  await expect(page.getByRole('link', { name: '去订阅' })).toBeVisible()
  mode = 'gate'
  await page.goto('/nodes')
  await expect(page.getByRole('heading', { level: 1, name: '我的节点' })).toBeVisible()
  await expect(page.getByText('需要有效订阅才能查看节点')).toBeVisible()
  await expect(page.getByRole('link', { name: '去订阅' })).toBeVisible()
  mode = 'empty'
  await page.goto('/home')
  await expect(page.getByText('未开通', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '导入客户端' })).toHaveCount(0)
  console.log('Loading, failure, empty and gated states passed')
} finally {
  await browser.close()
}
