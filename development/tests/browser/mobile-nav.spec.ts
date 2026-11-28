import { expect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test.use({ viewport: { width: 390, height: 844 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } })

const adminPassword = 'correct horse battery staple'
const userPassword = 'mobile nav user password'
const adminEntries = [
  ['概览', '/dashboard'],
  ['节点管理', '/catalog/nodes'],
  ['套餐管理', '/plans'],
  ['用户管理', '/users'],
] as const
const adminDock = (page: Page) => page.getByRole('navigation', { name: '主导航', exact: true })
const dockLink = (dock: Locator, name: string) => dock.getByRole('link', { name, exact: true })

async function login(page: Page, username: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

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
  await login(page, 'admin', adminPassword)
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function expectPill(element: Locator, label: string) {
  await expect(element).toBeVisible()
  const rounded = await element.evaluate((node) => {
    const { height, width } = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const minimumRadius = Math.min(height, width) / 2
    const pixels = (value: string, size: number) =>
      value.endsWith('%') ? Number.parseFloat(value) * size / 100 : Number.parseFloat(value)
    return [
      style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomLeftRadius, style.borderBottomRightRadius,
    ].every((corner) => {
      const [horizontal, vertical = horizontal] = corner.split(/\s+/)
      return pixels(horizontal, width) >= minimumRadius && pixels(vertical, height) >= minimumRadius
    })
  })
  expect.soft(rounded, `${label} has four fully rounded corners`).toBe(true)
}

async function expectFloatingDock(dock: Locator) {
  await expect(dock).toBeVisible()
  const layout = await dock.evaluate((node) => {
    const { left, right, bottom } = node.getBoundingClientRect()
    const links = Array.from(node.querySelectorAll('a'), (link) => link.getBoundingClientRect())
    return {
      left, right: innerWidth - right, bottom: innerHeight - bottom,
      verticalOverlap: Math.min(...links.map((link) => link.bottom)) - Math.max(...links.map((link) => link.top)),
    }
  })
  expect.soft(layout.left, 'left viewport gap').toBeGreaterThan(0)
  expect.soft(layout.right, 'right viewport gap').toBeGreaterThan(0)
  expect.soft(layout.bottom, 'bottom viewport gap').toBeGreaterThan(0)
  expect.soft(layout.verticalOverlap, 'navigation links share one row').toBeGreaterThan(0)
  await expect(dock).toHaveCSS('position', 'fixed')
  await expectPill(dock, 'dock')
}

async function expectActivePill(dock: Locator, label: string, admin = false) {
  const active = dockLink(dock, label)
  await expect(active).toHaveAttribute('aria-current', admin ? 'location' : 'page')
  await expect(dock.getByRole('link').and(dock.locator('[aria-current]'))).toHaveCount(1)
  const fill = await active.evaluate((element) => {
    const color = getComputedStyle(element).backgroundColor
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return { color, alpha: context.getImageData(0, 0, 1, 1).data[3] }
  })
  expect.soft(fill.alpha, 'selected background is opaque').toBe(255)
  const inactive = await dock.getByRole('link').evaluateAll((links) =>
    links.filter((link) => !link.hasAttribute('aria-current'))
      .map((link) => getComputedStyle(link).backgroundColor))
  expect.soft(inactive, 'unselected links have a different background').not.toContain(fill.color)
  if (admin) {
    await expect.soft(active).toHaveCSS('background-color', 'rgb(94, 106, 210)')
    await expect.soft(active).toHaveCSS('color', 'rgb(255, 255, 255)')
  }
  await expectPill(active, 'selected item')
}

async function openAdminMenu(page: Page) {
  const topbar = page.locator('.workspace-topbar')
  await topbar.locator('.admin-account summary').click()
  const menu = topbar.getByRole('navigation', { name: '管理员账号菜单' })
  await expect(menu).toBeVisible()
  return menu
}

test.describe('Administrator mobile navigation', () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page)
  })

  test('shows exactly four bottom links in order', async ({ page }) => {
    const dock = adminDock(page)
    await expect(dock.getByRole('link')).toHaveText(adminEntries.map(([label]) => label))
  })

  for (const [label, path] of adminEntries) {
    test(`opens ${path} from ${label}`, async ({ page }) => {
      // Start on a different route so a link that fails to navigate cannot pass.
      if (path === '/dashboard') await page.goto('/catalog/nodes')
      const dock = adminDock(page)
      await dockLink(dock, label).click()
      await expect(page).toHaveURL((url) => url.pathname === path && !url.search && !url.hash)
      await expect(dockLink(dock, label)).toHaveAttribute('aria-current', path === '/dashboard' ? 'page' : 'location')
    })
  }

  test('floats above the viewport edges in one fully rounded row', async ({ page }) => {
    await expectFloatingDock(adminDock(page))
  })

  test('uses the solid indigo and white active pill on the current domain', async ({ page }) => {
    const dock = adminDock(page)
    await dockLink(dock, '节点管理').click()
    await expect(page).toHaveURL(/\/catalog\/nodes$/)
    await expectActivePill(dock, '节点管理', true)
  })

  test('keeps the five navigation and account actions in the topbar avatar menu', async ({ page }) => {
    const menu = await openAdminMenu(page)
    const entries = menu.locator(':scope > a, :scope > button, :scope > .theme-control > button')
    await expect.soft(entries).toHaveCount(5)
    for (const name of ['运营管理', '系统设置', '账户安全', '外观', '退出登录']) {
      await expect.soft(menu.getByRole('link', { name, exact: true })
        .or(menu.getByRole('button', { name, exact: true })), name).toBeVisible()
    }
  })

  for (const [label, path] of [['运营管理', '/delivery/tickets'], ['系统设置', '/system/registration']]) {
    test(`opens ${path} from the topbar avatar menu`, async ({ page }) => {
      const menu = await openAdminMenu(page)
      const entry = menu.getByRole('link', { name: label, exact: true })
      await expect(entry).toBeVisible()
      await entry.click()
      await expect(page).toHaveURL((url) => url.pathname === path && !url.search && !url.hash)
    })
  }

  test('keeps the final line of a long page fully above the dock at scroll end', async ({ page }) => {
    const now = new Date().toISOString()
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `mobile-node-${index}`, protocol: 'ss', displayName: `Mobile node ${index + 1}`,
      server: `node-${index + 1}.example.com`, port: 8388, sourceIds: [],
      enabled: true, retained: false, order: index, updatedAt: now, createdAt: now,
    }))
    await page.route('**/api/admin/catalog', (route) => route.fulfill({
      json: { schemaVersion: 2, revision: 1, updatedAt: now, sources: [], nodes, groups: [] },
    }))
    await page.goto('/catalog/nodes')
    const main = page.getByRole('main')
    const section = main.locator('section[aria-labelledby="nodes-title"]')
    await expect(section.locator('tbody tr')).toHaveCount(20)
    const lastLine = section.locator('footer')
    await expect(lastLine).toBeVisible()
    const dock = adminDock(page)
    await expect(dock).toBeVisible()

    const before = await lastLine.boundingBox()
    const dockBefore = await dock.boundingBox()
    expect(before!.y, 'fixture starts with its footer below the dock').toBeGreaterThan(dockBefore!.y)

    await main.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      window.scrollTo(0, document.documentElement.scrollHeight)
    })
    await expect(lastLine).toBeInViewport({ ratio: 1 })
    const footerBox = await lastLine.boundingBox()
    const dockBox = await dock.boundingBox()
    expect(footerBox!.y + footerBox!.height, 'footer bottom above dock top').toBeLessThanOrEqual(dockBox!.y)
  })
})

test('ordinary user has four floating links and a solid selected pill', async ({ page, browser, baseURL }) => {
  await loginAdmin(page)
  const headers = { Origin: new URL(baseURL!).origin }
  // Current registration flow: an invite code is only a qualification.
  // The administrator enables invite registration and issues a code, then
  // the user registers through /api/register with their own username,
  // password and email. The legacy redemption endpoint
  // (POST /api/invites/:token) no longer creates accounts and returns 410.
  const mode = await page.request.put('/api/admin/system/registration', {
    headers, data: { mode: 'invite' },
  })
  expect(mode.ok()).toBe(true)
  const invitations = await page.request.post('/api/admin/invitations', {
    headers, data: { type: 'batch', count: 1 },
  })
  expect(invitations.ok()).toBe(true)
  const inviteCode = (await invitations.json()).invitations[0].code as string
  expect(inviteCode).toBeTruthy()

  const username = `mobile-nav-${randomUUID().slice(0, 8)}`
  const userPage = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' })
  try {
    const registered = await userPage.request.post('/api/register', {
      headers,
      data: {
        username,
        password: userPassword,
        email: `${username}@example.com`,
        inviteCode,
      },
    })
    expect(registered.status()).toBe(201)
    // Registration signs the new user in immediately; drop that session so
    // the explicit UI login below starts signed out, as the old flow did.
    await userPage.context().clearCookies()
    await login(userPage, username, userPassword)
    await expect(userPage).toHaveURL(/\/home$/)
    const dock = userPage.getByRole('navigation', { name: '快捷导航', exact: true })
    await expect.soft(dock.getByRole('link')).toHaveText(['首页', '订阅', '节点', '我的'])
    await expectFloatingDock(dock)
    await dockLink(dock, '订阅').click()
    await expect(userPage).toHaveURL(/\/subscriptions$/)
    await expectActivePill(dock, '订阅')
  } finally {
    await userPage.close()
  }
})
