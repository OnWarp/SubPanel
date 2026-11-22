import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { parse } from 'yaml'

const baseURL = process.env.CORE_D_BASE_URL ?? 'http://127.0.0.1:4192'
const output = 'development/screenshots/core-d'
const sampleFile = 'development/verification/core-d-mihomo.yaml'
const root = '/api/admin/system/subscription-templates'
const password = 'local verification admin password'
let cookie

async function request(path, body, method = body === undefined ? 'GET' : 'POST', status = 200) {
  const response = await fetch(baseURL + path, {
    method, headers: { origin: baseURL, 'content-type': 'application/json', ...(cookie && { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.status, `${method} ${path.split('/').slice(0, 4).join('/')}`).toBe(status)
  if (path === '/api/login') cookie = response.headers.get('set-cookie').split(';', 1)[0]
  return response.json()
}

if (!(await request('/api/bootstrap')).initialized) await request('/api/setup', { username: 'admin', password }, 'POST', 201)
await request('/api/login', { username: 'admin', password })
const adminCookie = cookie
const username = 'conversion-viewer'
const { users } = await request('/api/admin/users')
if (!users.some(user => user.username === username)) {
  const { mode } = await request('/api/admin/system/registration')
  await request('/api/admin/system/registration', { mode: 'invite' }, 'PUT')
  const { invitations } = await request('/api/admin/invitations', { type: 'batch', count: 1 }, 'POST', 201)
  const code = new URL(invitations[0].link).pathname.split('/').at(-1)
  await request('/api/register', { username, password, email: 'conversion-viewer@example.com', inviteCode: code }, 'POST', 201)
  await request('/api/admin/system/registration', { mode }, 'PUT')
}
const { user } = await request('/api/login', { username, password })
const userCookie = cookie
cookie = adminCookie
const link = (name, host) => `ss://${btoa('aes-128-gcm:sample-password')}@${host}:8388#${encodeURIComponent(name)}`
const catalog = await request('/api/admin/catalog')
let group = catalog.groups.find(item => item.name === '转换验证节点')
if (!group) {
  const { source } = await request('/api/admin/catalog/sources', {
    type: 'manual', name: '转换验证样本',
    content: [link('东京中继', 'tokyo.example'), link('新加坡中继', 'singapore.example')].join('\n'),
  }, 'POST', 201)
  ;({ group } = await request('/api/admin/catalog/groups', {
    name: '转换验证节点', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  }, 'POST', 201))
}
const { plans } = await request('/api/admin/plans')
const plan = plans.find(item => item.name === '转换验证计划') ?? (await request('/api/admin/plans', {
  name: '转换验证计划', groupIds: [group.id], durationDays: 365,
}, 'POST', 201)).plan

const advanced = `subpanel:
  nodes:
    prefix: "亚太 · "
    sort: name
  client:
    dns:
      enable: true
      nameserver:
        - https://1.1.1.1/dns-query
proxy-groups:
  - name: Proxy
    type: select
    proxies: [Fast, Backup, Balance, DIRECT]
  - name: Fast
    type: url-test
    proxies: ["$SUBPANEL_NODES"]
    tolerance: 50
  - name: Backup
    type: fallback
    proxies: ["$SUBPANEL_NODES"]
  - name: Balance
    type: load-balance
    proxies: ["$SUBPANEL_NODES"]
    strategy: round-robin
rules:
  - DOMAIN-SUFFIX,example.org,DIRECT
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - MATCH,Proxy
`

await request(root + '/rule-sources/local', { name: '自建示例规则', rules: ['DOMAIN-KEYWORD,telemetry,REJECT'] })
const profile = await request(root, { name: '亚太分流策略', yaml: advanced }, 'POST', 201)
const profilePath = `${root}/${profile.id}`
const version = await request(`${profilePath}/publish`, { expectedRevision: profile.revision, draftHash: profile.draftHash })
const updated = await request(profilePath, { expectedRevision: version.revision, name: '亚太分流策略',
  yaml: advanced.replace('example.org,DIRECT', 'example.org,Fast') }, 'PUT')
const { subscription, token } = await request('/api/admin/subscriptions', {
  userId: user.id, name: '转换灰度订阅', planId: plan.id, groupIds: [group.id], defaultClient: 'mihomo',
  templateBinding: { mode: 'specific', templateId: profile.id, expectedRevision: 1 },
}, 'POST', 201)

const publicResponse = await fetch(`${baseURL}/sub/${token}/mihomo`)
expect(publicResponse.status).toBe(200)
const body = await publicResponse.text()
expect(parse(body)).toMatchObject({
  mode: 'rule',
  proxies: [{ name: '亚太 · 东京中继' }, { name: '亚太 · 新加坡中继' }],
  'proxy-groups': [{ type: 'select' }, { type: 'url-test' }, { type: 'fallback' }, { type: 'load-balance' }],
  rules: ['DOMAIN-SUFFIX,example.org,DIRECT', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'MATCH,Proxy'],
})
await mkdir(output, { recursive: true })
await writeFile(sampleFile, body)

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
try {
  for (const [width, height, layout] of [[1440, 900, 'sidebar'], [390, 844, 'topbar']]) {
    const context = await browser.newContext({ baseURL, viewport: { width, height } })
    const [name, value] = cookie.split('=')
    await context.addCookies([{ name, value, url: baseURL, httpOnly: true }])
    await context.addInitScript(layout => {
      localStorage.setItem('subpanel.theme', 'light')
      localStorage.setItem('subpanel:admin-layout', layout)
    }, layout)
    const page = await context.newPage()
    const capture = async (name, fullPage = true) => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `${output}/${name}-${width}.png`, animations: 'disabled', fullPage })
    }

    await page.goto('/system/distribution')
    const compat = page.getByRole('link', { name: '打开转换配置' })
    await expect(compat).toBeVisible()
    await capture('settings')
    await compat.click()
    await expect(page.getByRole('navigation', { name: '订阅管理导航' }).getByRole('link', { name: '转换配置' })).toHaveAttribute('aria-current', 'page')
    const row = page.getByRole('row').filter({ hasText: '亚太分流策略' }).first()
    await expect(row).toContainText('Mihomo')
    await capture('profiles')
    await page.getByText('规则来源', { exact: true }).click()
    await expect(page.getByRole('button', { name: '自建示例规则 · v1' })).toBeVisible()
    await page.getByRole('heading', { name: '规则库' }).scrollIntoViewIfNeeded()
    await capture('rule-library')

    await page.goto(`/delivery/conversions?config=${profile.id}`)
    await expect(page.getByLabel('配置名称')).toHaveValue('亚太分流策略')
    await page.getByRole('button', { name: '基础模式' }).click()
    await expect(page.getByLabel('策略类型').first()).toContainText('手动选择')
    await expect(page.getByText('启用 Mihomo DNS')).toBeVisible()
    await capture('editor')
    await page.getByRole('button', { name: '发布', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '发布配置' })
    await expect(dialog).toContainText('发布差异')
    await expect(dialog.locator('del')).toHaveText('  - DOMAIN-SUFFIX,example.org,DIRECT')
    await expect(dialog.locator('ins')).toHaveText('  - DOMAIN-SUFFIX,example.org,Fast')
    await capture('publish')
    await dialog.getByRole('button', { name: '取消' }).click()

    await page.goto(`/delivery/conversions?${new URLSearchParams({
      config: profile.id, view: 'preview', version: version.versionId, subscription: subscription.id,
    })}`)
    await expect(page.getByText('输入 2 · 授权 2 · 输出 2 · 跳过 0')).toBeVisible()
    await expect(page.locator('.template-preview pre')).toContainText('mode: rule')
    await expect(page.locator('.template-preview pre')).not.toContainText('sample-password')
    if (width === 390) await page.getByText(/输出摘要/).scrollIntoViewIfNeeded()
    await capture('preview')

    await page.goto('/delivery/subscriptions')
    const subscriptionRow = page.getByRole('row').filter({ hasText: '转换灰度订阅' }).first()
    await subscriptionRow.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('button', { name: '查看详情', exact: true }).click()
    const configLink = page.getByRole('link', { name: /查看配置诊断/ })
    await expect(configLink).toBeVisible()
    await page.addStyleTag({ content: '.subscription-link-row .link-url { visibility: hidden; }' })
    await configLink.scrollIntoViewIfNeeded()
    await capture('subscription-details', false)
    await configLink.click()
    await expect(page.getByText('输入 2 · 授权 2 · 输出 2 · 跳过 0')).toBeVisible()

    const [userCookieName, userCookieValue] = userCookie.split('=')
    await context.addCookies([{ name: userCookieName, value: userCookieValue, url: baseURL, httpOnly: true }])
    await page.goto('/subscriptions')
    await expect(page.getByText(/导入后请检查客户端是否使用规则模式/).first()).toBeVisible()
    await expect(page.getByText('仅节点订阅').first()).toBeVisible()
    await page.addStyleTag({ content: '.del-link-text, .ui3-platform-row code, .del-qr { visibility: hidden; }' })
    await capture('user-formats')
    await context.close()
  }
  const second = await request(`${profilePath}/publish`, { expectedRevision: updated.revision, draftHash: updated.draftHash })
  expect(await (await fetch(`${baseURL}/sub/${token}/mihomo`)).text()).toContain('DOMAIN-SUFFIX,example.org,Fast')
  await request(`${profilePath}/rollback`, { expectedRevision: second.revision, versionId: version.versionId })
  expect(await (await fetch(`${baseURL}/sub/${token}/mihomo`)).text()).toBe(body)
} finally {
  await browser.close()
}
console.log('Conversion navigation, four-layer output, version preview, release diff, and rollback passed at 1440 and 390px')
