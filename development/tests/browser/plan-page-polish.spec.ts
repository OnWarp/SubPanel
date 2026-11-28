import { expect, test, type Page } from '@playwright/test'

// Plan page UI polish: search input width / focus ring + sidebar toggle.
// Runs against a vite dev server on 4191 (SUBPANEL_EXTERNAL_SERVER=1).
test.use({ baseURL: 'http://127.0.0.1:4191' })

const adminPassword = 'correct horse battery staple'

async function loginAdmin(page: Page) {
  await page.goto('/')
  const setup = page.getByRole('heading', { name: '初始化管理员' })
  const loginForm = page.getByRole('button', { name: '登录', exact: true })
  await expect(setup.or(loginForm)).toBeVisible()
  if (await setup.isVisible()) {
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill(adminPassword)
    await page.getByLabel('初始化密钥').fill(process.env.BOOTSTRAP_SECRET!)
    await page.getByRole('button', { name: '创建管理员' }).click()
    await expect(page).toHaveURL(/\/login$/)
  }
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(adminPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const pick = (sel: string) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, right: r.right, left: r.left }
    }
    const search = document.querySelector('.sp-search') as HTMLElement | null
    const input = search?.querySelector('input') as HTMLElement | null
    const cs = search ? getComputedStyle(search) : null
    return {
      viewport: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      contentPage: pick('.content-page'),
      filterBar: pick('.sp-filter-bar'),
      search: pick('.sp-search'),
      searchBorder: cs?.border,
      searchBoxShadow: cs?.boxShadow,
      searchOutline: input ? getComputedStyle(input).outline : null,
      inputBoxShadow: input ? getComputedStyle(input).boxShadow : null,
      inputBorder: input ? getComputedStyle(input).border : null,
      table: pick('.sp-table-wrap, table, .data-table, [class*="table"]'),
      toggle: pick('.sidebar-toggle'),
      toggleSize: (() => {
        const el = document.querySelector('.sidebar-toggle')
        if (!el) return null
        const r = el.getBoundingClientRect()
        const cs2 = getComputedStyle(el)
        return { w: r.width, h: r.height, bg: cs2.backgroundColor, border: cs2.border, color: cs2.color }
      })(),
    }
  })
}

test.describe('plan page polish', () => {
  test('desktop: search aligns with table, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await loginAdmin(page)
    await page.goto('/plans')
    await expect(page.getByRole('heading', { name: '套餐管理', exact: true })).toBeVisible()
    const before = await measure(page)
    console.log('DESKTOP BEFORE-FOCUS ' + JSON.stringify(before))
    // Search box must not stick out past the content column / table.
    expect(before.docScrollWidth).toBeLessThanOrEqual(before.viewport)
    if (before.search && before.contentPage) {
      expect(before.search.right).toBeLessThanOrEqual(before.contentPage.right + 1)
      expect(before.search.left).toBeGreaterThanOrEqual(before.contentPage.left - 1)
      // Page-scoped cap: the search no longer spans the whole column.
      expect(before.search.width).toBeLessThanOrEqual(361)
    }
    if (before.search && before.table) {
      expect(before.search.right).toBeLessThanOrEqual(before.table.right + 1)
    }
    await page.getByLabel('搜索套餐').click()
    await page.waitForTimeout(200)
    const focused = await measure(page)
    console.log('DESKTOP FOCUSED ' + JSON.stringify(focused))
    expect(focused.docScrollWidth).toBeLessThanOrEqual(focused.viewport)
    if (focused.search && focused.contentPage) {
      expect(focused.search.right).toBeLessThanOrEqual(focused.contentPage.right + 1)
    }
    // Single focus frame, kept inside the box: no inner input outline, and
    // the wrapper ring is inset rather than painting past the edge.
    expect(focused.searchOutline).toMatch(/^0px/)
    expect(focused.searchBoxShadow).toContain('inset')
    await page.screenshot({ path: 'development/screenshots/plan-polish-desktop.png' })
    // Sidebar toggle: visible, real hit area, state readable.
    const toggle = page.locator('.sidebar-toggle')
    await expect(toggle).toBeVisible()
    const box = await toggle.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(32)
    expect(box!.height).toBeGreaterThanOrEqual(32)
    await expect(toggle).toHaveAttribute('aria-label', '收起侧栏')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-label', '展开侧栏')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.app-layout.sidebar-collapsed')).toHaveCount(1)
    // Collapsed state is tinted, not just a flipped chevron.
    const collapsedBg = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(collapsedBg).not.toBe('rgba(0, 0, 0, 0)')
    await page.screenshot({ path: 'development/screenshots/plan-polish-desktop-collapsed.png' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-label', '收起侧栏')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  test('wide 1600 collapsed sidebar: search still aligns with table', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await loginAdmin(page)
    await page.goto('/plans')
    await expect(page.getByRole('heading', { name: '套餐管理', exact: true })).toBeVisible()
    const expanded = await measure(page)
    console.log('WIDE EXPANDED ' + JSON.stringify(expanded))
    if (expanded.search && expanded.table) {
      expect(expanded.search.right).toBeLessThanOrEqual(expanded.table.right + 1)
      expect(expanded.search.width).toBeLessThanOrEqual(361)
    }
    await page.locator('.sidebar-toggle').click()
    await expect(page.locator('.app-layout.sidebar-collapsed')).toHaveCount(1)
    const collapsed = await measure(page)
    console.log('WIDE COLLAPSED ' + JSON.stringify(collapsed))
    expect(collapsed.docScrollWidth).toBeLessThanOrEqual(collapsed.viewport)
    if (collapsed.search && collapsed.table) {
      expect(collapsed.search.right).toBeLessThanOrEqual(collapsed.table.right + 1)
      expect(collapsed.search.left).toBeGreaterThanOrEqual(collapsed.table.left - 1)
    }
    await page.screenshot({ path: 'development/screenshots/plan-polish-wide-collapsed.png' })
  })

  test('mobile 390: search fits, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAdmin(page)
    await page.goto('/plans')
    await expect(page.getByRole('heading', { name: '套餐管理', exact: true })).toBeVisible()
    const m = await measure(page)
    console.log('MOBILE ' + JSON.stringify(m))
    expect(m.docScrollWidth).toBeLessThanOrEqual(m.viewport)
    if (m.search && m.contentPage) {
      expect(m.search.right).toBeLessThanOrEqual(m.contentPage.right + 1)
      // At 390px the 360px cap yields to the column: search is full width.
      expect(m.search.width).toBeGreaterThanOrEqual(m.contentPage.width - 1)
    }
    await page.getByLabel('搜索套餐').click()
    await page.waitForTimeout(200)
    const f = await measure(page)
    expect(f.docScrollWidth).toBeLessThanOrEqual(f.viewport)
    await page.screenshot({ path: 'development/screenshots/plan-polish-mobile.png' })
  })
})
