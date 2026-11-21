import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.LAYOUT_SWITCH_BASE_URL ?? 'http://127.0.0.1:4182'
const output = 'development/screenshots'
const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  let role = 'admin'
  await page.route('**/api/**', route => {
    const user = { id: role, username: role, role, enabled: true, email: null, emailVerifiedAt: null }
    const fixtures = {
      '/api/bootstrap': { initialized: true, user },
      '/api/account/profile': { user, emailBound: false, avatar: { url: '/logo.png' }, session: null },
      '/api/admin/stats': { users: 1284, activeSubscriptions: 936, expiringSubscriptions: 18, pendingTickets: 6, plans: 4, groups: 12, nodes: 20 },
      '/api/account/subscriptions': { subscriptions: [] },
      '/api/notices': { notices: [] },
      '/api/apps': { downloadsEnabled: true },
    }
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
  })
  await page.addInitScript(() => {
    localStorage.setItem('subpanel.theme', 'light')
    localStorage.setItem('subpanel:admin-layout', 'topbar')
    localStorage.setItem('subpanel:mobile-bar', 'inset')
  })

  const mobileAvatar = page.locator('.topbar-account summary')
  const desktopAvatar = page.locator('.admin-desktop-topbar .admin-account summary')
  const adminMenus = page.locator('.admin-account')
  const mobileBar = adminMenus.locator('[role="group"][aria-label="底栏样式"]')
  const layout = adminMenus.locator('[role="group"][aria-label="布局"]')
  const dock = page.locator('.admin-mobile-dock')
  const viewport = width => page.setViewportSize({ width, height: 844 })
  const preferences = () => page.evaluate(() => [
    localStorage.getItem('subpanel:admin-layout'),
    localStorage.getItem('subpanel:mobile-bar'),
  ])

  await mkdir(output, { recursive: true })
  await page.goto('/dashboard')
  await expect(page.getByText('1284', { exact: true })).toBeVisible()
  const documentBeforeResize = await page.evaluateHandle(() => document)

  await mobileAvatar.click()
  await expect(mobileBar.getByRole('button', { name: '悬浮' })).toBeVisible()
  await expect(mobileBar.getByRole('button', { name: '内嵌' })).toHaveAttribute('aria-pressed', 'true')
  await expect(layout).toHaveCount(0)
  await expect.poll(preferences).toEqual(['topbar', 'inset'])
  await page.screenshot({ path: join(output, 'layout-switch-split-390.png') })

  await viewport(1440)
  await desktopAvatar.click()
  await expect(layout.getByRole('button', { name: '侧边栏' })).toBeVisible()
  await expect(layout.getByRole('button', { name: '顶部导航' })).toHaveAttribute('aria-pressed', 'true')
  await expect(mobileBar).toHaveCount(0)
  await expect.poll(preferences).toEqual(['topbar', 'inset'])
  await page.screenshot({ path: join(output, 'layout-switch-split-1440.png') })

  await viewport(390)
  await expect(mobileBar).toBeVisible()
  await expect(layout).toHaveCount(0)
  await expect.poll(preferences).toEqual(['topbar', 'inset'])

  await viewport(768)
  await expect(layout).toBeVisible()
  await expect(mobileBar).toHaveCount(0)
  await expect(dock).toBeHidden()
  await viewport(767)
  await expect(mobileBar).toBeVisible()
  await expect(layout).toHaveCount(0)
  await expect(dock).toBeVisible()
  expect(await documentBeforeResize.evaluate(original => document === original)).toBe(true)

  role = 'user'
  await viewport(1440)
  await page.goto('/me')
  const settings = page.locator('.mobile-bar-settings')
  await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible()
  await expect(settings).toBeHidden()
  await viewport(390)
  await expect(settings.getByRole('group', { name: '底栏样式' })).toBeVisible()
  await expect(settings.getByRole('button', { name: '内嵌' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(preferences).toEqual(['topbar', 'inset'])
  console.log('Layout switch split, live resizing, mobile dock breakpoint, Mine settings and preference persistence passed')
} finally {
  await browser.close()
}
