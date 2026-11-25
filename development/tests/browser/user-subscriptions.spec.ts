import { expect, test, type Page } from '@playwright/test'

const adminPassword = 'correct horse battery staple'
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

  test('copies and imports the unified subscription, then rotates its public link', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4173' })
    await login(page, 'admin', adminPassword)
    await expect(page).toHaveURL(/\/dashboard$/)

    await post(page, '/api/admin/system/registration', { mode: 'invite' }, 'PUT')
    const inviteResult = await post(page, '/api/admin/invites', {})
    const inviteCode = String(inviteResult.invite.code)
    expect(inviteCode).toBeTruthy()
    const redeemed = await post(page, '/api/register', {
      username: 'unified-browser-user',
      password: userPassword,
      email: 'unified-browser-user@example.com',
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

    const { template } = await post(page, '/api/admin/subscription-templates', {
      name: 'Unified browser authorization',
      config: {
        groupIds: [groupId], nodeIds: [], duration: { value: 1, unit: 'month' },
        quotaBytes: null, resetPolicy: 'none', limits: { speedLimitMbps: 0 },
      },
    })
    await post(page, `/api/admin/users/${userId}/template-bindings/${template.id}`, {
      mode: 'assign', requestId: crypto.randomUUID(), expectedRevision: 0, expiry: { type: 'permanent' },
    }, 'PUT')

    await page.locator('.sidebar .admin-account summary').click()
    await page.getByRole('navigation', { name: '管理员账号菜单' }).getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await login(page, 'unified-browser-user', userPassword)
    await expect(page).toHaveURL(/\/home$/)
    await page.getByRole('link', { name: '订阅', exact: true }).click()
    await expect(page).toHaveURL(/\/subscriptions$/)
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect(page.getByRole('link', { name: '订阅', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('link', { name: '用户管理' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '我的', exact: true })).toBeVisible()
    const link = page.locator('.del-link-text')
    await expect(link).toHaveText(/\/s\/••••••••$/u)
    await page.getByRole('button', { name: '复制', exact: true }).click()
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
    await expect.poll(clipboard).toMatch(/\/s\/[\w-]{43}$/u)
    const originalLink = await clipboard()
    const download = (url: string) => page.request.get(`${new URL(url).pathname}/mihomo`)
    expect((await download(originalLink)).status()).toBe(200)
    await page.getByRole('button', { name: '导入客户端' }).click()
    await expect(page.getByRole('link', { name: 'Mihomo', exact: true })).toHaveAttribute('href', /^clash:\/\/install-config\?url=/)
    await page.keyboard.press('Escape')

    await page.getByText('更多', { exact: true }).click()
    await page.getByRole('button', { name: '重置链接', exact: true }).click()
    const resetDialog = page.getByRole('dialog', { name: '重置订阅链接' })
    await resetDialog.dispatchEvent('pointerdown')
    await expect(resetDialog).toBeVisible()
    await resetDialog.getByRole('button', { name: '重置', exact: true }).click()
    await expect(resetDialog).toBeHidden()
    await expect(link).toBeVisible()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(clipboard).not.toBe(originalLink)
    const rotated = await clipboard()
    expect((await download(originalLink)).status()).toBe(404)
    expect((await download(rotated)).status()).toBe(200)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
