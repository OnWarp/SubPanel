// Phase 6 screenshot run. It drives the real local app (Vite on 4173) with a
// seeded admin + member + plan + redemption, then captures /me, /me/plans,
// the plan detail and /subscriptions in light and dark at 390px, plus a
// desktop shot. Output: development/screenshots/phase6/.
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const baseURL = process.env.PHASE6_BASE_URL ?? 'http://127.0.0.1:4173'
const out = 'development/screenshots/phase6'
const adminPassword = 'correct horse battery staple'
const userPassword = 'phase6 member password 123456'
const userEmail = 'phase6-member@example.com'

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' })
const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } })
const page = await context.newPage()

async function api(path, data, method = "POST") {
  const origin = new URL(page.url() || baseURL).origin
  const response = await page.request.fetch(path, { method, data, headers: { origin, 'content-type': 'application/json' } })
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()} ${await response.text()}`)
  return response.status() === 204 ? null : response.json()
}

async function login(username, password) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/(home|dashboard)$/)
}

async function shot(name) {
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
}

async function seed() {
  await page.goto('/')
  const setup = page.getByRole('heading', { name: '初始化管理员' })
  if (await setup.isVisible().catch(() => false)) {
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill(adminPassword)
    await page.getByLabel('初始化密钥').fill(process.env.BOOTSTRAP_SECRET!)
    await page.getByRole('button', { name: '创建管理员' }).click()
  }
  await login('admin', adminPassword)
  await api('/api/admin/system/registration', { mode: 'invite' }, 'PUT')
  const invite = await api('/api/admin/invites', {})
  const registered = await page.request.post('/api/register', {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { username: 'phase6-member', password: userPassword, email: userEmail, inviteCode: invite.invite.code },
  })
  if (!registered.ok() && registered.status() !== 409) throw new Error(`register ${registered.status()}`)
  await api('/api/login', { username: 'admin', password: adminPassword })
  const source = await api('/api/admin/catalog/sources', {
    name: 'Phase 6 source', type: 'manual',
    content: `ss://${btoa('aes-128-gcm:fixture')}@p6.example.com:8388#P6Node`,
  })
  const group = await api('/api/admin/catalog/groups', {
    name: '阶段六节点组', sourceIds: [source.source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  })
  const { plan } = await api('/api/admin/plans', {
    name: '阶段六套餐', description: '阶段六个人中心套餐', nodeGroupIds: [group.group.id],
    durationSeconds: 30 * 86400, enabled: true, remark: null,
  })
  const codes = await api('/api/admin/redeem-codes', {
    planId: plan.id, quantity: 1, maxUses: 1, perUserLimit: 1, durationMode: 'snapshot',
  })
  await login('phase6-member', userPassword)
  const redeemed = await page.request.post('/api/me/plans/redeem', {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { code: codes.codes[0].code, idempotencyKey: crypto.randomUUID() },
  })
  if (!redeemed.ok()) throw new Error(`redeem ${redeemed.status()} ${await redeemed.text()}`)
  const body = await redeemed.json()
  return body.instance.id
}

await mkdir(out, { recursive: true })
const instanceId = await seed()

for (const theme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto('/me')
  await page.getByRole('heading', { name: '个人中心' }).waitFor()
  await page.getByRole('region', { name: '套餐概览' }).waitFor()
  await shot(`me-390-${theme}`)

  await page.goto('/me/plans')
  await page.getByRole('heading', { name: '我的套餐' }).waitFor()
  await page.getByRole('link', { name: /阶段六套餐 有效/u }).waitFor()
  await shot(`plans-390-${theme}`)

  await page.goto(`/me/plans/${instanceId}`)
  await page.getByRole('heading', { name: '阶段六套餐' }).waitFor()
  await shot(`plan-detail-390-${theme}`)

  await page.goto('/subscriptions')
  await page.getByRole('heading', { name: '我的订阅' }).waitFor()
  await shot(`subscriptions-390-${theme}`)
}

await page.emulateMedia({ colorScheme: 'light' })
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto('/me')
await page.getByRole('heading', { name: '个人中心' }).waitFor()
await shot('me-1440-light')
await page.goto('/me/plans')
await page.getByRole('link', { name: /阶段六套餐 有效/u }).waitFor()
await shot('plans-1440-light')

await browser.close()
console.log('screenshots written to', out)
