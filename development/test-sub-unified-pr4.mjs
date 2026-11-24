import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const origin = new URL(process.env.SUBPANEL_BROWSER_ORIGIN ?? 'http://127.0.0.1:4180').origin
assert.equal(new URL(origin).hostname, '127.0.0.1')
const folder = 'development/screenshots/sub-unified-pr4'
await mkdir(folder, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })

try {
  const admin = await browser.newContext({ baseURL: origin })
  const member = await browser.newContext({ baseURL: origin, permissions: ['clipboard-read', 'clipboard-write'] })
  for (const session of [admin, member]) {
    await session.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  }
  const request = async (session, path, expected, method = 'GET', data) => {
    const response = await session.request.fetch(path, { method, data, headers: { origin } })
    assert.equal(response.status(), expected, `${method} ${path.replace(/\/s\/[^/]+/u, '/s/[redacted]')}`)
    return response.json()
  }
  const adminApi = (...args) => request(admin, ...args)
  const memberApi = (...args) => request(member, ...args)
  const password = randomUUID()
  assert.ok(process.env.BOOTSTRAP_SECRET, 'Set BOOTSTRAP_SECRET for a fresh fixture')
  await adminApi('/api/setup', 201, 'POST', { username: 'admin', password, setupSecret: process.env.BOOTSTRAP_SECRET })
  await adminApi('/api/login', 200, 'POST', { username: 'admin', password })
  await adminApi('/api/admin/system/registration', 200, 'PUT', { mode: 'invite' })
  const { invitations } = await adminApi('/api/admin/invitations', 201, 'POST', { type: 'batch', count: 1 })
  const inviteCode = new URL(invitations[0].link).pathname.split('/').at(-1)
  const { user } = await memberApi('/api/register', 201, 'POST', {
    username: 'pr4-member', email: 'member@example.test', password: randomUUID(), inviteCode,
  })
  const auth = Buffer.from(`aes-128-gcm:${randomUUID()}`).toString('base64url')
  const { source } = await adminApi('/api/admin/catalog/sources', 201, 'POST', {
    name: 'Regression source', type: 'manual', content: `ss://${auth}@one.example:8388#Fixture node`,
  })
  const { group } = await adminApi('/api/admin/catalog/groups', 201, 'POST', {
    name: 'Regression group', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  })
  const config = { groupIds: [group.id], nodeIds: [], duration: { value: 1, unit: 'month' },
    quotaBytes: null, resetPolicy: 'none', limits: { speedLimitMbps: 0 } }
  const { template } = await adminApi('/api/admin/subscription-templates', 201, 'POST', { name: 'PR4 private UI fixture', config })
  const userPath = `/api/admin/users/${user.id}`
  const summary = '/api/user/subscription'
  const editorUrl = `/users/${user.id}?tab=subscription`
  const adminPage = await admin.newPage()
  const memberPage = await member.newPage()
  const empty = await memberApi(summary, 200)
  assert.equal(empty.status, 'none')
  assert.ok(empty.subscriptionUrl)
  const shots = (page, name, width) => page.screenshot({ path: `${folder}/${name}-${width}.png`, animations: 'disabled' })
  const fit = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  for (const width of [1440, 1024, 390]) {
    const viewport = { width, height: 900 }
    await memberPage.setViewportSize(viewport)
    await memberPage.goto('/subscriptions')
    await expect(memberPage.getByText('暂无可用节点')).toBeVisible()
    await expect(memberPage.getByRole('button', { name: '复制', exact: true })).toBeVisible()
    await fit(memberPage)
    await shots(memberPage, 'empty', width)
  }
  const startsAt = Date.now() - 1000
  const old = await adminApi('/api/admin/subscriptions', 201, 'POST', {
    userId: user.id, name: 'Legacy fixture', groupIds: [group.id], startsAt, expiresAt: null, enabled: true,
  })
  const shadowPath = `${userPath}/subscription/shadow`
  assert.equal((await adminApi(shadowPath, 200)).matches, false)
  for (const width of [1440, 1024, 390]) {
    const viewport = { width, height: 900 }
    await adminPage.setViewportSize(viewport)
    await memberPage.setViewportSize(viewport)
    await adminPage.goto('/delivery/subscriptions')
    await expect(adminPage).toHaveURL(/\/users$/u)
    await adminPage.goto('/plans')
    await expect(adminPage).toHaveURL(/\/delivery\/templates$/u)
    await adminPage.goto(editorUrl)
    await adminPage.getByRole('button', { name: '绑定模板', exact: true }).click()
    await adminPage.getByLabel('搜索模板').fill('PR4')
    await adminPage.getByLabel('模板', { exact: true }).click()
    await adminPage.getByRole('option', { name: template.name }).click()
    await adminPage.getByLabel('有效期').click()
    await adminPage.getByRole('option', { name: '永久', exact: true }).click()
    await adminPage.getByRole('button', { name: '预览影响' }).click()
    await expect(adminPage.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    await fit(adminPage)
    await shots(adminPage, 'binding', width)
    await adminPage.getByRole('button', { name: '保存', exact: true }).click()
    await expect(adminPage.getByRole('dialog')).toHaveCount(0)
    await expect(adminPage.getByRole('button', { name: '绑定模板', exact: true })).toBeFocused()

    await memberPage.goto('/subscriptions?subscription=retired')
    await expect(memberPage).toHaveURL(/\/subscriptions$/u)
    await expect(memberPage.getByText('长期有效')).toBeVisible()
    await expect(memberPage.getByText(template.name)).toHaveCount(0)
    await expect(memberPage.getByRole('combobox')).toHaveCount(0)
    await fit(memberPage)
    await shots(memberPage, 'subscription', width)
    const current = await memberApi(summary, 200)
    assert.equal(current.nodeCount, 1)
    const path = new URL(current.subscriptionUrl).pathname
    assert.equal(new URL(current.subscriptionUrl).origin, origin)
    await memberPage.getByRole('button', { name: '复制', exact: true }).click()
    assert.ok(await memberPage.evaluate(async link => await navigator.clipboard.readText() === link, current.subscriptionUrl))
    assert.equal(await memberPage.getByText(path, { exact: false }).count(), 0)
    await memberPage.getByRole('button', { name: '导入客户端' }).click()
    const imports = memberPage.getByRole('dialog', { name: '导入客户端' })
    await expect(imports).toBeVisible()
    await expect(imports.locator('a[href^="clash:"]').first()).toHaveAttribute('href', /^clash:\/\/install-config\?url=/u)
    if (width === 390) {
      const additional = imports.getByText('更多导入方式')
      await additional.click()
      for (const scheme of ['stash:', 'surge:', 'loon:', 'shadowrocket:']) {
        await expect(imports.locator(`a[href^="${scheme}"]`)).toHaveCount(1)
      }
      await expect(imports.getByRole('button', { name: '复制 sing-box 链接' })).toBeVisible()
      const formats = { clash: 'mihomo', stash: 'mihomo', surge: 'surge', loon: 'loon', shadowrocket: 'shadowrocket', singbox: 'singbox' }
      for (const [format, renderer] of Object.entries(formats)) {
        const response = await member.request.get(`${path}/${format}`)
        assert.equal(response.status(), 200)
        assert.equal(response.headers()['x-subscription-client'], renderer)
      }
    }
    await shots(memberPage, 'import', width)
    await memberPage.keyboard.press('Escape')
    await memberPage.goto('/nodes')
    await expect(memberPage.getByText('Fixture node')).toBeVisible()
    await expect(memberPage.getByRole('combobox', { name: '按订阅筛选' })).toHaveCount(0)
    const publicResponse = await member.request.get(`${path}/mihomo`)
    assert.equal(publicResponse.status(), 200)
    assert.ok((await publicResponse.text()).includes('one.example'))
    const etag = publicResponse.headers().etag
    const conditional = { headers: { 'If-None-Match': etag } }
    assert.equal((await member.request.get(`${path}/mihomo`, conditional)).status(), 304)
    await memberPage.goto('/subscriptions')
    await memberPage.getByText('更多', { exact: true }).click()
    await memberPage.getByRole('button', { name: '重置链接', exact: true }).click()
    await memberPage.getByRole('button', { name: '重置', exact: true }).click()
    await expect(memberPage.getByText('旧链接已失效')).toBeVisible()
    assert.equal((await member.request.get(`${path}/mihomo`, conditional)).status(), 404)
    assert.ok((await memberApi(summary, 200)).subscriptionUrl !== current.subscriptionUrl)
    assert.equal((await member.request.get(`/sub/${old.token}/mihomo`)).status(), 200)

    await memberPage.route(`**${summary}`, route => route.fulfill({ status: 503, json: { error: 'fixture' } }))
    await memberPage.goto('/subscriptions')
    await expect(memberPage.getByText('加载订阅失败')).toBeVisible()
    await shots(memberPage, 'error', width)
    await memberPage.unroute(`**${summary}`)
    await memberPage.getByRole('button', { name: '重试' }).click()
    await expect(memberPage.getByText('长期有效')).toBeVisible()
    if (width === 390) {
      await memberPage.route(`**${summary}`, route => route.fulfill({ status: 429, json: { error: 'fixture' } }))
      await memberPage.goto('/subscriptions')
      await expect(memberPage.getByText('请求过于频繁，请稍后重试')).toBeVisible()
      await memberPage.unroute(`**${summary}`)
    }
  }
  const verified = await adminApi(shadowPath, 200)
  assert.equal(verified.matches, true, JSON.stringify(verified.reasons))
  await adminPage.goto(editorUrl)
  await adminPage.getByRole('button', { name: '更新', exact: true }).click()
  await adminPage.getByRole('button', { name: '预览影响' }).click()
  const savePath = `**${userPath}/template-bindings/${template.id}`
  await adminPage.route(savePath, route => route.fulfill({
    status: 409, json: { error: { code: 'BINDING_CONFLICT', message: 'Fixture conflict' } },
  }))
  await adminPage.getByRole('button', { name: '保存', exact: true }).click()
  await expect(adminPage.getByText('授权已更新，请刷新后重试')).toBeVisible()
  await adminPage.getByRole('button', { name: '重试' }).click()
  await expect(adminPage.getByRole('dialog')).toHaveCount(0)
  await adminPage.unroute(savePath)
  await memberPage.emulateMedia({ colorScheme: 'dark' })
  await memberPage.goto('/subscriptions')
  await expect(memberPage.getByText('长期有效')).toBeVisible()
  await fit(memberPage)
  await shots(memberPage, 'dark', 390)
  const current = await memberApi(summary, 200)
  const path = new URL(current.subscriptionUrl).pathname
  const response = await member.request.get(`${path}/mihomo`)
  await adminApi(userPath, 200, 'PATCH', { enabled: false })
  assert.equal((await member.request.get(`${path}/mihomo`, { headers: { 'If-None-Match': response.headers().etag } })).status(), 404)
  console.log('1440/1024/390 passed. Shadow observations: 1 match, 1 mismatch.')
} finally {
  await browser.close()
}
