// Built-client navigation acceptance checks; APIs are intercepted without a server.
// Run after npm run build in a sandbox that permits Chromium sockets.
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
let role = 'admin'
let signedOut = false
let downloadsEnabled = true
const calls = []
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.route('http://nav.test/**', async route => {
  const url = new URL(route.request().url())
  if (!url.pathname.startsWith('/api/')) {
    const file = url.pathname.startsWith('/assets/') || url.pathname === '/theme-init.js' ? url.pathname : '/index.html'
    return route.fulfill({ body: await readFile(resolve('dist/client' + file)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
  }
  calls.push(url.pathname + url.search)
  let body = {}
  if (url.pathname === '/api/bootstrap') body = { initialized: true, user: signedOut ? null : { id: 'usr_1', username: 'test', role, enabled: true } }
  else if (url.pathname === '/api/account/logout') { signedOut = true; body = { ok: true } }
  else if (url.pathname === '/api/admin/users') body = { users: [], total: 0, page: 1, pageSize: 20 }
  else if (url.pathname === '/api/admin/invitations') body = { invitations: [], total: 0 }
  else if (url.pathname === '/api/admin/catalog') body = { sources: [], nodes: [], groups: [] }
  else if (url.pathname === '/api/admin/shares') body = { shares: [] }
  else if (url.pathname === '/api/admin/plans') body = { plans: [] }
  else if (url.pathname === '/api/admin/tickets') body = { tickets: [], total: 0 }
  else if (url.pathname === '/api/admin/kb/categories') body = { categories: [] }
  else if (url.pathname === '/api/admin/kb/articles') body = { articles: [], total: 0 }
  else if (url.pathname === '/api/admin/audit-logs') body = { logs: [], pagination: { pageCount: 1 } }
  else if (url.pathname.endsWith('/subscriptions')) body = { subscriptions: [] }
  else if (url.pathname === '/api/admin/system/registration') body = { mode: 'open' }
  else if (url.pathname === '/api/admin/email-domains') body = { domains: [] }
  else if (url.pathname === '/api/admin/system/mail') body = { settings: { provider: 'smtp', from: '', smtpHost: '', smtpPort: null, smtpUser: '', smtpPasswordSet: false, resendApiKeySet: false } }
  else if (url.pathname === '/api/admin/mail-templates') body = { templates: [] }
  else if (url.pathname === '/api/admin/mail-broadcasts') body = { broadcasts: [] }
  else if (url.pathname === '/api/admin/system/reminders') body = { reminder_days: 3 }
  else if (url.pathname === '/api/admin/system/domains') body = { panel: [], subscription: [], primaryPanelDomainId: null, primarySubscriptionDomainId: null, restrictionEnabled: false }
  else if (url.pathname.endsWith('/subscription-platforms')) body = { platforms: [] }
  else if (url.pathname === '/api/admin/share-settings') body = { settings: { enabled: true, createAllowed: true, maxSharesPerSubscription: 10, maxActiveSharesPerUser: 10, maxValidityDays: 30, defaultAllowOriginalLink: false, defaultAccessControl: 'none', requireLoginDefault: false, publicBaseUrl: '' } }
  else if (url.pathname === '/api/health') body = { ok: true, version: '0.1.0', cron: null }
  else if (url.pathname === '/api/admin/system/status') body = { status: { databaseName: 'test', modules: [], migrations: [] } }
  else if (url.pathname === '/api/admin/system/app-downloads') body = { enabled: true }
  else if (url.pathname === '/api/admin/apps') body = { apps: [] }
  else if (url.pathname.endsWith('/notices')) body = { notices: [], total: 0 }
  else if (url.pathname === '/api/apps') body = { downloadsEnabled, apps: [] }
  else if (url.pathname === '/api/account/profile') body = { user: { id: 'usr_1', username: 'test', email: null }, avatar: { url: '', kind: 'dicebear', seed: 'test' }, emailBound: false, session: null }
  else if (url.pathname === '/api/account/entitlement') body = { state: 'none', current: null, latest: null }
  else if (url.pathname === '/api/user/nodes') body = { nodes: [], total: 0, groupOptions: [], subscriptionOptions: [] }
  else if (url.pathname === '/api/tickets') body = { tickets: [], total: 0 }
  else if (url.pathname === '/api/kb') body = { articles: [], total: 0 }
  return route.fulfill({ json: body })
})
const main = () => page.locator('main.workspace-content')
const go = path => page.goto('http://nav.test' + path)
try {
  await go('/dashboard')
  const sidebar = page.getByRole('navigation', { name: '主导航' })
  await sidebar.waitFor()
  assert.deepEqual(await sidebar.getByRole('link').allTextContents(), ['概览', '节点管理', '订阅管理', '用户管理', '运营管理', '系统设置'])
  assert.equal(await page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width), 224)
  assert.equal(await sidebar.evaluate(element => element.scrollHeight <= element.clientHeight), true)
  await page.getByRole('button', { name: '收起侧栏' }).click()
  await page.reload()
  await page.getByRole('button', { name: '展开侧栏' }).waitFor()
  assert.equal(await page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width), 64)
  const nodeLink = sidebar.getByRole('link', { name: '节点管理' })
  assert.equal(await nodeLink.getAttribute('title'), '节点管理')
  await nodeLink.focus()
  await page.keyboard.press('Enter')
  await page.waitForURL('**/catalog/nodes')
  await page.getByRole('button', { name: '展开侧栏' }).click()
  for (const [domain, name, destinations] of [
    ['节点管理', '节点管理导航', [['来源', '/catalog/sources'], ['分组', '/catalog/groups']]],
    ['订阅管理', '订阅管理导航', [['分享', '/delivery/shares'], ['权益计划', '/plans']]],
    ['运营管理', '运营管理导航', [['公告', '/operations/notices'], ['知识库', '/kb/manage'], ['客户端下载', '/catalog/apps']]],
  ]) {
    await sidebar.getByRole('link', { name: domain, exact: true }).click()
    const tabs = page.getByRole('navigation', { name })
    for (const [label, path] of destinations) {
      const tab = tabs.getByRole('link', { name: label, exact: true })
      await tab.click()
      await page.waitForURL('**' + path)
      assert.equal(await tab.getAttribute('aria-current'), 'page')
      assert.equal(await sidebar.getByRole('link', { name: domain, exact: true }).getAttribute('aria-current'), 'page')
    }
  }

  await go('/users?keep=1')
  const tabs = () => page.getByRole('navigation', { name: '用户管理子页' })
  await tabs().getByRole('link', { name: '邀请', exact: true }).click()
  assert.equal(new URL(page.url()).pathname, '/invites')
  assert.equal(new URL(page.url()).search, '?keep=1')
  await page.reload()
  await tabs().getByRole('link', { name: '邀请', exact: true }).getAttribute('aria-current').then(value => assert.equal(value, 'page'))
  await tabs().getByRole('link', { name: '回收站', exact: true }).click()
  await main().getByText('回收站是空的').waitFor()
  assert.ok(calls.some(call => call.includes('/api/admin/users?deleted=only')))
  await page.reload()
  await main().getByText('回收站是空的').waitFor()
  await page.goBack()
  assert.equal(new URL(page.url()).pathname, '/invites')

  await go('/system?section=domain&subscription=sub_1')
  await page.waitForURL('**/system/distribution?subscription=sub_1')
  await main().getByRole('heading', { name: '面板域名', exact: true }).waitFor()
  await main().getByRole('heading', { name: '订阅域名', exact: true }).waitFor()
  const settings = () => page.getByRole('navigation', { name: '系统设置导航' })
  for (const [label, key] of [['注册设置', 'registration'], ['邮件设置', 'mail'], ['运行状态', 'status'], ['订阅分发', 'distribution']]) {
    await settings().getByRole('link', { name: label, exact: true }).click()
    await page.waitForURL(`**/system/${key}?subscription=sub_1`)
    await page.reload()
    assert.equal(await settings().getByRole('link', { name: label, exact: true }).getAttribute('aria-current'), 'page')
  }
  await settings().getByRole('link', { name: '审计日志', exact: true }).click()
  await page.waitForURL('**/audit-logs?subscription=sub_1')
  assert.equal(await settings().getByRole('link', { name: '审计日志', exact: true }).getAttribute('aria-current'), 'page')

  await go('/system?tab=app-downloads&keep=1')
  await page.waitForURL('**/catalog/apps?keep=1')
  await main().getByRole('switch', { name: '显示客户端下载板块' }).waitFor()
  await page.getByRole('heading', { name: '客户端下载', exact: true }).first().waitFor()
  await go('/system#notices')
  await page.waitForURL('**/operations/notices')
  await main().getByText('发布公告', { exact: true }).waitFor()

  await page.locator('.sidebar .user-center summary').click()
  await page.getByRole('navigation', { name: '管理员账号菜单' }).getByRole('link', { name: '账户安全' }).click()
  await page.waitForURL('**/account')
  await page.locator('.sidebar .user-center summary').click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('menuitem', { name: '深色', exact: true }).click()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  await page.getByRole('navigation', { name: '管理员账号菜单' }).getByRole('button', { name: '退出登录' }).click()
  await page.waitForURL('**/login')

  signedOut = false
  await page.setViewportSize({ width: 390, height: 844 })
  await go('/users')
  const dock = page.locator('.admin-mobile-dock')
  await dock.waitFor()
  assert.deepEqual(await dock.getByRole('link').allTextContents(), ['概览', '节点管理', '订阅管理', '用户管理', '运营管理', '系统设置'])
  assert.equal(await dock.getByRole('link', { name: '用户管理', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await page.getByRole('button', { name: '更多', exact: true }).count(), 0)
  await dock.getByRole('link', { name: '运营管理', exact: true }).click()
  await page.waitForURL('**/delivery/tickets')
  await page.getByRole('navigation', { name: '运营管理导航' }).getByRole('link', { name: '客户端下载', exact: true }).click()
  await page.waitForURL('**/catalog/apps')
  assert.equal(await dock.getByRole('link', { name: '运营管理', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)

  role = 'user'
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await go('/me')
    const nav = width === 390 ? page.locator('.nav-dock') : page.locator('.nav-sidebar')
    assert.deepEqual(await nav.getByRole('link').allTextContents(), ['首页', '订阅', '节点', '我的'])
    const help = page.getByRole('navigation', { name: '帮助与支持' })
    assert.deepEqual(await help.getByRole('link').allTextContents(), ['公告', '知识库', '工单', '客户端下载'])
    await help.getByRole('link', { name: '公告', exact: true }).click()
    assert.equal(await nav.getByRole('link', { name: '我的', exact: true }).getAttribute('aria-current'), 'page')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await go('/home')
  await main().getByRole('link', { name: '打开订阅', exact: true }).first().click()
  await page.waitForURL('**/subscriptions')
  await main().getByRole('link', { name: '下载客户端', exact: true }).click()
  await page.waitForURL('**/apps')
  await go('/system/distribution')
  await page.waitForURL('**/subscriptions')
  downloadsEnabled = false
  await go('/me')
  await page.getByRole('navigation', { name: '帮助与支持' }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[aria-label="帮助与支持"] a[href="/apps"]'))
  assert.deepEqual(errors, [])
  console.log('PASS: user-management/history/refresh, settings/legacy query mapping, operations ownership, avatar/security/theme/logout, mobile admin six-entry dock, four user entries, support ownership and role guards')
} finally { await browser.close() }
