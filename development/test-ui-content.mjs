// Built-client regression checks with intercepted APIs; no localhost server required.
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const plan = { id: 'plan', name: '标准计划', durationDays: 30, trafficGb: 100, speedLimitMbps: 200, deviceLimit: 3, description: '计划说明' }
let planState = 'active'
let role = 'user'
let failedStats = false
let reset = false
const tickets = ['open', 'open', 'closed'].map((status, i) => ({ id: i + 1, title: `工单 ${i + 1}`, status, lastReplyBy: i === 1 ? 'admin' : 'user', level: 0, createdAt: '2026-11-01T00:00:00Z', lastReplyAt: null }))
const subscriptions = [{ id: 'sub', name: '测试订阅', enabled: true, planId: plan.id, planName: plan.name, planState: 'active', trafficGb: plan.trafficGb, speedLimitMbps: plan.speedLimitMbps, deviceLimit: plan.deviceLimit, expiresAt: Date.now() + 86400000, groupIds: [], links: { auto: 'https://example.test/sub', mihomo: 'https://example.test/mihomo' }, diagnostics: {}, createdAt: '2026-11-01T00:00:00Z' }]
const context = await browser.newContext()
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.route('http://ui.test/**', async (route) => {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/api/')) {
    let body = {}
    if (url.pathname === '/api/bootstrap') body = { initialized: true, user: { id: 'u', username: '测试用户', role, enabled: true } }
    else if (url.pathname === '/api/apps') body = { apps: [], downloadsEnabled: true }
    else if (url.pathname === '/api/user/nodes') body = { hasActiveSubscription: planState === 'active', nodes: planState === 'active' ? [{ id: 'n', name: '可用节点', protocol: 'ss', groups: [], subscriptions: [] }] : [], total: Number(planState === 'active'), groupOptions: [], subscriptionOptions: [] }
    else if (url.pathname === '/api/notices') body = { notices: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `公告 ${i + 1}`, body: '公告内容\n'.repeat(10), publishedAt: '2026-11-01T00:00:00Z' })) }
    else if (url.pathname === '/api/tickets') body = { tickets }
    else if (url.pathname === '/api/tickets/1') body = { ticket: tickets[0], replies: [{ id: 1, authorRole: 'user', body: '问题详情', createdAt: tickets[0].createdAt }] }
    else if (url.pathname === '/api/account/subscriptions') body = { subscriptions }
    else if (url.pathname.endsWith('/token/reset')) { reset = true; body = { subscription: subscriptions[0], token: 'new-token', warning: '请保存新令牌' } }
    else if (url.pathname === '/api/account/subscription-platforms') body = { platforms: [{ platform: 'auto', displayName: '自动' }, { platform: 'mihomo', displayName: 'Mihomo' }] }
    else if (url.pathname === '/api/admin/catalog') body = { sources: [], nodes: [], groups: [] }
    else if (url.pathname === '/api/admin/subscriptions') body = { subscriptions: [], total: 0 }
    else if (url.pathname === '/api/admin/tickets') body = { tickets: [], total: 0 }
    else if (url.pathname === '/api/admin/users') body = { total: 101, users: url.searchParams.get('page') === '2' ? [{ id: 'last' }] : Array.from({ length: 100 }, (_, i) => ({ id: `u${i}` })) }
    else if (url.pathname === '/api/admin/stats') {
      if (failedStats) return route.fulfill({ status: 503, json: { error: { message: '不可用' } } })
      body = { users: 101, activeSubscriptions: 59, expiringSubscriptions: 12, pendingTickets: 7, plans: 1, groups: 0, nodes: 0 }
    }
    return route.fulfill({ json: body })
  }
  const file = url.pathname.startsWith('/assets/') ? url.pathname : '/index.html'
  return route.fulfill({ body: await readFile(resolve('dist/client' + file)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
})
const visible = async (text) => { await page.getByText(text, { exact: true }).first().waitFor() }
try {
  for (const state of ['none', 'expired', 'revoked', 'pending', 'disabled']) {
    planState = state
    await page.goto('http://ui.test/nodes')
    await visible('需要有效订阅才能查看节点')
    assert.equal(await page.getByRole('heading').count(), 0)
    assert.equal(await page.getByRole('searchbox').count(), 0)
  }
  planState = 'active'
  await page.goto('http://ui.test/nodes'); await visible('可用节点')
  await page.getByRole('searchbox').fill('可用')
  await visible('可用节点')
  await page.goto('http://ui.test/notices'); await visible('公告 1')
  assert.equal(await page.locator('.ntc-card').count(), 10)
  await page.getByRole('button', { name: '下一页' }).click(); await visible('公告 11')
  assert.equal(await page.locator('.ntc-card').count(), 2)
  await page.getByRole('searchbox').fill('公告 12'); await visible('公告 12')
  assert.equal(await page.locator('.ntc-card').count(), 1)
  await page.getByText('阅读全文').click()
  assert.equal(await page.locator('details[open]').count(), 1)
  await page.getByRole('searchbox').fill('无匹配'); await visible('没有匹配的公告')
  await page.goto('http://ui.test/tickets'); await visible('待回复'); await visible('已回复'); await visible('已关闭')
  assert.equal(await page.locator('.tk-list-card').count(), 3)
  await page.getByRole('link', { name: '工单 1', exact: true }).click(); await visible('问题详情')
  await page.getByLabel('追加回复').waitFor()
  await page.goto('http://ui.test/entitlements'); await page.waitForURL('**/subscriptions'); await visible('标准计划'); await visible('100 GB'); await visible('到期时间')
  assert.equal(await page.getByRole('button', { name: /购买/ }).count(), 0)
  await page.goto('http://ui.test/subscriptions'); await visible('各平台链接')
  assert.equal(await page.locator('.ui3-platform-row').count(), 2)
  await page.getByRole('button', { name: '重置订阅令牌', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(reset, false)
  await page.getByRole('button', { name: '重置订阅令牌', exact: true }).click()
  await page.getByRole('button', { name: '确认重置' }).click(); await visible('订阅令牌已重置')
  assert.equal(reset, true)
  role = 'admin'
  await page.goto('http://ui.test/dashboard'); await visible('总用户'); await visible('7 日内到期')
  const grid = page.getByRole('region', { name: '概览统计与待办' })
  await grid.waitFor()
  assert.deepEqual(await grid.locator('.sp-stat-value').allTextContents(), ['101', '59', '12', '7', '0', '1', '0'])
  assert.equal(await grid.getByText('总用户', { exact: true }).count(), 1)
  assert.equal(await grid.getByRole('link').count(), 2)
  await grid.getByRole('link', { name: /7 日内到期/ }).click()
  await page.waitForURL('**/delivery/subscriptions?expiry=soon')
  await page.goBack()
  await grid.getByRole('link', { name: /待处理工单/ }).click()
  await page.waitForURL('**/delivery/tickets')
  await page.goBack()
  failedStats = true
  await page.reload(); await visible('不可用')
  assert.equal(await page.locator('.adm-stat-grid .sp-stat-card').count(), 0)
  failedStats = false
  await page.setViewportSize({ width: 390, height: 812 })
  await page.goto('http://ui.test/dashboard'); await visible('总用户')
  assert.equal(await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length), 2)
  assert.equal(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.deepEqual(errors, [])
  console.log('PASS: node gates (five states), active list/filter, notice pagination/search/full text, ticket states/thread/composer, subscription plan and quota, platform list/reset confirmation, paginated admin totals/partial failure/mobile overflow')
} finally { await browser.close() }
