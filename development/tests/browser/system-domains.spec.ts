import { expect, test } from '@playwright/test'

test('system domain cards preserve row operations at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const timestamps = {
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z', lastCheckError: null,
  }
  const primary = {
    ...timestamps, purpose: 'panel', isPrimary: true, health: 'verified', verifiedAt: timestamps.updatedAt,
    id: 'panel-primary', hostname: 'primary.example.com', enabled: true,
    verificationStatus: 'verified', lastCheckAt: '2026-01-01T01:00:00Z', note: '原备注',
  }
  const backup = {
    ...timestamps, purpose: 'panel', isPrimary: false, health: 'pending', verifiedAt: null,
    id: 'panel-backup', hostname: `${'long-domain-'.repeat(5)}example.com`, enabled: false,
    verificationStatus: 'pending', lastCheckAt: null, note: '',
  }
  const domains = {
    panel: [primary, backup],
    subscription: [],
    primaryPanelDomainId: primary.id,
    primarySubscriptionDomainId: null,
    restrictionEnabled: false,
  }
  const base = '/api/admin/system/domains'
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    json: { initialized: true, user: { id: 'admin', username: 'admin', role: 'admin', enabled: true } },
  }))
  await page.route('**/api/admin/system/subscription-platforms', (route) => route.fulfill({ json: { platforms: [] } }))
  await page.route(`**${base}`, (route) => route.fulfill({ json: domains }))

  await page.goto('/system/distribution')
  const panel = page.getByRole('region', { name: '面板域名', exact: true })
  const subscriptions = page.getByRole('region', { name: '订阅域名', exact: true })
  await expect(panel.locator('.ops-footer')).toHaveText('共 2 个域名')
  await expect(subscriptions.locator('.ops-footer')).toHaveText('共 0 个域名')
  const primaryRow = panel.getByRole('listitem').filter({ hasText: primary.hostname })
  const backupRow = panel.getByRole('listitem').filter({ hasText: backup.hostname })
  await expect(primaryRow.getByRole('img', { name: '已验证' })).toBeVisible()
  await expect(primaryRow.getByText('最近验证', { exact: false })).toBeVisible()
  await expect(backupRow.getByRole('img', { name: '待验证' })).toBeVisible()
  await expect(backupRow.getByRole('switch')).not.toBeChecked()
  expect(await panel.evaluate((card) => card.scrollWidth <= card.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)

  await primaryRow.getByRole('button', { name: /更多操作/ }).click()
  await expect(primaryRow.getByRole('button', { name: '设为主域名' })).toHaveCount(0)
  await expect(primaryRow.getByRole('button', { name: '删除', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')

  const noteButton = primaryRow.getByRole('button', { name: /编辑.*备注/ })
  await noteButton.click()
  const noteDialog = page.getByRole('dialog', { name: '编辑域名备注' })
  const editor = noteDialog.getByRole('textbox', { name: '备注' })
  await editor.fill('取消的备注')
  await editor.press('Escape')
  await noteDialog.getByRole('button', { name: '放弃更改' }).click()
  await expect(noteButton).toHaveText('原备注')
  await noteButton.click()
  await editor.fill('新备注')
  await page.route(`**${base}/panel/${primary.id}`, async (route) => {
    expect(route.request().method()).toBe('PATCH')
    expect(route.request().postDataJSON()).toEqual({ note: '新备注' })
    primary.note = '新备注'
    await route.fulfill({ json: { domain: primary, autoPrimary: false } })
  })
  await editor.press('Enter')
  await expect(noteButton).toHaveText('新备注')

  let deletes = 0
  await page.route(`**${base}/panel/${backup.id}`, async (route) => {
    expect(route.request().method()).toBe('DELETE')
    deletes += 1
    domains.panel = [primary]
    await route.fulfill({ status: 204 })
  })
  const more = backupRow.getByRole('button', { name: /更多操作/ })
  const dialog = page.getByRole('dialog', { name: '删除域名' })
  await more.click()
  await expect(backupRow.getByRole('button', { name: '验证', exact: true })).toBeEnabled()
  await expect(backupRow.getByRole('button', { name: '设为主域名' })).toBeDisabled()
  await backupRow.getByRole('button', { name: '删除', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()
  expect(deletes).toBe(0)
  await more.click()
  await backupRow.getByRole('button', { name: '删除', exact: true }).click()
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect(panel.locator('.ops-footer')).toHaveText('共 1 个域名')
  expect(deletes).toBe(1)

  const add = subscriptions.getByRole('button', { name: '添加域名', exact: true })
  const hostname = subscriptions.getByRole('textbox', { name: '域名', exact: true })
  await expect(hostname).toBeHidden()
  await add.click()
  await hostname.fill('subscriptions.example.com')
  await subscriptions.getByRole('textbox', { name: '备注', exact: true }).fill('订阅入口')
  await page.route(`**${base}/subscription`, async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ hostname: 'subscriptions.example.com', note: '订阅入口' })
    await route.fulfill({
      status: 201,
      json: { domain: { ...backup, hostname: 'subscriptions.example.com', purpose: 'subscription', note: '订阅入口' } },
    })
  })
  await subscriptions.getByRole('button', { name: '添加', exact: true }).click()
  await expect(hostname).toBeHidden()
})

test('the Worker CSP permits the cross-origin instance probe path', async ({ page }) => {
  const health = await page.request.get('/api/health')
  expect(health.ok()).toBe(true)
  const policy = health.headers()['content-security-policy']
  expect(policy).toBeTruthy()

  const probeOrigin = 'https://domain-probe.example'
  const requests: string[] = []
  await page.route(`${probeOrigin}/**`, (route) => {
    requests.push(new URL(route.request().url()).pathname)
    return route.fulfill({ json: { instanceId: 'fixture' }, headers: { 'access-control-allow-origin': '*' } })
  })
  await page.route('**/domain-probe-fixture', (route) => route.fulfill({
    headers: { 'content-security-policy': policy },
    contentType: 'text/html',
    body: '<!doctype html><title>Domain probe</title>',
  }))
  await page.goto('/domain-probe-fixture')
  const result = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/system/instance`, { credentials: 'omit', redirect: 'error' })
    const blocked = await fetch(`${origin}/api/health`, { credentials: 'omit' }).then(() => false, () => true)
    return { instance: await response.json(), blocked }
  }, probeOrigin)

  expect(result).toEqual({ instance: { instanceId: 'fixture' }, blocked: true })
  expect(requests).toEqual(['/api/system/instance'])
})
