import { expect, test, type Page } from '@playwright/test'

const adminPassword = 'correct horse battery staple'
const userPassword = 'phase6 member password 123456'
const userEmail = 'phase6-member@example.com'
const planName = '阶段六套餐'

// Reports whether a plan's expiry boundary reads the same way in the UI and in
// the API: the card must never call a not-yet-started grant active and must
// never present an expired one as valid.
async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function adminApi(page: Page, path: string, data?: unknown, method = 'POST') {
  const origin = new URL(page.url()).origin
  const response = await page.request.fetch(`/api/admin${path}`, {
    method, data, headers: { origin, 'content-type': 'application/json' },
  })
  expect(response.ok(), `${method} ${path} -> ${response.status()}`).toBe(true)
  return response.status() === 204 ? null : response.json()
}

test.describe.serial('Phase 6 user plans', () => {
  let instanceId = ''
  let redeemCode = ''

  async function login(page: Page, username: string, password: string) {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }

  test('prepares an admin, a member, a plan and a redeem code', async ({ page }) => {
    await page.goto('/')
    const setup = page.getByRole('heading', { name: '初始化管理员' })
    const loginButton = page.getByRole('button', { name: '登录', exact: true })
    await expect(setup.or(loginButton)).toBeVisible()
    if (await setup.isVisible()) {
      await page.getByLabel('管理员用户名').fill('Admin')
      await page.getByLabel('管理员密码').fill(adminPassword)
      await page.getByLabel('初始化密钥').fill(process.env.BOOTSTRAP_SECRET!)
      await page.getByRole('button', { name: '创建管理员' }).click()
      await expect(page).toHaveURL(/\/login$/)
    }
    await login(page, 'admin', adminPassword)
    await expect(page).toHaveURL(/\/dashboard$/)

    await adminApi(page, '/system/registration', { mode: 'invite' }, 'PUT')
    const invite = await adminApi(page, '/invites', {}) as { invite: { code: string } }
    const origin = new URL(page.url()).origin
    const registered = await page.request.post('/api/register', {
      headers: { origin, 'content-type': 'application/json' },
      data: { username: 'phase6-member', password: userPassword, email: userEmail, inviteCode: invite.invite.code },
    })
    expect(registered.ok(), `register -> ${registered.status()} ${await registered.text()}`).toBe(true)
    // Registration signs the new member in, so restore the administrator
    // session before the admin-only setup calls.
    expect((await page.request.post('/api/login', {
      headers: { origin, 'content-type': 'application/json' },
      data: { username: 'admin', password: adminPassword },
    })).ok()).toBe(true)

    const source = await adminApi(page, '/catalog/sources', {
      name: 'Phase 6 source', type: 'manual',
      content: `ss://${btoa('aes-128-gcm:fixture')}@p6.example.com:8388#P6Node`,
    }) as { source: { id: string } }
    const groups = await adminApi(page, '/catalog/groups', {
      name: '阶段六节点组', sourceIds: [source.source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
    }) as { group: { id: string } }
    const { plan } = await adminApi(page, '/plans', {
      name: planName, description: '阶段六个人中心套餐', nodeGroupIds: [groups.group.id],
      durationSeconds: 30 * 86400, enabled: true, remark: null,
    }) as { plan: { id: string } }
    const generated = await adminApi(page, '/redeem-codes', {
      planId: plan.id, quantity: 1, maxUses: 1, perUserLimit: 1, durationMode: 'snapshot',
    }) as { codes: Array<{ code: string }> }
    redeemCode = generated.codes[0].code
    expect(redeemCode).toMatch(/^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){2}$/u)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`renders the empty personal center at 390px and desktop in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ colorScheme: theme })
      await login(page, 'phase6-member', userPassword)
      await expect(page).toHaveURL(/\/home$/)
      await page.goto('/me')
      await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible()
      await expect(page.getByRole('region', { name: '套餐概览' })).toBeVisible()
      await expect(page.getByRole('link', { name: /我的套餐/u })).toBeVisible()
      // No plan yet: the card says 暂无套餐 and the settings list still works.
      await expect(page.getByRole('region', { name: '套餐概览' }).getByText('暂无套餐').first()).toBeVisible()
      await expect(page.getByRole('navigation', { name: '设置' })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expectNoHorizontalOverflow(page)

      await page.getByRole('link', { name: /我的套餐/u }).click()
      await expect(page).toHaveURL(/\/me\/plans$/)
      await expect(page.getByRole('heading', { name: '我的套餐' })).toBeVisible()
      await expect(page.getByRole('button', { name: /兑换套餐/u }).first()).toBeVisible()
      await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByText('暂无套餐', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: /兑换套餐/u })).toHaveCount(2)
      await expectNoHorizontalOverflow(page)

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.reload()
      await expect(page.getByRole('heading', { name: '我的套餐' })).toBeVisible()
      await expectNoHorizontalOverflow(page)
    })
  }

  test('redeems a plan and shows the instance on /me and /me/plans', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page, 'phase6-member', userPassword)
    await expect(page).toHaveURL(/\/home$/)

    await page.goto('/me/plans')
    await page.getByRole('button', { name: /兑换套餐/u }).first().click()
    const dialog = page.getByRole('dialog', { name: '兑换套餐' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('兑换码').fill(redeemCode)
    await dialog.getByRole('button', { name: '兑换', exact: true }).click()
    await expect(dialog.getByText('兑换成功')).toBeVisible()
    await expect(dialog.getByText(planName)).toBeVisible()
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(dialog).toBeHidden()

    // The list refreshed to include the new instance.
    const card = page.getByRole('link', { name: new RegExp(`${planName} 有效`, 'u') })
    await expect(card).toBeVisible()
    const stats = page.locator('.upd-plans-stats')
    await expect(stats.locator('div').filter({ hasText: '有效套餐' }).locator('dd')).toHaveText('1')
    await expect(stats.locator('div').filter({ hasText: '全部套餐' }).locator('dd')).toHaveText('1')
    await expectNoHorizontalOverflow(page)

    await card.click()
    await expect(page).toHaveURL(/\/me\/plans\/[^/]+$/)
    instanceId = new URL(page.url()).pathname.split('/').pop()!
    await expect(page.getByRole('heading', { name: planName })).toBeVisible()
    await expect(page.getByText('包含节点组 (1)')).toBeVisible()
    await expect(page.getByRole('link', { name: /查看此套餐订阅/u })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.getByRole('link', { name: /查看此套餐订阅/u }).click()
    await expect(page).toHaveURL(new RegExp(`/subscriptions\\?subscription=${instanceId}$`))
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect(page.getByRole('link', { name: '订阅', exact: true })).toHaveAttribute('aria-current', 'page')

    await page.getByRole('link', { name: '我的', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible()
    await expect(page.getByRole('region', { name: '套餐概览' })).toContainText('订阅有效期至')
    await expect(page.getByRole('region', { name: '套餐概览' })).toContainText('1 个套餐')
    await expect(page.getByRole('link', { name: /我的套餐/u })).toBeVisible()
    await page.getByRole('link', { name: /我的套餐/u }).click()
    await expect(page).toHaveURL(/\/me\/plans$/)
    await expect(page.getByRole('link', { name: new RegExp(`${planName} 有效`, 'u') })).toBeVisible()
  })

  test('shows a failed redeem without losing the input and keeps filtering server-side', async ({ page }) => {
    await login(page, 'phase6-member', userPassword)
    await expect(page).toHaveURL(/\/home$/)
    await page.goto('/me/plans')
    await page.getByRole('button', { name: /兑换套餐/u }).first().click()
    const dialog = page.getByRole('dialog', { name: '兑换套餐' })
    await dialog.getByLabel('兑换码').fill('ZZZZ-ZZZZ-ZZZZ')
    await dialog.getByRole('button', { name: '兑换', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('兑换码无效')
    await expect(dialog.getByLabel('兑换码')).toHaveValue('ZZZZ-ZZZZ-ZZZZ')
    await page.keyboard.press('Escape')

    // Filter tabs: the active bucket holds the instance, the expired bucket is empty.
    await page.getByRole('button', { name: '有效', exact: true }).click()
    await expect(page).toHaveURL(/status=active$/)
    await expect(page.getByRole('link', { name: new RegExp(`${planName} 有效`, 'u') })).toBeVisible()
    await page.getByRole('button', { name: '已过期', exact: true }).click()
    await expect(page).toHaveURL(/status=expired$/)
    await expect(page.getByText('当前筛选下没有套餐')).toBeVisible()
    await page.getByRole('button', { name: '返回全部', exact: true }).click()
    await expect(page).toHaveURL(/\/me\/plans$/)
    await expect(page.getByRole('link', { name: new RegExp(`${planName} 有效`, 'u') })).toBeVisible()
  })

  test('keeps the subscription page readable on a phone in dark mode', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await login(page, 'phase6-member', userPassword)
    await expect(page).toHaveURL(/\/home$/)
    await page.goto('/subscriptions')
    await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('heading', { name: '套餐订阅' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})
