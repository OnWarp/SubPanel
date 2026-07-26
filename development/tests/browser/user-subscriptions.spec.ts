import { expect, test, type Page } from '@playwright/test'

const adminPassword = 'admin user password 123456'
const userPassword = 'alice user password 123456'
const nodeLine = `ss://${btoa('aes-128-gcm:password')}@user.example.com:8388#UserNode`

test.describe.serial('Ordinary user subscription workspace', () => {
  async function login(page: Page, username: string, password: string) {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: '登录' }).click()
  }

  async function post(page: Page, path: string, data: Record<string, unknown>) {
    const response = await page.request.post(path, {
      data,
      headers: { Origin: 'http://127.0.0.1:4173' },
    })
    expect(response.ok(), `${path} returned ${response.status()}`).toBe(true)
    return response.json() as Promise<Record<string, any>>
  }

  test('switches subscriptions, copies links, shows QR and resets a token', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4173' })
    await page.goto('/')
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill(adminPassword)
    await page.getByRole('button', { name: '创建管理员' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await login(page, 'admin', adminPassword)
    await expect(page).toHaveURL(/\/dashboard$/)

    const inviteResult = await post(page, '/api/admin/invites', { username: 'alice' })
    const inviteLink = String(inviteResult.invite.link)
    const inviteToken = new URL(inviteLink).pathname.split('/').pop()
    expect(inviteToken).toBeTruthy()
    const redeemed = await post(page, `/api/invites/${inviteToken}`, { password: userPassword })
    const userId = String(redeemed.user.id)

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

    await page.getByRole('button', { name: '退出登录' }).click()
    await login(page, 'alice', userPassword)
    await expect(page).toHaveURL(/\/subscriptions$/)
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect(page.getByRole('link', { name: '我的订阅' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('link', { name: '用户与邀请' })).toHaveCount(0)
    await expect(page.getByText('输入 1 · 输出 1 · 跳过 0').first()).toBeVisible()
    const automaticLink = page.getByRole('textbox', { name: '自动订阅链接' })
    const originalLink = await automaticLink.inputValue()
    const overview = page.locator('.user-subscription-overview')
    const beforeCopy = await overview.boundingBox()
    await page.getByRole('button', { name: '复制自动订阅链接' }).click()
    await expect(page.getByRole('status')).toContainText('链接已复制')
    const afterCopy = await overview.boundingBox()
    expect(afterCopy?.y).toBe(beforeCopy?.y)

    const diagnostics = page.locator('details').filter({ hasText: '兼容诊断' })
    await expect(diagnostics).toHaveAttribute('open', '')
    await diagnostics.getByText('兼容诊断', { exact: true }).click()
    await expect(diagnostics).not.toHaveAttribute('open', '')

    await page.getByLabel('选择订阅').selectOption({ label: '备用订阅' })
    await expect(page.getByRole('heading', { name: '备用订阅' })).toBeVisible()
    await expect(page.getByLabel('客户端链接').getByText('sing-box')).toBeVisible()
    await page.getByRole('button', { name: '显示 sing-box 二维码' }).click()
    const qrDialog = page.getByRole('dialog', { name: 'sing-box 二维码' })
    await expect(qrDialog).toBeVisible()
    await expect(qrDialog.getByRole('img', { name: 'sing-box 订阅二维码' })).toBeVisible()
    await qrDialog.dispatchEvent('pointerdown')
    await expect(qrDialog).toBeVisible()
    await qrDialog.getByRole('button', { name: '关闭' }).click()

    await page.getByRole('button', { name: '重置订阅令牌' }).click()
    const resetDialog = page.getByRole('dialog', { name: '重置订阅令牌' })
    await expect(resetDialog).toBeVisible()
    await resetDialog.dispatchEvent('pointerdown')
    await expect(resetDialog).toBeVisible()
    await resetDialog.getByRole('button', { name: '确认重置' }).click()
    await expect(page.getByRole('status')).toContainText('订阅令牌已重置')
    await expect(page.getByRole('textbox', { name: '新订阅令牌' })).toBeVisible()
    await expect(automaticLink.inputValue()).not.toBe(originalLink)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
