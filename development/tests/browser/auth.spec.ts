import { expect, test } from '@playwright/test'

test.describe.serial('SubPanel account shell', () => {
  test('applies system theme before the app renders and persists a manual choice', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: '主题' })).toBeVisible()

    await page.getByRole('button', { name: '主题' }).click()
    await page.getByRole('menuitem', { name: '浅色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect.poll(() => page.evaluate(() => localStorage.getItem(window.subpanelTheme.guestKey))).toBe('light')

    await page.getByRole('button', { name: '主题' }).click()
    await page.getByRole('menuitem', { name: '跟随系统' }).click()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
  })

  test('signs in and completes the account security flow', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('correct horse battery staple')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveText(['概览', '节点管理', '套餐管理', '用户管理', '运营管理', '系统设置'])
    await expect(page.locator('.workspace-topbar')).toHaveCSS('height', '48px')
    await page.locator('.sidebar').getByLabel('admin，管理员账号菜单').click()
    await page.getByRole('link', { name: '账户安全' }).click()
    await expect(page).toHaveURL(/\/account$/)
    await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible()

    await page.getByRole('button', { name: '修改密码' }).click()
    await page.getByLabel('当前密码').fill('correct horse battery staple')
    await page.getByLabel('新密码', { exact: true }).fill('new correct horse password')
    await page.getByLabel('确认新密码').fill('new correct horse password')
    await page.getByRole('button', { name: '更新密码' }).click()
    await expect(page.getByRole('status')).toContainText('密码已更新')

    await page.locator('.sidebar').getByLabel('admin，管理员账号菜单').click()
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('new correct horse password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    const restored = await page.request.post('/api/account/password', {
      headers: { origin: new URL(page.url()).origin },
      data: { currentPassword: 'new correct horse password', newPassword: 'correct horse battery staple' },
    })
    expect(restored.ok()).toBe(true)
    await page.getByRole('link', { name: '用户管理' }).click()
    await expect(page).toHaveURL(/\/users$/)
  })

  test('creates an invited user, hides administrator navigation from that user, and disables the account', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('correct horse battery staple')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole('link', { name: '用户管理' }).click()
    await expect(page).toHaveURL(/\/users$/)

    const origin = new URL(page.url()).origin
    const api = (path: string, data: unknown, method = 'POST') =>
      page.request.fetch(path, { method, data, headers: { origin } })
    expect((await api('/api/admin/system/registration', { mode: 'invite' }, 'PUT')).ok()).toBe(true)
    const invite = await api('/api/admin/invites', {})
    expect(invite.status()).toBe(201)
    const { invite: { code } } = await invite.json()
    const password = 'invited browser user password'
    const registered = await api('/api/register', {
      username: 'invited-browser-user', password, email: 'invited-browser-user@example.com', inviteCode: code,
    })
    expect(registered.status()).toBe(201)
    const { user } = await registered.json()
    await page.goto('/home')
    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByRole('link', { name: '用户管理' })).toHaveCount(0)

    expect((await api('/api/login', { username: 'admin', password: 'correct horse battery staple' })).ok()).toBe(true)
    await page.goto('/users')
    const row = page.getByRole('row', { name: /invited-browser-user/u })
    await row.getByLabel('invited-browser-user 的操作').click()
    await row.getByRole('menuitem', { name: '停用' }).click()
    await expect(row.getByText('已停用')).toBeVisible()
    expect((await api('/api/login', { username: user.username, password })).status()).toBe(401)
  })

  test('shows four admin dock entries on a phone without horizontal page overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('correct horse battery staple')
    await page.getByRole('button', { name: '登录' }).click()
    const dock = page.locator('.admin-mobile-dock')
    await expect(dock.getByRole('link')).toHaveText(['概览', '节点管理', '套餐管理', '用户管理'])
    await expect(page.getByRole('button', { name: '更多', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '更多导航' })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('keeps both theme palettes above WCAG AA for primary text pairs', async ({ page }) => {
    const contrast = (foreground: string, background: string) => {
      const rgb = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      const luminance = (hex: string) => {
        const [red, green, blue] = rgb(hex).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
      }
      const [bright, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
      return (bright + 0.05) / (dark + 0.05)
    }

    const expected = {
      light: { canvas: '#f5f5f7', surface: '#ffffff', text: '#1d1d1f', muted: '#6e6e73', primary: '#0071e3', contrast: '#ffffff' },
      dark: { canvas: '#08090a', surface: '#0f1011', text: '#f7f8f8', muted: '#8a8f98', primary: '#5e6ad2', contrast: '#ffffff' },
    } as const

    for (const preference of ['light', 'dark'] as const) {
      await page.goto('/login')
      await page.evaluate((value) => localStorage.setItem(window.subpanelTheme.guestKey, value), preference)
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-theme', preference)
      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        const read = (name: string) => style.getPropertyValue(name).trim().toLowerCase()
        return {
          canvas: read('--color-canvas'),
          surface: read('--color-surface'),
          text: read('--color-text'),
          muted: read('--color-text-muted'),
          primary: read('--color-primary'),
          contrast: read('--color-primary-contrast'),
        }
      })
      expect(colors).toEqual(expected[preference])
      expect(contrast(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors.muted, colors.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors.contrast, colors.primary)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('renders the authenticated shell without browser errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))

    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('correct horse battery staple')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole('link', { name: '用户管理' }).click()
    await expect(page).toHaveURL(/\/users$/)
    await expect(page).toHaveTitle('SubPanel')
    await expect(page.locator('.workspace-topbar').getByRole('heading', { name: '用户管理' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('does not turn a bootstrap failure into the first-run setup screen', async ({ page }) => {
    await page.route('**/api/bootstrap', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'HEALTH_STATE_INVALID', message: '服务暂时不可用' } }),
    }))
    await page.goto('/')
    await expect(page.getByRole('alert')).toContainText('服务暂时不可用')
    await expect(page.getByRole('heading', { name: '初始化管理员' })).toHaveCount(0)
  })
})
