import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const before = process.argv.includes('--before')
const output = 'development/screenshots/sub-me-redesign'
const now = Date.parse('2026-11-24T08:00:00Z')
const iso = new Date(now).toISOString()
const expiresAt = now + 12 * 86400000
const user = { id: 'example', username: 'alice', role: 'user', enabled: true, email: 'alice@example.com' }
const subscription = {
  id: 'example-sub', name: '主订阅', planName: '标准计划', planState: 'active', status: 'active',
  statusLabel: '有效', expiresAt, createdAt: iso, enabled: true, remainingGb: 176,
  usedGb: 24, trafficGb: 200, groupIds: ['group'], defaultClient: 'clash',
  links: { clash: 'https://example.com/sub/clash' }, diagnostics: {},
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.SUB_ME_CHROMIUM })
try {
  const page = await browser.newPage({
    baseURL: process.env.SUB_ME_BASE_URL ?? 'http://127.0.0.1:4187',
    timezoneId: 'UTC',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  await page.clock.setFixedTime(now)
  await page.addInitScript(() => localStorage.setItem('subpanel.theme', 'light'))
  const mutations = []
  let signedIn = true
  let downloadsEnabled = true
  let subscriptions = [subscription]
  let redemptionError = false
  let profileError = false
  let subscriptionError = false
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.method() === 'POST') mutations.push({ path, body: request.postDataJSON() })
    const fixtures = {
      '/api/bootstrap': { initialized: true, user: signedIn ? user : null },
      '/api/account/profile': { user, emailBound: Boolean(user.email), avatar: { url: '/logo.png' }, session: { issuedAt: iso, expiresAt: iso } },
      '/api/account/subscriptions': { subscriptions, shareEnabled: false },
      '/api/account/subscription-platforms': { platforms: [{ platform: 'clash', displayName: 'Clash' }] },
      '/api/apps': { downloadsEnabled, apps: [] },
      '/api/notices': { notices: [] },
      '/api/kb': { articles: [] },
      '/api/tickets': { tickets: [] },
      '/api/account/password': {},
      '/api/account/email/bind': {},
      '/api/account/email/change': {},
      '/api/account/email/bind/confirm': {},
      '/api/account/email/change/confirm': {},
      '/api/account/logout-all': {},
      '/api/me/redemptions/preview': { preview: { name: '兑换计划', duration: { value: 30, unit: 'day' }, quotaBytes: null, nodePolicy: 'groups', previewProof: 'fixture' } },
      '/api/me/redemptions': request.method() === 'POST' ? { subscription: { id: 'new-sub', name: '兑换计划', expiresAt } } : {
        items: [{ id: 'record', subscriptionId: subscription.id, subscriptionName: url.searchParams.get('page') === '2' ? '第二页订阅' : subscription.name, redeemedAt: iso, expiresAt, hasSubscription: 1 }],
        total: 2, pageSize: 1,
      },
    }
    if (path === '/api/account/email/bind/confirm' || path === '/api/account/email/change/confirm') user.email = 'updated@example.com'
    if (path === '/api/account/logout-all') signedIn = false
    if (path === '/api/me/redemptions' && redemptionError || path === '/api/account/profile' && profileError || path === '/api/account/subscriptions' && subscriptionError) return route.abort()
    await route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
  })

  await mkdir(output, { recursive: true })
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.goto('/me')
    await expect(page.getByRole('region', { name: '账户信息' }).getByText(user.email, { exact: true })).toBeVisible()
    if (before) {
      await expect(page.getByRole('heading', { name: '兑换历史' })).toBeVisible()
      await expect(page.getByText('200 GiB', { exact: true })).toBeVisible()
    } else {
      const overview = page.getByRole('region', { name: '订阅' })
      await expect(overview.getByText('176 GB')).toBeVisible()
      await expect(overview.getByText('主订阅')).toBeVisible()
      await expect(overview.getByText('标准计划')).toBeVisible()
      await expect(overview.getByText('有效', { exact: true })).toBeVisible()
      await expect(overview.getByText('2026/12/6 08:00:00')).toBeVisible()
      await expect(overview).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('navigation', { name: '设置' })).toBeInViewport({ ratio: 1 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
    await page.screenshot({ path: `${output}/${width}-${before ? 'before' : 'after'}.png`, animations: 'disabled', fullPage: true })
  }
  if (!before) {
    const heading = (name) => page.getByRole('heading', { name, level: 1, exact: true })
    const button = (name) => page.getByRole('button', { name, exact: true })
    const link = (name) => page.getByRole('link', { name, exact: true })
    const open = async (label, path, title = label) => {
      await link(label).click()
      await expect(page).toHaveURL(path)
      await expect(heading(title)).toBeVisible()
    }
    const back = () => open('个人中心', '/me')
    const fillEmail = async (label, email, action) => {
      await page.getByLabel(label, { exact: true }).fill(email)
      await button('获取验证码').click()
      await expect(page.getByText(`验证码已发送至 ${email}`)).toBeVisible()
      await button('重新填写邮箱').click()
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(email)
      await button('获取验证码').click()
      await page.getByLabel('邮箱验证码').fill('123456')
      await button(action).click()
    }

    await open('通知设置', '/me/notifications')
    const reminder = page.getByRole('switch', { name: '到期提醒' })
    await expect(reminder).not.toBeChecked()
    await reminder.click()
    await expect(reminder).toBeChecked()
    await page.reload()
    await expect(reminder).toBeChecked()
    await reminder.click()
    await expect(reminder).not.toBeChecked()
    await back()

    await open('显示设置', '/me/display')
    await button('内嵌').click()
    await expect(page.locator('.app-layout')).toHaveAttribute('data-mobile-bar', 'inset')
    await page.reload()
    await expect(button('内嵌')).toHaveAttribute('aria-pressed', 'true')
    await button('悬浮').click()
    await expect(page.locator('.app-layout')).toHaveAttribute('data-mobile-bar', 'floating')
    await back()

    await open('帮助与支持', '/me/support')
    for (const [label, path] of [['公告', '/notices'], ['知识库', '/kb'], ['工单', '/tickets'], ['客户端下载', '/apps']]) {
      await open(label, path)
      await page.goBack()
      await expect(heading('帮助与支持')).toBeVisible()
    }
    downloadsEnabled = false
    await page.reload()
    await expect(heading('帮助与支持')).toBeVisible()
    await expect(link('客户端下载')).toHaveCount(0)
    await back()

    await open('全部订阅', '/me/subscriptions', '我的订阅')
    await expect(page.getByText('200 GiB', { exact: true })).toBeVisible()
    await expect(page.getByText('1 个动态组', { exact: true })).toBeVisible()
    await button('复制链接').click()
    await expect(button('已复制')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(subscription.links.clash)
    await expect(link('管理订阅')).toHaveAttribute('href', '/subscriptions')
    await link('管理').click()
    await expect(page).toHaveURL('/subscriptions?subscription=example-sub')
    await page.goBack()
    await link('管理订阅').click()
    await expect(page).toHaveURL('/subscriptions')
    await page.goBack()
    subscriptionError = true
    await page.reload()
    await expect(button('重试')).toBeVisible()
    subscriptionError = false
    await button('重试').click()
    await expect(button('复制链接')).toBeVisible()
    await back()

    redemptionError = true
    await open('兑换订阅', '/me/redemption')
    await expect(button('重试')).toBeVisible()
    redemptionError = false
    await button('重试').click()
    const history = page.getByRole('region', { name: '兑换历史' })
    await expect(history.getByRole('link', { name: '主订阅' })).toHaveAttribute('href', '/subscriptions?subscription=example-sub')
    await button('下一页').click()
    await expect(history.getByRole('link', { name: '第二页订阅' })).toBeVisible()
    await button('上一页').click()
    await expect(history.getByRole('link', { name: '主订阅' })).toBeVisible()
    await page.getByLabel('兑换码').fill('example')
    await button('预览权益').click()
    await expect(page.getByText('动态分组', { exact: true })).toBeVisible()
    await button('返回修改').click()
    await expect(page.getByLabel('兑换码')).toHaveValue('example')
    await button('预览权益').click()
    await button('确认兑换').click()
    await expect(page.getByText('已兑换 兑换计划')).toBeVisible()
    await link('查看新订阅').click()
    await expect(page).toHaveURL('/subscriptions?subscription=new-sub')

    await page.goto('/account')
    await expect(page).toHaveURL('/me')
    await open('安全', '/me/security')
    await expect(page.getByText('本次登录')).toBeVisible()
    await expect(page.getByText('会话过期')).toBeVisible()
    const newPassword = randomUUID()
    await page.locator('#account-current-password').fill(randomUUID())
    await page.getByLabel('新密码', { exact: true }).fill(newPassword)
    await page.getByLabel('确认新密码', { exact: true }).fill(randomUUID())
    await button('更新密码').click()
    await expect(page.getByText('两次输入的新密码不一致')).toBeVisible()
    await page.getByLabel('确认新密码', { exact: true }).fill(newPassword)
    await button('更新密码').click()
    await expect(page.getByText('密码已更新，其他会话已退出')).toBeVisible()
    await page.locator('#account-email-current-password').fill(newPassword)
    await fillEmail('新邮箱', 'next@example.com', '确认更换')
    await expect(page.getByText('邮箱已更换')).toBeVisible()
    await back()
    await expect(page.getByRole('region', { name: '账户信息' }).getByText('updated@example.com')).toBeVisible()
    user.email = null
    await page.reload()
    await expect(page.getByText('未绑定', { exact: true })).toBeVisible()
    await open('安全', '/me/security')
    await fillEmail('邮箱', 'first@example.com', '确认绑定')
    await expect(page.getByText('邮箱已绑定')).toBeVisible()
    await back()

    profileError = true
    subscriptionError = true
    await page.reload()
    await expect(button('重试')).toHaveCount(2)
    profileError = false
    subscriptionError = false
    subscriptions = []
    await page.getByRole('region', { name: '账户信息' }).getByRole('button', { name: '重试' }).click()
    await page.getByRole('region', { name: '订阅' }).getByRole('button', { name: '重试' }).click()
    await expect(page.getByText('暂无订阅')).toBeVisible()
    await expect(page.getByRole('region', { name: '账户信息' }).getByText('alice')).toBeVisible()
    subscriptions = [
      { ...subscription, name: '过期订阅', status: 'expired', statusLabel: '已过期' },
      { ...subscription, name: '永久订阅', expiresAt: null, remainingGb: null },
    ]
    await page.reload()
    const summary = page.getByRole('region', { name: '订阅' })
    await expect(summary.getByText('永久订阅')).toBeVisible()
    await expect(summary.getByText('永久有效')).toBeVisible()
    await expect(summary.getByText('不限', { exact: true })).toBeVisible()
    subscriptions = [{ ...subscription, remainingGb: undefined }]
    await page.reload()
    await expect(summary.getByText('暂无数据', { exact: true })).toBeVisible()

    await open('安全', '/me/security')
    await button('退出全部设备').click()
    const dialog = page.getByRole('dialog', { name: '退出全部设备' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()
    expect(mutations.filter(mutation => mutation.path === '/api/account/logout-all')).toHaveLength(0)
    await button('退出全部设备').click()
    await dialog.getByRole('button', { name: '退出全部设备' }).click()
    await expect(page).toHaveURL('/login')
    await page.goto('/me/security')
    await expect(page).toHaveURL('/login')

    expect(mutations.map(({ path }) => path)).toEqual([
      '/api/me/redemptions/preview', '/api/me/redemptions/preview', '/api/me/redemptions',
      '/api/account/password', '/api/account/email/change', '/api/account/email/change',
      '/api/account/email/change/confirm', '/api/account/email/bind', '/api/account/email/bind',
      '/api/account/email/bind/confirm', '/api/account/logout-all',
    ])
    console.log('6 secondary routes and account actions passed with intercepted APIs')
  }
} finally {
  await browser.close()
}
