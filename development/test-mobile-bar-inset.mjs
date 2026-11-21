import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.MOBILE_BAR_BASE_URL ?? 'http://127.0.0.1:4182'
const output = 'development/screenshots/mobile-bar-inset'
const key = 'subpanel:mobile-bar'
const now = '2026-11-21T08:30:00.000Z'
const nodes = Array.from({ length: 20 }, (_, index) => ({
  id: `mobile-node-${index}`, protocol: 'ss', displayName: `Mobile node ${index + 1}`,
  server: `node-${index + 1}.example.com`, port: 8388, sourceIds: [],
  enabled: true, retained: false, order: index, updatedAt: now, createdAt: now,
}))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
let role = 'admin'
await page.route('**/api/**', route => {
  const user = { id: role, username: role, role, enabled: true, email: null, emailVerifiedAt: null }
  const fixtures = {
    '/api/bootstrap': { initialized: true, user },
    '/api/account/profile': { user, emailBound: false, avatar: { url: '/logo.png' }, session: null },
    '/api/admin/stats': { users: 1284, activeSubscriptions: 936, expiringSubscriptions: 18, pendingTickets: 6, plans: 4, groups: 12, nodes: 20 },
    '/api/admin/catalog': { schemaVersion: 2, revision: 1, updatedAt: now, sources: [], nodes, groups: [] },
    '/api/account/subscriptions': { subscriptions: [] },
    '/api/user/nodes': { total: 0, groupOptions: [] },
    '/api/notices': { notices: [] },
    '/api/apps': { downloadsEnabled: true },
  }
  const path = new URL(route.request().url()).pathname
  return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
})

const shell = page.locator('.app-layout')
const panel = page.locator('.workspace')
const main = page.getByRole('main')
const dock = page.locator('.admin-mobile-dock, .nav-dock')
const avatar = page.locator('.topbar-account summary')
const group = page.getByRole('group', { name: '底栏样式' })
const option = style => group.getByRole('button', { name: style === 'inset' ? '内嵌' : '悬浮' })

async function choose(style) {
  await option(style).focus()
  await page.keyboard.press('Enter')
  await expect(option(style)).toBeFocused()
  await expect(option(style)).toHaveAttribute('aria-pressed', 'true')
  await expect(shell).toHaveAttribute('data-mobile-bar', style)
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), style)
}

async function verifyDock(style, entries, active, safeBottom = 0) {
  await expect(dock.getByRole('link')).toHaveText(entries)
  await expect(dock.locator('[aria-current]')).toHaveText(active)
  await expect(dock.locator('[aria-current]')).toHaveCSS('background-color', 'rgb(94, 106, 210)')
  const [bar, workspace] = await Promise.all([dock.boundingBox(), panel.boundingBox()])
  assert.equal(bar.height, 68 + (style === 'inset' ? safeBottom : 0))
  if (style === 'inset') {
    assert.equal(bar.x, workspace.x + 1)
    assert.equal(bar.width, workspace.width - 2)
    assert.equal(bar.y + bar.height, workspace.y + workspace.height - 1)
    const content = await main.boundingBox()
    assert.equal(content.y + content.height, bar.y)
    await expect(dock).toHaveCSS('padding-bottom', `${6 + safeBottom}px`)
    await expect(dock).toHaveCSS('border-top-width', '1px')
    await expect(dock).toHaveCSS('border-left-width', '0px')
    await expect(dock).toHaveCSS('border-top-left-radius', '0px')
    await expect(dock).toHaveCSS('border-bottom-left-radius', await panel.evaluate(el => getComputedStyle(el).borderBottomLeftRadius))
    await expect(dock).toHaveCSS('background-color', await panel.evaluate(el => getComputedStyle(el).backgroundColor))
    await expect(dock).toHaveCSS('box-shadow', 'none')
  } else {
    assert.equal(bar.x, 19)
    assert.equal(bar.width, await page.evaluate(() => innerWidth - 38))
    assert.equal(bar.y + bar.height, await page.evaluate(() => innerHeight - 9) - safeBottom)
    await expect(dock).toHaveCSS('position', 'fixed')
    await expect(dock).toHaveCSS('border-top-left-radius', '34px')
  }
}

try {
  await mkdir(output, { recursive: true })
  await page.goto('/dashboard')
  await expect(shell).toHaveAttribute('data-mobile-bar', 'floating')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null)
  await page.emulateMedia({ reducedMotion: 'reduce' })

  for (const accountRole of ['admin', 'user']) {
    role = accountRole
    const admin = role === 'admin'
    const path = admin ? '/dashboard' : '/home'
    const settings = admin ? path : '/me'
    const entries = admin ? ['概览', '节点管理', '订阅管理', '用户管理'] : ['首页', '订阅', '节点', '我的']
    await page.goto(settings)
    // The user shell reads the inset choice previously saved in the admin shell.
    await expect(shell).toHaveAttribute('data-mobile-bar', admin ? 'floating' : 'inset')
    for (const style of ['floating', 'inset']) {
      await page.goto(settings)
      if (admin) {
        await avatar.press('Enter')
        await expect(page.getByRole('group', { name: '布局' })).toBeVisible()
        await expect(page.getByRole('link', { name: '运营管理' })).toHaveAttribute('href', '/delivery/tickets')
        await expect(page.getByRole('link', { name: '系统设置' })).toHaveAttribute('href', '/system/registration')
      }
      assert.match(await option(style).evaluate(el => getComputedStyle(el).transitionDuration), /^0(m?s)?$/)
      await choose(style)
      await verifyDock(style, entries, admin ? entries[0] : entries[3])
      await shell.evaluate(el => el.style.setProperty('--mobile-bar-safe-bottom', '34px'))
      await verifyDock(style, entries, admin ? entries[0] : entries[3], 34)
      await shell.evaluate(el => el.style.removeProperty('--mobile-bar-safe-bottom'))
      if (admin) {
        await page.keyboard.press('Escape')
        await expect(group).toBeHidden()
        await expect(avatar).toBeFocused()
      } else {
        await dock.getByRole('link', { name: '首页' }).click()
        await expect(page).toHaveURL(/\/home$/)
      }
      await page.reload()
      await expect(shell).toHaveAttribute('data-mobile-bar', style)
      await expect(page.getByText(admin ? '1284' : '未开通', { exact: true })).toBeVisible()

      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => localStorage.setItem('subpanel.theme', theme), theme)
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.getByText(admin ? '1284' : '未开通', { exact: true })).toBeVisible()
        await verifyDock(style, entries, entries[0])
        await page.screenshot({ path: join(output, `${role}-390-${style}-${theme}.png`), animations: 'disabled' })
      }
    }

    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(settings)
      if (admin) await page.locator('.sidebar .admin-account summary').click()
      await expect(group).toBeHidden()
      await expect(dock).toBeHidden()
    }
    await page.setViewportSize({ width: 390, height: 844 })
  }

  role = 'admin'
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/catalog/nodes')
  await page.evaluate(() => localStorage.setItem('subpanel.theme', 'light'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const section = main.locator('section[aria-labelledby="nodes-title"]')
  await expect(section.locator('tbody tr')).toHaveCount(20)
  const footer = section.locator('footer')
  for (const style of ['floating', 'inset']) {
    await avatar.press('Enter')
    await choose(style)
    await page.keyboard.press('Escape')
    await main.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(footer).toBeInViewport({ ratio: 1 })
    const [last, bar] = await Promise.all([footer.boundingBox(), dock.boundingBox()])
    assert(last.y + last.height <= bar.y, `${style} dock must leave the last line visible at 320px`)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
  await page.screenshot({ path: join(output, 'admin-320-inset-light.png'), animations: 'disabled' })

  await page.evaluate(key => localStorage.setItem(key, 'unknown'), key)
  await page.reload()
  await expect(shell).toHaveAttribute('data-mobile-bar', 'floating')
  console.log('Mobile bar persistence, geometry, focus, safe area, desktop visibility and screenshots passed')
} finally {
  await browser.close()
}
