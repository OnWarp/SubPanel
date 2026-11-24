import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const origin = new URL(process.env.SUBPANEL_BROWSER_ORIGIN ?? 'http://127.0.0.1:4179').origin
assert.equal(new URL(origin).hostname, '127.0.0.1')
assert.ok(process.env.BOOTSTRAP_SECRET)
const folder = 'development/screenshots/sub-unified-pr3'
await mkdir(folder, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const context = await browser.newContext({ baseURL: origin })
  const member = await browser.newContext({ baseURL: origin })
  for (const session of [context, member]) {
    await session.route('**/*', route =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  }
  const page = await context.newPage()
  const memberPage = await member.newPage()
  const api = async (path, method, data, expected, session = context) => {
    const response = await session.request.fetch(path, { method, data, headers: { origin } })
    assert.equal(response.status(), expected, `${method} ${path.replace(/\/shares\/[^/]{43}\//u, '/shares/[redacted]/')}`)
    return expected === 204 ? null : response.json()
  }
  const password = randomUUID()
  await api('/api/setup', 'POST', { username: 'admin', password, setupSecret: process.env.BOOTSTRAP_SECRET }, 201)
  await api('/api/login', 'POST', { username: 'admin', password }, 200)
  const auth = Buffer.from(`aes-128-gcm:${randomUUID()}`).toString('base64url')
  const { source } = await api('/api/admin/catalog/sources', 'POST', {
    name: 'Browser regression', type: 'manual',
    content: `ss://${auth}@one.example:8388#One\nss://${auth}@two.example:8388#Two`,
  }, 201)
  const { group } = await api('/api/admin/catalog/groups', 'POST', {
    name: 'Browser group', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  }, 201)
  const config = {
    groupIds: [group.id], nodeIds: [], duration: { value: 1, unit: 'day' },
    quotaBytes: null, resetPolicy: 'none', limits: { speedLimitMbps: 0 },
  }
  const makeTemplate = (name, options = {}) => api('/api/admin/subscription-templates', 'POST', {
    name, config, ...options,
  }, 201)
  const { template } = await makeTemplate('浏览器兑换', { allowRedemption: true })
  const { codes } = await api('/api/admin/redemption-batches', 'POST', {
    name: 'Browser redemption', templateId: template.id, quantity: 2,
    redeemDeadline: Date.now() + 3_600_000, idempotencyKey: randomUUID(),
  }, 201)
  const { template: baseline } = await makeTemplate('Legacy comparison')
  const { plan } = await api('/api/admin/plans', 'POST', {
    name: 'Browser trial policy', groupIds: [group.id], durationDays: 7,
  }, 201)
  await api(`/api/admin/plans/${plan.id}/entitlement-template`, 'PUT', { templateId: baseline.id }, 200)
  await api('/api/admin/subscriptions/trial', 'PUT', { trialPlanId: plan.id, trialDays: 3 }, 200)
  await api('/api/admin/system/registration', 'PUT', { mode: 'invite' }, 200)
  const { invitations } = await api('/api/admin/invitations', 'POST', { type: 'batch', count: 1 }, 201)
  const inviteCode = new URL(invitations[0].link).pathname.split('/').at(-1)
  const { user } = await api('/api/register', 'POST', {
    username: 'browser-member', password: randomUUID(), email: 'member@example.test', inviteCode,
  }, 201, member)
  const { bindings } = await api(`/api/admin/users/${user.id}/template-bindings`, 'GET', undefined, 200)
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0].templateId, baseline.id)
  const startsAt = Date.parse(bindings[0].startsAt)
  const expiresAt = Date.parse(bindings[0].expiresAt)
  assert.equal(expiresAt - startsAt, 3 * 86_400_000)
  await api('/api/admin/subscriptions', 'POST', {
    userId: user.id, name: 'Legacy browser baseline', groupIds: [group.id], startsAt, expiresAt,
  }, 201)
  const shadowPath = `/api/admin/users/${user.id}/subscription/shadow`
  assert.equal((await api(shadowPath, 'GET', undefined, 200)).matches, true)
  for (const [index, width] of [1440, 390].entries()) {
    await page.setViewportSize({ width, height: 900 })
    await memberPage.setViewportSize({ width, height: 900 })
    await memberPage.goto('/me/redemption')
    await memberPage.getByRole('textbox', { name: '兑换码' }).fill(codes[index])
    await memberPage.getByRole('button', { name: '预览权益' }).click()
    await memberPage.getByRole('button', { name: '确认兑换' }).click()
    await memberPage.getByText('已兑换 浏览器兑换').waitFor()
    assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await memberPage.screenshot({ path: `${folder}/redemption-${width}.png`, animations: 'disabled' })

    await memberPage.goto('/subscriptions')
    await memberPage.getByRole('button', { name: '分享统一订阅' }).click()
    await memberPage.getByRole('dialog', { name: '分享统一订阅' }).waitFor()
    await memberPage.getByRole('dialog', { name: '分享统一订阅' }).screenshot({ path: `${folder}/sharing-${width}.png`, animations: 'disabled' })
    await memberPage.getByRole('button', { name: '创建', exact: true }).click()
    const url = await memberPage.getByRole('textbox', { name: '分享链接' }).inputValue()
    assert.equal(new URL(url).origin, origin, "Share URL remains on local preview")
    const shareToken = new URL(url).pathname.split('/').filter(Boolean).at(-1)
    await api(`/api/shares/${shareToken}/meta`, 'GET', undefined, 200)
    const sharePage = await memberPage.goto(url)
    assert.equal(sharePage.status(), 200, 'Share URL opens the share page')
    await memberPage.getByRole('heading', { name: /分享/ }).first().waitFor()
    await api(`/api/shares/${shareToken}/export?type=link`, 'GET', undefined, 404)
    const exported = await context.request.get(`/api/shares/${shareToken}/export?client=mihomo`)
    assert.equal(exported.status(), 200)
    assert.ok((await exported.text()).includes('one.example'))

    await page.goto('/delivery/subscriptions')
    await page.getByRole('button', { name: '批量任务' }).click()
    await page.getByRole('textbox', { name: '用户编号' }).fill(user.id)
    await page.getByRole('textbox', { name: '授权模板编号' }).fill(template.id)
    await page.getByRole('combobox', { name: '授权操作' }).click()
    await page.getByRole('option', { name: '续期授权' }).click()
    await page.getByRole('button', { name: '预览授权' }).click()
    await page.getByRole('button', { name: '确认并创建任务' }).waitFor()
    await page.screenshot({ path: `${folder}/batch-${width}.png`, animations: 'disabled' })
    await page.getByRole('button', { name: '确认并创建任务' }).click()
    await page.getByRole('button', { name: '执行任务' }).click()
    await page.getByText(/已完成 · 已处理 1\/1 · 失败 0/).waitFor()
    await api('/api/shares/revoke-all', 'POST', {}, 204, member)
    await api(`/api/shares/${shareToken}/meta`, 'GET', undefined, 404)
    const after = await api(shadowPath, 'GET', undefined, 200)
    assert.equal(after.matches, false)
    assert.ok(after.reasons.includes('WINDOW_DIFFERS'))
    assert.equal(after.operations.bindingRedemptions, index + 1)
    assert.equal(after.operations.batchBindingRequests, index + 1)
    console.log(`${width}: redemption, share export/revocation and batch renewal passed`)
  }
  console.log('Local browser shadow fixture: one user, equivalent baseline, window mismatch after new grant')
} finally {
  await browser.close()
}
