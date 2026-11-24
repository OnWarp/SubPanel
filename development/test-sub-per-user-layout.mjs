import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.LAYOUT_BASE_URL ?? 'http://127.0.0.1:4182'
const phase = process.env.LAYOUT_SCREENSHOT_PHASE ?? 'after'
const output = 'development/screenshots/sub-per-user-layout'
const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage({ baseURL, colorScheme: 'light', reducedMotion: 'reduce' })
  const account = id => ({ id, username: '管理员', role: 'admin', enabled: true, email: null, emailVerifiedAt: null })
  const alice = account('layout-a')
  const bob = account('layout-b')
  let user = alice
  let layoutDefaults = { pc: { navigation: 'topbar', sidebarCollapsed: true }, mobile: { bar: 'inset' }, theme: 'dark' }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/account/logout') user = null
    if (path === '/api/login') user = route.request().postDataJSON().username === 'layout-a' ? alice : bob
    const fixtures = {
      '/api/bootstrap': { initialized: true, user, layoutDefaults },
      '/api/account/profile': { user, emailBound: false, avatar: { url: '/logo.png' }, session: null },
      '/api/admin/stats': { users: 1284, activeSubscriptions: 936, expiringSubscriptions: 18, pendingTickets: 6, plans: 4, groups: 12, nodes: 20 },
      '/api/register/config': { mode: 'closed' },
      '/api/account/logout': { ok: true },
      '/api/login': { user },
    }
    return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
  })
  await page.route('**/layout-storage-fixture', route => route.fulfill({ body: '<!doctype html>', contentType: 'text/html' }))
  await page.goto('/layout-storage-fixture')
  await page.evaluate(() => {
    localStorage.setItem('subpanel:admin-layout', 'topbar')
    localStorage.setItem('subpanel:sidebar-collapsed', '1')
    localStorage.setItem('subpanel:mobile-bar', 'inset')
    localStorage.setItem('subpanel.theme', 'light')
  })
  const viewport = width => page.setViewportSize({ width, height: 844 })
  const ready = () => expect(page.getByText('1284', { exact: true })).toBeVisible()
  const shell = page.locator('.app-layout')
  const menu = placement => page.locator(`${placement} .admin-account summary`)
  const topbar = menu('.admin-desktop-topbar')
  const sidebar = menu('.sidebar')
  const mobile = menu('.topbar-account')
  const html = page.locator('html')

  await mkdir(output, { recursive: true })
  await viewport(1440)
  await page.goto('/dashboard')
  await ready()
  for (const width of [1440, 1024, 390]) {
    await viewport(width)
    if (width === 390) {
      await expect(page.locator('.admin-mobile-dock')).toBeVisible()
      await expect(shell).toHaveAttribute('data-mobile-bar', 'inset')
    } else {
      await expect(topbar).toBeVisible()
    }
    await page.screenshot({ path: `${output}/${phase}-${width}.png`, animations: 'disabled' })
  }

  if (phase === 'before') process.exitCode = 0
  else {
    const logout = async avatar => {
      if (await avatar.locator('..').getAttribute('open') === null) await avatar.click()
      await page.getByRole('button', { name: '退出登录' }).click()
      await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
      await expect(shell).toHaveCount(0)
      await expect(html).toHaveAttribute('data-theme', 'light')
    }
    const login = async id => {
      await page.getByLabel('用户名').fill(id)
      await page.locator('#login-password').fill('test')
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await ready()
    }

    await mobile.click()
    await page.getByRole('button', { name: '悬浮' }).click()
    await expect(shell).toHaveAttribute('data-mobile-bar', 'floating')
    await viewport(1440)
    await topbar.click()
    await page.getByRole('button', { name: '侧边栏' }).click()
    await expect(shell).toHaveClass(/sidebar-collapsed/)
    await sidebar.click()
    await page.getByRole('button', { name: '外观' }).click()
    await page.getByRole('menuitem', { name: '深色' }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    expect(await page.evaluate(() => localStorage.getItem('subpanel.theme'))).toBe('light')
    await page.evaluate(() => localStorage.setItem('subpanel.theme', 'dark'))
    await logout(sidebar)

    await login('layout-b')
    await expect(sidebar).toBeVisible()
    await expect(shell).not.toHaveClass(/sidebar-collapsed/)
    await expect(shell).toHaveAttribute('data-mobile-bar', 'floating')
    await expect(html).toHaveAttribute('data-theme', 'light')
    await page.getByRole('button', { name: '收起侧栏' }).click()
    await sidebar.click()
    await page.getByRole('button', { name: '顶部导航' }).click()
    await viewport(390)
    await mobile.click()
    await page.getByRole('button', { name: '内嵌' }).click()
    await logout(mobile)

    layoutDefaults = { pc: { navigation: 'topbar', sidebarCollapsed: false }, mobile: { bar: 'inset' }, theme: 'light' }
    await login('layout-a')
    await viewport(1440)
    await page.reload()
    await ready()
    await expect(sidebar).toBeVisible()
    await expect(shell).toHaveClass(/sidebar-collapsed/)
    await expect(shell).toHaveAttribute('data-mobile-bar', 'floating')
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await logout(sidebar)
    await login('layout-b')
    await expect(topbar).toBeVisible()
    await expect(shell).toHaveAttribute('data-mobile-bar', 'inset')
    await expect(html).toHaveAttribute('data-theme', 'light')
    console.log('Legacy migration, account isolation, logout, reload and bootstrap layout defaults passed')
  }
} finally {
  await browser.close()
}
