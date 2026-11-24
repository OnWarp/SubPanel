import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const base = new URL(process.env.P3_BASE_URL ?? 'http://127.0.0.1:4196')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Use an isolated local Worker')
const output = process.env.P3_SCREENSHOTS ?? 'development/screenshots/sub-v2-p3'
const widths = [1440, 1024, 390]
const password = randomUUID()
const account = 'p3-member'
const batchName = '十一月体验批次'
const templateName = '标准月度订阅'
const oldName = '已有独立订阅'

async function request(context, pathname, data, status = 200, method = data === undefined ? 'GET' : 'POST') {
  const response = await context.request.fetch(new URL(pathname, base).href, { method, data, headers: { origin: base.origin } })
  const payload = await response.json()
  expect(response.status(), `${method} ${pathname} ${payload.error?.code ?? ''}`).toBe(status)
  return payload
}

async function checkLayout(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

const formatPaths = [
  '', 'mihomo', 'clash', 'clash-meta', 'stash', 'singbox', 'sing-box', 'karing',
  'surge', 'loon', 'quantumultx', 'quantumult-x', 'v2rayn', 'v2rayng',
  'nekobox', 'neko-box', 'shadowrocket', 'generic',
]
async function sampleOutput(context, token) {
  const results = []
  for (const format of formatPaths) {
    const pathname = `/sub/${token}${format ? `/${format}` : ''}`
    const response = await context.request.get(new URL(pathname, base).href, { headers: { 'User-Agent': 'Clash local regression' } })
    expect(response.status(), `old subscription format ${format || 'auto'}`).toBe(200)
    const headers = response.headers()
    results.push({
      type: headers['content-type'], disposition: headers['content-disposition'], etag: headers.etag,
      hash: createHash('sha256').update(await response.body()).digest('hex'),
    })
  }
  return results
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.P3_CHROMIUM_EXECUTABLE })
try {
  const admin = await browser.newContext({ baseURL: base.origin, locale: 'zh-CN' })
  const user = await browser.newContext({ baseURL: base.origin, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] })
  expect((await request(admin, '/api/bootstrap')).initialized).toBe(false)
  await request(admin, '/api/setup', { username: 'admin', password, setupSecret: process.env.BOOTSTRAP_SECRET }, 201)
  await request(admin, '/api/login', { username: 'admin', password })
  await request(admin, '/api/admin/migration/run', { module: 'catalog' })
  await request(admin, '/api/admin/migration/run', { module: 'delivery' })
  await request(admin, '/api/admin/system/registration', { mode: 'invite' }, 200, 'PUT')
  const { invitations } = await request(admin, '/api/admin/invitations', { type: 'batch', count: 1 }, 201)
  const inviteCode = new URL(invitations[0].link).pathname.split('/').at(-1)
  await request(user, '/api/register', { username: account, password, email: 'p3-member@example.test', inviteCode }, 201)
  const { user: holder } = await request(user, '/api/login', { username: account, password })

  const { source } = await request(admin, '/api/admin/catalog/sources', {
    type: 'manual', name: '验证节点',
    content: `ss://${btoa(`aes-128-gcm:${randomUUID()}`)}@fixture.example.test:8388#Fixture`,
  }, 201)
  const { group } = await request(admin, '/api/admin/catalog/groups', {
    name: '体验节点组', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  }, 201)
  const { token } = await request(admin, '/api/admin/subscriptions', {
    userId: holder.id, name: oldName, groupIds: [group.id], trafficGb: 80,
  }, 201)
  await request(admin, '/api/admin/subscription-templates', {
    name: templateName, allowRedemption: true,
    config: {
      duration: { value: 1, unit: 'month' }, quotaBytes: 30 * 1024 ** 3, resetPolicy: 'none',
      groupIds: [group.id], nodeIds: [], limits: { speedLimitMbps: 0 },
    },
  }, 201)
  const before = await sampleOutput(user, token)
  const adminPage = await admin.newPage()
  await adminPage.setViewportSize({ width: 1440, height: 1050 })
  await adminPage.goto('/delivery/subscriptions')
  await adminPage.getByRole('link', { name: '兑换码管理' }).click()
  await adminPage.getByRole('button', { name: '生成兑换码' }).click()
  await adminPage.getByRole('textbox', { name: '批次名称' }).fill(batchName)
  const template = adminPage.getByRole('combobox', { name: '订阅模板' })
  await template.focus()
  await template.press('ArrowDown')
  await adminPage.getByRole('option', { name: templateName }).click()
  await expect(adminPage.getByRole('combobox', { name: '固定版本' })).toHaveText('v1')
  await adminPage.getByLabel('生成数量').fill('2')
  const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 16)
  await adminPage.getByLabel('兑换截止时间').fill(future)
  await adminPage.getByRole('button', { name: '生成', exact: true }).click()
  const codeField = adminPage.getByRole('textbox', { name: '完整兑换码' })
  await expect(codeField).toBeVisible()
  const issued = (await codeField.inputValue()).split('\n')
  expect(issued.length).toBe(2)
  const downloadEvent = adminPage.waitForEvent('download')
  await adminPage.getByRole('button', { name: '导出 CSV' }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename().endsWith('.csv')).toBe(true)
  expect((await readFile(await download.path(), 'utf8')).includes(issued[0])).toBe(true)
  await download.delete()
  await expect(adminPage.getByRole('button', { name: '已导出 CSV' })).toBeDisabled()
  await adminPage.keyboard.press('Escape')
  await expect(codeField).toHaveCount(0)
  const detail = adminPage.url()

  const userPage = await user.newPage()
  await userPage.setViewportSize({ width: 390, height: 900 })
  await userPage.goto('/me')
  await userPage.getByRole('link', { name: '全部订阅' }).click()
  await expect(userPage.getByRole('cell', { name: oldName })).toBeVisible()
  await userPage.getByRole('link', { name: '个人中心', exact: true }).click()
  await userPage.getByRole('link', { name: '兑换订阅' }).click()
  await userPage.getByRole('textbox', { name: '兑换码' }).fill(issued[0])
  await userPage.getByRole('button', { name: '预览权益' }).click()
  await expect(userPage.getByText('确认后会新增一份独立订阅')).toBeVisible()
  await userPage.getByRole('button', { name: '确认兑换' }).click()
  await expect(userPage.getByText(`已兑换 ${templateName}`)).toBeVisible()
  await userPage.getByRole('link', { name: '查看新订阅' }).click()
  await expect(userPage.getByRole('heading', { name: templateName })).toBeVisible()
  await userPage.goto('/me')
  await userPage.getByRole('link', { name: '全部订阅' }).click()
  const subscriptions = userPage.getByRole('region', { name: '我的订阅' }).locator('tbody tr')
  await expect(subscriptions).toHaveCount(2)
  await subscriptions.filter({ hasText: templateName })
    .getByRole('button', { name: '复制链接' }).click()
  expect(await userPage.evaluate(async () => (await navigator.clipboard.readText()).includes('/sub/'))).toBe(true)
  await userPage.goto('/me/redemption')

  await mkdir(output, { recursive: true })
  for (const width of widths) {
    const viewport = { width, height: width === 390 ? 900 : 1050 }
    await adminPage.emulateMedia({ colorScheme: width === 1024 ? 'dark' : 'light' })
    await adminPage.setViewportSize(viewport)
    await adminPage.goto(detail)
    await expect(adminPage.getByRole('heading', { name: batchName })).toBeVisible()
    await expect(adminPage.getByText('已用尽', { exact: true })).toBeVisible()
    expect((await adminPage.locator('body').innerText()).includes(issued[0])).toBe(false)
    await checkLayout(adminPage)
    await adminPage.screenshot({ path: `${output}/admin-${width}.png`, fullPage: true })

    await userPage.emulateMedia({ colorScheme: width === 1024 ? 'dark' : 'light' })
    await userPage.setViewportSize(viewport)
    await expect(userPage.getByRole('region', { name: '兑换历史' }).getByText(templateName)).toBeVisible()
    await checkLayout(userPage)
    await userPage.evaluate(() => { document.querySelector('main').scrollTop = 0 })
    await userPage.screenshot({ path: `${output}/personal-${width}.png`, fullPage: true })
  }

  const revoke = adminPage.getByRole('button', { name: '作废', exact: true })
  await revoke.click()
  await adminPage.getByRole('button', { name: '确认', exact: true }).click()
  await expect(adminPage.getByText('已作废', { exact: true })).toBeVisible()
  await adminPage.getByRole('button', { name: '审计' }).click()
  await expect(adminPage.getByText('作废单码', { exact: true })).toBeVisible()
  await adminPage.getByRole('button', { name: '停用批次' }).click()
  await adminPage.getByRole('button', { name: '确认', exact: true }).click()
  await expect(adminPage.getByText(/标准月度订阅 · v1 · 已停用/)).toBeVisible()
  expect(await sampleOutput(user, token)).toEqual(before)
  console.log(`Passed local browser flow at ${widths.join(', ')} px and ${formatPaths.length} stable old-link paths`)
} finally {
  await browser.close()
}
