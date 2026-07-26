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
    await expect.poll(() => page.evaluate(() => localStorage.getItem('subpanel.theme'))).toBe('light')

    await page.getByRole('button', { name: '主题' }).click()
    await page.getByRole('menuitem', { name: '跟随系统' }).click()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
  })

  test('initializes the administrator and completes the account security flow', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '初始化管理员' })).toBeVisible()
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill('correct horse battery staple')
    await page.getByRole('button', { name: '创建管理员' }).click()

    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码').fill('correct horse battery staple')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByText('监控', { exact: true })).toBeVisible()
    await expect(page.getByText('资源', { exact: true })).toBeVisible()
    await expect(page.getByText('交付与权限', { exact: true })).toBeVisible()
    await expect(page.locator('.workspace-topbar')).toHaveCSS('height', '60px')
    await page.getByRole('link', { name: '账户安全' }).click()
    await expect(page).toHaveURL(/\/account$/)
    await expect(page.locator('.workspace-topbar').getByText('admin', { exact: true })).toBeVisible()

    await page.getByLabel('当前密码').fill('correct horse battery staple')
    await page.getByLabel('新密码', { exact: true }).fill('new correct horse password')
    await page.getByLabel('确认新密码').fill('new correct horse password')
    await page.getByRole('button', { name: '更新密码' }).click()
    await expect(page.getByRole('status')).toContainText('密码已更新')

    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码').fill('new correct horse password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole('link', { name: '用户与邀请' }).click()
    await expect(page).toHaveURL(/\/users$/)
  })

  test('creates an invited user, hides administrator navigation from that user, and disables the account', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码').fill('new correct horse password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole('link', { name: '用户与邀请' }).click()
    await expect(page).toHaveURL(/\/users$/)

    await page.getByLabel('邀请用户名').fill('alice')
    await page.getByRole('button', { name: '创建邀请' }).click()
    const invitationLink = await page.getByLabel('邀请链接', { exact: true }).inputValue()
    expect(invitationLink).toContain('/invite/')

    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.goto(invitationLink)
    await expect(page.getByRole('heading', { name: '接受邀请' })).toBeVisible()
    await page.getByLabel('密码', { exact: true }).fill('alice correct password')
    await page.getByLabel('确认密码').fill('alice correct password')
    await page.getByRole('button', { name: '创建账户' }).click()

    await page.getByLabel('用户名', { exact: true }).fill('alice')
    await page.getByLabel('密码').fill('alice correct password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/subscriptions$/)
    await expect(page.getByRole('link', { name: '用户与邀请' })).toHaveCount(0)

    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码').fill('new correct horse password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole('link', { name: '用户与邀请' }).click()
    await expect(page).toHaveURL(/\/users$/)
    const aliceRow = page.getByRole('row', { name: /alice/ })
    await aliceRow.getByRole('button', { name: '重置 alice 的密码' }).click()
    const resetDialog = page.getByRole('dialog', { name: '重置用户密码' })
    await resetDialog.getByLabel('新密码', { exact: true }).fill('alice replacement password')
    await resetDialog.getByLabel('确认新密码').fill('alice replacement password')
    await resetDialog.getByRole('button', { name: '确认重置' }).click()
    await expect(page.getByRole('status')).toContainText('alice 的密码已重置')
    await aliceRow.getByRole('checkbox', { name: '启用 alice' }).uncheck()
    await expect(aliceRow.getByText('已停用')).toBeVisible()

    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('用户名', { exact: true }).fill('alice')
    await page.getByLabel('密码').fill('alice replacement password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByRole('alert')).toContainText('用户名或密码错误')
  })

  test('uses a drawer without horizontal page overflow on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码').fill('new correct horse password')
    await page.getByRole('button', { name: '登录' }).click()
    await page.getByRole('button', { name: '打开导航' }).click()
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: '关闭导航', exact: true }).click()
  })

  test('keeps both approved palettes above WCAG AA for primary text pairs', async ({ page }) => {
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
      light: { canvas: '#f3f6f5', surface: '#ffffff', text: '#17231f', muted: '#60706a', primary: '#08705f', contrast: '#ffffff' },
      dark: { canvas: '#101714', surface: '#17201d', text: '#e7efec', muted: '#9caaa5', primary: '#55bfa5', contrast: '#07110e' },
    } as const

    for (const preference of ['light', 'dark'] as const) {
      await page.goto('/login')
      await page.evaluate((value) => localStorage.setItem('subpanel.theme', value), preference)
      await page.reload()
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
    await page.getByLabel('密码').fill('new correct horse password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole('link', { name: '用户与邀请' }).click()
    await expect(page).toHaveURL(/\/users$/)
    await expect(page).toHaveTitle('SubPanel')
    await expect(page.getByRole('heading', { name: '用户与邀请' })).toBeVisible()
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
