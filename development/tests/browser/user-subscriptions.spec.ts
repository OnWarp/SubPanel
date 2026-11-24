import { expect, test, type Page } from '@playwright/test'

const adminPassword = 'admin user password 123456'
const userPassword = 'alice user password 123456'
const nodeLine = `ss://${btoa('aes-128-gcm:password')}@user.example.com:8388#UserNode`

test.describe.serial('Ordinary user subscription workspace', () => {
  async function login(page: Page, username: string, password: string) {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录' }).click()
  }

  async function post(page: Page, path: string, data: Record<string, unknown>, method: 'POST' | 'PUT' = 'POST') {
    const result = await page.evaluate(async ({ method, path, data }) => {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      return { ok: response.ok, status: response.status, body: await response.text() }
    }, { method, path, data })
    expect(result.ok, `${method} ${path} returned ${result.status} ${result.body}`).toBe(true)
    return (result.body ? JSON.parse(result.body) : {}) as Record<string, any>
  }

  test('switches subscriptions, copies the link, shows a QR code and resets a token', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4173' })
    await page.goto('/')
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill(adminPassword)
    await page.getByRole('button', { name: '创建管理员' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await login(page, 'admin', adminPassword)
    await expect(page).toHaveURL(/\/dashboard$/)

    await post(page, '/api/admin/system/registration', { mode: 'invite' }, 'PUT')
    const inviteResult = await post(page, '/api/admin/invites', {})
    const inviteCode = String(inviteResult.invite.code)
    expect(inviteCode).toBeTruthy()
    const redeemed = await post(page, '/api/register', {
      username: 'alice',
      password: userPassword,
      email: 'alice@example.com',
      inviteCode,
    })
    const userId = String(redeemed.user.id)
    await post(page, '/api/login', { username: 'admin', password: adminPassword })

    const sourceResult = await post(page, '/api/admin/catalog/sources', {
      type: 'manual',
      name: 'User source',
      content: nodeLine,
    })
    const sourceId = String(sourceResult.source.id)
    const groupResult = await post(page, '/api/admin/catalog/groups', {
      name: 'User group',
      sourceIds: [sourceId],
      includedNodeIds: [],
      excludedNodeIds: [],
      nodeOrder: [],
    })
    const groupId = String(groupResult.group.id)

    await post(page, '/api/admin/subscriptions', {
      userId,
      name: '主订阅',
      groupIds: [groupId],
      defaultClient: 'mihomo',
      enabled: true,
    })
    await post(page, '/api/admin/subscriptions', {
      userId,
      name: '备用订阅',
      groupIds: [groupId],
      defaultClient: 'singbox',
      enabled: true,
    })

    await page.locator('.sidebar .admin-account summary').click()
    await page.getByRole('navigation', { name: '管理员账号菜单' }).getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await login(page, 'alice', userPassword)
    await expect(page).toHaveURL(/\/home$/)
    await page.getByRole('link', { name: '订阅', exact: true }).click()
    await expect(page).toHaveURL(/\/subscriptions$/)
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect(page.getByRole('link', { name: '订阅', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('link', { name: '用户管理' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '我的', exact: true })).toBeVisible()
    const link = page.locator('.del-link-text')
    const originalLink = (await link.textContent())?.trim() ?? ''
    expect(originalLink.startsWith('https://')).toBe(true)
    const overview = page.locator('.user-subscription-overview')
    const beforeCopy = await overview.boundingBox()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    const afterCopy = await overview.boundingBox()
    expect(afterCopy?.y).toBe(beforeCopy?.y)
    await expect(page.getByRole('img', { name: '订阅二维码' })).toBeVisible()
    await expect(link).toHaveText(/\/sub\/[^/]+$/)
    await expect(page.getByRole('link', { name: 'Mihomo', exact: true })).toHaveAttribute('href', /^clash:\/\/install-config\?url=/)

    const diagnostics = page.locator('details').filter({ hasText: '兼容诊断' })
    await expect(diagnostics).not.toHaveAttribute('open', '')
    await diagnostics.getByText('兼容诊断', { exact: true }).click()
    await expect(diagnostics).toHaveAttribute('open', '')
    await expect(page.getByText('已跳过表示该节点未输出；节点仍会输出表示仅列出的字段未能映射，相关能力可能失效')).toBeVisible()
    await expect(page.getByText('输入 0 · 输出 0 · 跳过 0').first()).toBeVisible()

    await page.getByRole('combobox', { name: '选择订阅' }).click()
    await page.getByRole('option', { name: '备用订阅', exact: true }).click()
    await expect(page.getByRole('heading', { name: '备用订阅' })).toBeVisible()
    await expect(link).toHaveText(/\/sub\/[^/]+$/)
    await expect(page.getByRole('link', { name: 'Mihomo', exact: true })).toHaveAttribute('href', /^clash:\/\/install-config\?url=/)
    const beforeReset = (await link.textContent())?.trim() ?? ''
    expect(beforeReset.startsWith('https://')).toBe(true)
    expect(beforeReset).not.toBe(originalLink)

    await page.getByRole('button', { name: '重置订阅令牌' }).click()
    const resetDialog = page.getByRole('dialog', { name: '重置订阅令牌' })
    await expect(resetDialog).toBeVisible()
    await resetDialog.dispatchEvent('pointerdown')
    await expect(resetDialog).toBeVisible()
    await resetDialog.getByRole('button', { name: '确认重置' }).click()
    await expect(page.getByRole('status').filter({ hasText: '订阅令牌已重置' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '新订阅令牌' })).toBeVisible()
    await expect(link).not.toHaveText(beforeReset)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
