import { expect, test, type Page, type Route } from '@playwright/test'

type Kind = 'panel' | 'subscription'
type Verification = 'pending' | 'verified' | 'failed'

type Row = {
  id: string
  hostname: string
  note: string
  enabled: boolean
  verificationStatus: Verification
  health?: unknown
  verifiedAt: string | null
  updatedAt: string
  createdAt: string
  lastCheckAt: string | null
  lastCheckError: string | null
}

type Platform = { platform: string; displayName: string; enabled: boolean; sortOrder: number }

type Fixture = {
  panel: Row[]
  subscription: Row[]
  primaryPanelDomainId: string | null
  primarySubscriptionDomainId: string | null
  restrictionEnabled: boolean
  platforms: Platform[]
  listStatus: number
  listMessage: string
  holdList: Promise<void> | null
  abortList: boolean
  createMode: 'domain' | 'empty' | 'invalid'
  patchStatus: number
  patchMessage: string
  holdPatch: Promise<void> | null
  deleteStatus: number
  deleteMessage: string
  primaryStatus: number
  primaryMessage: string
  holdPrimary: Promise<void> | null
  holdChallenge: Promise<void> | null
  verifyStatus: number
  verifyMessage: string
  verifyShape: 'domain' | 'empty'
  instanceMode: 'id' | 'fail' | 'missing'
  holdInstance: Promise<void> | null
}

type Call = { method: string; path: string; url: string; body: unknown }

const SHARE_SETTINGS = {
  enabled: true,
  createAllowed: true,
  maxSharesPerSubscription: 5,
  maxActiveSharesPerUser: 20,
  maxValidityDays: 90,
  defaultAllowOriginalLink: false,
  defaultAccessControl: 'none',
  requireLoginDefault: false,
  publicBaseUrl: '',
}

function deferred() {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function row(partial: Pick<Row, 'id' | 'hostname' | 'createdAt'> & Partial<Row>): Row {
  return {
    note: '',
    enabled: false,
    verificationStatus: 'pending',
    verifiedAt: null,
    updatedAt: partial.createdAt,
    lastCheckAt: null,
    lastCheckError: null,
    ...partial,
  }
}

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    panel: [
      row({ id: 'panel-backup', hostname: 'backup.example.com', note: '备用', enabled: true, verificationStatus: 'verified', verifiedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
      row({ id: 'panel-old', hostname: 'old.example.com', enabled: true, verificationStatus: 'verified', verifiedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-02T00:00:00Z' }),
      row({ id: 'panel-pending', hostname: 'pending.example.com', createdAt: '2026-01-03T00:00:00Z' }),
      row({ id: 'panel-failed', hostname: 'failed.example.com', enabled: true, verificationStatus: 'failed', createdAt: '2026-01-04T00:00:00Z', lastCheckError: '证书不匹配', health: { dns: 'failed', https: 'unknown', service: null } }),
      row({ id: 'panel-primary', hostname: 'primary.example.com', note: '原备注', enabled: true, verificationStatus: 'verified', verifiedAt: '2026-06-01T00:00:00Z', createdAt: '2026-06-01T00:00:00Z' }),
    ],
    subscription: [
      row({ id: 'sub-main', hostname: 'sub.example.com', enabled: true, verificationStatus: 'verified', verifiedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
    ],
    primaryPanelDomainId: 'panel-primary',
    primarySubscriptionDomainId: 'sub-main',
    restrictionEnabled: false,
    platforms: [
      { platform: 'mihomo', displayName: 'Mihomo', enabled: true, sortOrder: 0 },
      { platform: 'stash', displayName: 'Stash', enabled: false, sortOrder: 1 },
    ],
    listStatus: 200,
    listMessage: '没有域名管理权限',
    holdList: null,
    abortList: false,
    createMode: 'domain',
    patchStatus: 200,
    patchMessage: '域名当前不可停用',
    holdPatch: null,
    deleteStatus: 204,
    deleteMessage: '主链接不能删除',
    primaryStatus: 200,
    primaryMessage: '该域名不能设为主链接',
    holdPrimary: null,
    holdChallenge: null,
    verifyStatus: 200,
    verifyMessage: 'TXT 记录未生效',
    verifyShape: 'domain',
    instanceMode: 'id',
    holdInstance: null,
    ...overrides,
  }
}

function listPayload(state: Fixture) {
  return {
    panel: state.panel,
    subscription: state.subscription,
    primaryPanelDomainId: state.primaryPanelDomainId,
    primarySubscriptionDomainId: state.primarySubscriptionDomainId,
    restrictionEnabled: state.restrictionEnabled,
  }
}

function readBody(route: Route): unknown {
  return route.request().postData() ? route.request().postDataJSON() : null
}

async function fail(route: Route, status: number, message: string, code: string) {
  await route.fulfill({ status, json: { error: { code, message } } })
}

async function install(page: Page, state: Fixture) {
  const calls: Call[] = []
  const record = (route: Route) => {
    const call = { method: route.request().method(), path: new URL(route.request().url()).pathname, url: route.request().url(), body: readBody(route) }
    calls.push(call)
    return call
  }

  await page.route('**/api/bootstrap', (route) => route.fulfill({
    json: { initialized: true, user: { id: 'admin', username: 'admin', role: 'admin', enabled: true } },
  }))
  await page.route('**/api/admin/share-settings', (route) => route.fulfill({ json: { settings: SHARE_SETTINGS } }))
  await page.route('**/api/admin/system/subscription-platforms', async (route) => {
    record(route)
    if (route.request().method() === 'PUT') {
      const body = readBody(route) as { platforms: Array<{ platform: string; enabled: boolean }> }
      state.platforms = body.platforms.map((entry, index) => {
        const current = state.platforms.find((item) => item.platform === entry.platform)
        return { platform: entry.platform, displayName: current?.displayName ?? entry.platform, enabled: entry.enabled, sortOrder: index }
      })
    }
    await route.fulfill({ json: { platforms: state.platforms } })
  })
  await page.route('**/api/admin/system/domain-restriction', async (route) => {
    const call = record(route)
    const enabled = Boolean((call.body as { enabled?: boolean } | null)?.enabled)
    state.restrictionEnabled = enabled
    await route.fulfill({ json: { enabled } })
  })
  await page.route('**/api/system/instance', async (route) => {
    record(route)
    if (state.holdInstance) await state.holdInstance
    if (state.instanceMode === 'fail') {
      await route.abort('failed')
      return
    }
    if (state.instanceMode === 'missing') {
      await route.fulfill({ json: {} })
      return
    }
    await route.fulfill({ json: { instanceId: `inst-${new URL(route.request().url()).hostname}` } })
  })
  await page.route('**/api/admin/system/domains**', async (route) => {
    const call = record(route)
    const match = call.path.match(/^\/api\/admin\/system\/domains(?:\/(panel|subscription)(?:\/([^/]+)(?:\/(primary|challenge|verify))?)?)?$/)
    if (!match) {
      await fail(route, 404, `未实现 ${call.method} ${call.path}`, 'NOT_FOUND')
      return
    }
    const kind = match[1] as Kind | undefined
    const id = match[2]
    const action = match[3]

    if (!kind && call.method === 'GET') {
      if (state.abortList) {
        await route.abort('failed')
        return
      }
      if (state.holdList) await state.holdList
      if (state.listStatus !== 200) {
        await fail(route, state.listStatus, state.listMessage, 'FORBIDDEN')
        return
      }
      await route.fulfill({ json: listPayload(state) })
      return
    }

    if (kind && !id && call.method === 'POST') {
      const body = call.body as { hostname: string; note?: string }
      if (state.createMode === 'invalid') {
        await fail(route, 400, '域名格式不正确', 'INVALID_HOSTNAME')
        return
      }
      if (state.createMode === 'empty') {
        await route.fulfill({ json: {} })
        return
      }
      const created = row({
        id: `${kind}-created`,
        hostname: body.hostname,
        note: body.note ?? '',
        createdAt: '2026-02-01T00:00:00Z',
      })
      state[kind].push(created)
      await route.fulfill({ status: 201, json: { domain: created } })
      return
    }

    if (!kind || !id) {
      await fail(route, 404, `未实现 ${call.method} ${call.path}`, 'NOT_FOUND')
      return
    }
    const current = state[kind].find((item) => item.id === id)
    if (!current) {
      await fail(route, 404, '域名不存在', 'NOT_FOUND')
      return
    }

    if (call.method === 'PATCH' && !action) {
      if (state.holdPatch) await state.holdPatch
      if (state.patchStatus !== 200) {
        await fail(route, state.patchStatus, state.patchMessage, 'DOMAIN_DISABLED')
        return
      }
      const body = call.body as { note?: string; enabled?: boolean }
      if (typeof body.note === 'string') current.note = body.note
      if (typeof body.enabled === 'boolean') current.enabled = body.enabled
      await route.fulfill({ json: { domain: current } })
      return
    }

    if (call.method === 'DELETE' && !action) {
      if (state.deleteStatus !== 204) {
        await fail(route, state.deleteStatus, state.deleteMessage, 'PRIMARY_PROTECTED')
        return
      }
      state[kind] = state[kind].filter((item) => item.id !== id)
      await route.fulfill({ status: 204 })
      return
    }

    if (call.method === 'POST' && action === 'primary') {
      if (state.holdPrimary) await state.holdPrimary
      if (state.primaryStatus !== 200) {
        await fail(route, state.primaryStatus, state.primaryMessage, 'NOT_VERIFIED')
        return
      }
      if (kind === 'panel') state.primaryPanelDomainId = id
      else state.primarySubscriptionDomainId = id
      await route.fulfill({ json: { domain: current } })
      return
    }

    if (call.method === 'POST' && action === 'challenge') {
      if (state.holdChallenge) await state.holdChallenge
      await route.fulfill({ json: { challenge: { txtName: `_subpanel-verify.${current.hostname}`, txtValue: `token-${current.id}`, expiresAt: '2026-12-01T00:00:00Z' } } })
      return
    }

    if (call.method === 'POST' && action === 'verify') {
      if (state.verifyStatus !== 200) {
        await fail(route, state.verifyStatus, state.verifyMessage, 'VERIFY_FAILED')
        return
      }
      if (state.verifyShape === 'empty') {
        await route.fulfill({ json: {} })
        return
      }
      current.verificationStatus = 'verified'
      current.verifiedAt = '2026-03-01T00:00:00Z'
      current.health = { dns: 'unknown', https: 'unknown', service: 'unknown' }
      await route.fulfill({ json: { domain: current } })
      return
    }

    await fail(route, 404, `未实现 ${call.method} ${call.path}`, 'NOT_FOUND')
  })
  return calls
}

function panel(page: Page) {
  return page.getByRole('region', { name: '面板域名', exact: true })
}

function subscription(page: Page) {
  return page.getByRole('region', { name: '订阅域名', exact: true })
}

async function openMenu(page: Page, hostname: string) {
  await page.getByRole('button', { name: `${hostname} 更多操作` }).click()
}

test('switches domain tabs and keeps restriction and platforms', async ({ page }) => {
  const state = fixture()
  const calls = await install(page, state)
  await page.goto('/system/distribution?subscription=sub_1')

  await expect(page.getByRole('heading', { name: '域名管理' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '域名用途' }).getByRole('link', { name: '面板域名' })).toHaveAttribute('aria-current', 'page')
  await expect(panel(page)).toContainText('主链接用于邀请链接等面板绝对链接')
  await expect(panel(page).getByRole('searchbox')).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
  await expect(panel(page).locator('.ops-footer')).toHaveText('共 5 个域名')
  const hosts = panel(page).locator('.sys-domain-host')
  await expect(hosts).toHaveText(['primary.example.com', 'backup.example.com', 'old.example.com', 'pending.example.com', 'failed.example.com'])
  const primaryRow = panel(page).getByRole('listitem').filter({ hasText: 'primary.example.com' })
  await expect(primaryRow.locator('.sys-domain-mark')).toContainText('已验证')
  await expect(primaryRow.locator('.sys-domain-mark svg')).toHaveCount(1)
  await expect(panel(page).getByRole('listitem').filter({ hasText: 'failed.example.com' }).locator('.sys-domain-mark')).toContainText('验证失败')

  await page.getByRole('switch', { name: '域名限制' }).click()
  await expect(page.getByRole('switch', { name: '域名限制' })).toBeChecked()
  expect(calls.find((call) => call.path === '/api/admin/system/domain-restriction')?.body).toEqual({ enabled: true })
  await expect(page.getByText('某一类没有已启用的域名时，该类不做限制')).toBeVisible()

  await page.getByRole('button', { name: '下移 Mihomo' }).click()
  await expect(page.locator('.dom-platform-name strong').first()).toHaveText('Stash')
  expect(calls.find((call) => call.path === '/api/admin/system/subscription-platforms' && call.method === 'PUT')?.body).toEqual({
    platforms: [{ platform: 'stash', enabled: false }, { platform: 'mihomo', enabled: true }],
  })

  await page.getByRole('link', { name: '订阅域名' }).click()
  await expect(page).toHaveURL(/subscription=sub_1/)
  await expect(page).toHaveURL(/domainKind=subscription/)
  await expect(subscription(page)).toBeVisible()
  await expect(panel(page)).toHaveCount(0)
  await expect(subscription(page)).toContainText('备用域名不会出现在任何链接里')
  await expect(subscription(page).locator('.ops-footer')).toHaveText('共 1 个域名')
  await page.getByRole('link', { name: '面板域名' }).click()
  await expect(page).toHaveURL(/subscription=sub_1/)
  await expect(page).not.toHaveURL(/domainKind=/)
})

test('selects a verified primary with the radio and restores a rejected switch', async ({ page }) => {
  const state = fixture()
  const gate = deferred()
  state.holdPrimary = gate.promise
  const calls = await install(page, state)
  await page.goto('/system/distribution')
  const group = page.getByRole('radiogroup', { name: '面板域名主链接' })
  const backup = group.getByRole('radio', { name: 'backup.example.com 主链接' })
  const previous = group.getByRole('radio', { name: 'primary.example.com 主链接' })
  await expect(previous).toBeChecked()
  await expect(group.getByRole('radio', { name: 'pending.example.com 主链接，需先验证并启用' })).toBeDisabled()

  await backup.focus()
  await page.keyboard.press('Space')
  await expect(group).toHaveAttribute('aria-busy', 'true')
  await expect(backup).toBeDisabled()
  await expect(previous).toBeDisabled()
  gate.release()
  state.holdPrimary = null

  await expect(backup).toBeChecked()
  await expect(backup).toBeFocused()
  await expect(previous).not.toBeChecked()
  await expect(panel(page).locator('.sys-domain-host')).toHaveText([
    'backup.example.com', 'old.example.com', 'pending.example.com', 'failed.example.com', 'primary.example.com',
  ])
  await expect(page.getByRole('switch', { name: 'backup.example.com 启用，请先切换主链接' })).toBeDisabled()
  await expect(page.getByRole('switch', { name: 'primary.example.com 启用' })).toBeEnabled()
  await expect(page.getByRole('switch', { name: 'primary.example.com 启用' })).toBeChecked()
  const primaryCall = calls.find((call) => call.path.endsWith('/primary'))
  expect(primaryCall?.method).toBe('POST')
  expect(primaryCall?.body).toEqual({})

  state.primaryStatus = 409
  const rejected = group.getByRole('radio', { name: 'old.example.com 主链接' })
  await rejected.click()
  await expect(page.getByRole('alert')).toHaveText('该域名不能设为主链接')
  await expect(backup).toBeChecked()
  await expect(rejected).not.toBeChecked()
  await expect(rejected).toBeFocused()
})

test('toggles enablement and keeps unverified or primary switches locked', async ({ page }) => {
  const state = fixture()
  const gate = deferred()
  state.holdPatch = gate.promise
  state.patchStatus = 409
  const calls = await install(page, state)
  await page.goto('/system/distribution')

  const primarySwitch = page.getByRole('switch', { name: 'primary.example.com 启用，请先切换主链接' })
  await expect(primarySwitch).toBeDisabled()
  await expect(primarySwitch).toHaveAttribute('aria-describedby', /domain-switch-reason-panel-primary/)
  await expect(panel(page).getByRole('listitem').filter({ hasText: 'primary.example.com' })).toContainText('请先切换主链接')
  const pendingSwitch = page.getByRole('switch', { name: 'pending.example.com 启用，请先验证' })
  await expect(pendingSwitch).toBeDisabled()
  await expect(panel(page).getByRole('listitem').filter({ hasText: 'pending.example.com' })).toContainText('请先验证')

  const oldSwitch = page.getByRole('switch', { name: 'old.example.com 启用' })
  await expect(oldSwitch).toBeChecked()
  await oldSwitch.click()
  await expect(oldSwitch).toBeDisabled()
  await expect(oldSwitch).not.toBeChecked()
  gate.release()
  state.holdPatch = null
  await expect(page.getByRole('alert')).toHaveText('域名当前不可停用')
  await expect(oldSwitch).toBeChecked()
  await expect(oldSwitch).toBeEnabled()
  await expect(oldSwitch).toBeFocused()
  expect(calls.find((call) => call.method === 'PATCH' && call.path.endsWith('/panel-old'))?.body).toEqual({ enabled: false })

  state.patchStatus = 200
  const failedSwitch = page.getByRole('switch', { name: 'failed.example.com 启用' })
  await failedSwitch.click()
  await expect(failedSwitch).not.toBeChecked()
  await expect(page.getByRole('switch', { name: 'failed.example.com 启用，请先验证' })).toBeDisabled()
})

test('protects the primary domain and confirms deletion', async ({ page }) => {
  const state = fixture()
  const calls = await install(page, state)
  await page.goto('/system/distribution')

  await openMenu(page, 'primary.example.com')
  const protectedDelete = page.getByRole('button', { name: '删除 primary.example.com，主链接不能删除，请先切换主链接' })
  await expect(protectedDelete).toBeDisabled()
  await page.keyboard.press('Escape')

  await openMenu(page, 'pending.example.com')
  await page.getByRole('button', { name: '删除 pending.example.com', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除域名' })
  await expect(dialog).toContainText('删除 pending.example.com 后，使用该域名的旧链接将停止服务。此操作只移除应用层授权，不会自动删除 Cloudflare DNS 记录或 Worker 绑定')
  await dialog.getByRole('button', { name: '取消' }).click()
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
  await expect(panel(page).getByText('pending.example.com')).toBeVisible()

  await openMenu(page, 'pending.example.com')
  await page.getByRole('button', { name: '删除 pending.example.com', exact: true }).click()
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect(panel(page).getByText('pending.example.com')).toHaveCount(0)
  await expect(panel(page).locator('.ops-footer')).toHaveText('共 4 个域名')
  expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/admin/system/domains/panel/panel-pending'])

  state.deleteStatus = 409
  await openMenu(page, 'backup.example.com')
  await page.getByRole('button', { name: '删除 backup.example.com', exact: true }).click()
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('主链接不能删除')
  await expect(panel(page).getByText('backup.example.com')).toBeVisible()
})

test('adds a domain and verifies it from the published challenge', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const state = fixture()
  const challengeGate = deferred()
  state.holdChallenge = challengeGate.promise
  const calls = await install(page, state)
  await page.goto('/system/distribution')
  await page.getByRole('link', { name: '订阅域名' }).click()

  await subscription(page).getByRole('button', { name: '添加域名' }).click()
  const dialog = page.getByRole('dialog', { name: '添加域名' })
  await expect(dialog).toHaveAttribute('data-size', 'm')
  await expect(dialog).toContainText('将添加到订阅域名')
  await expect(dialog.getByRole('button', { name: '添加', exact: true })).toBeDisabled()
  await dialog.getByLabel('域名', { exact: true }).fill('created.example.com')
  await expect(dialog.getByLabel('备注')).toHaveAttribute('maxlength', '200')
  await dialog.getByLabel('备注').fill('订阅入口')
  await dialog.getByRole('button', { name: '添加', exact: true }).click()

  const drawer = page.getByRole('dialog', { name: 'created.example.com' })
  await expect(drawer).toBeVisible()
  await expect(dialog).toBeHidden()
  await expect(drawer.getByRole('status')).toHaveText('正在获取验证记录')
  await expect(drawer.getByText('_subpanel-verify.created.example.com')).toHaveCount(0)
  challengeGate.release()
  state.holdChallenge = null
  await expect(drawer.getByText('_subpanel-verify.created.example.com')).toBeVisible()
  await expect(drawer.getByText('token-subscription-created')).toBeVisible()
  await expect(drawer.getByText('未检测', { exact: true })).toHaveCount(3)
  await expect(drawer.getByText('正常', { exact: true })).toHaveCount(0)
  await drawer.getByRole('button', { name: '复制记录名' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('_subpanel-verify.created.example.com')

  await drawer.getByRole('button', { name: '确认验证' }).click()
  await expect(drawer.getByText('已验证', { exact: true }).first()).toBeVisible()
  await expect(drawer.getByText('正常', { exact: true })).toHaveCount(0)
  await expect(drawer.getByText('未检测', { exact: true })).toHaveCount(3)
  const instance = calls.find((call) => call.path === '/api/system/instance')
  expect(instance?.url).toBe('https://created.example.com/api/system/instance')
  const verify = calls.find((call) => call.path.endsWith('/verify'))
  expect(verify?.body).toEqual({ observedInstanceId: 'inst-created.example.com' })
  expect(calls.find((call) => call.method === 'POST' && call.path === '/api/admin/system/domains/subscription')?.body).toEqual({
    hostname: 'created.example.com', note: '订阅入口',
  })

  await drawer.getByRole('button', { name: '关闭' }).click()
  await openMenu(page, 'created.example.com')
  await page.getByRole('button', { name: '复制链接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://created.example.com')
})

test('reports verification failures and does not treat unchecked probes as healthy', async ({ page }) => {
  const state = fixture()
  const calls = await install(page, state)
  await page.goto('/system/distribution')

  await openMenu(page, 'failed.example.com')
  await page.getByRole('button', { name: '查看详情 / DNS 配置' }).click()
  let drawer = page.getByRole('dialog', { name: 'failed.example.com' })
  await expect(drawer).toContainText('证书不匹配')
  await expect(drawer.getByText('异常', { exact: true })).toHaveCount(1)
  await expect(drawer.getByText('未检测', { exact: true })).toHaveCount(2)
  await expect(drawer.getByText('正常', { exact: true })).toHaveCount(0)
  await expect(drawer.getByText('验证失败', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '关闭' }).click()

  state.verifyStatus = 422
  await openMenu(page, 'pending.example.com')
  await page.getByRole('button', { name: '重新验证' }).click()
  drawer = page.getByRole('dialog', { name: 'pending.example.com' })
  await expect(drawer.getByText('_subpanel-verify.pending.example.com')).toBeVisible()
  await drawer.getByRole('button', { name: '确认验证' }).click()
  await expect(drawer.getByRole('alert')).toHaveText('TXT 记录未生效')
  await expect(drawer.getByText('正常', { exact: true })).toHaveCount(0)
  await expect(drawer.getByText('待验证', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '关闭' }).click()

  state.verifyStatus = 200
  state.instanceMode = 'fail'
  await openMenu(page, 'pending.example.com')
  await page.getByRole('button', { name: '查看详情 / DNS 配置' }).click()
  drawer = page.getByRole('dialog', { name: 'pending.example.com' })
  await drawer.getByRole('button', { name: '确认验证' }).click()
  await expect(drawer.getByRole('alert')).toHaveText('无法连接该域名上的实例标识接口')
  expect(calls.filter((call) => call.path.endsWith('/verify'))).toHaveLength(1)
  await drawer.getByRole('button', { name: '关闭' }).click()

  state.instanceMode = 'id'
  state.verifyShape = 'empty'
  await openMenu(page, 'pending.example.com')
  await page.getByRole('button', { name: '重新验证' }).click()
  drawer = page.getByRole('dialog', { name: 'pending.example.com' })
  await drawer.getByRole('button', { name: '确认验证' }).click()
  await expect(drawer.getByRole('alert')).toHaveText('服务返回了无效的域名状态')
})

test('edits a note without exposing the hostname and keeps the dialog on failure', async ({ page }) => {
  const state = fixture()
  const calls = await install(page, state)
  await page.goto('/system/distribution')
  const primaryRow = panel(page).getByRole('listitem').filter({ hasText: 'primary.example.com' })

  await openMenu(page, 'primary.example.com')
  await page.getByRole('button', { name: '编辑备注', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑域名备注' })
  await expect(dialog).toContainText('域名 primary.example.com')
  await expect(dialog.getByRole('textbox')).toHaveCount(1)
  await dialog.getByLabel('备注').fill('')
  await dialog.getByRole('button', { name: '保存备注' }).click()
  await expect(dialog).toBeHidden()
  await expect(primaryRow).not.toContainText('原备注')
  expect(calls.find((call) => call.method === 'PATCH' && call.path.endsWith('/panel-primary'))?.body).toEqual({ note: '' })

  state.patchStatus = 409
  state.patchMessage = '备注与其他记录冲突'
  await openMenu(page, 'primary.example.com')
  await page.getByRole('button', { name: '编辑备注', exact: true }).click()
  await dialog.getByLabel('备注').fill('新备注')
  await dialog.getByRole('button', { name: '保存备注' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('备注与其他记录冲突')
  await expect(dialog.getByLabel('备注')).toHaveValue('新备注')
  await expect(primaryRow).not.toContainText('新备注')

  state.patchStatus = 200
  await dialog.getByRole('button', { name: '保存备注' }).click()
  await expect(dialog).toBeHidden()
  await expect(primaryRow).toContainText('新备注')
})

test('keeps an empty create response from opening the verification drawer', async ({ page }) => {
  const state = fixture({ panel: [], subscription: [], primaryPanelDomainId: null, primarySubscriptionDomainId: null })
  state.createMode = 'invalid'
  const calls = await install(page, state)
  await page.goto('/system/distribution')
  await expect(panel(page).getByText('暂无域名')).toBeVisible()
  await expect(panel(page).locator('.ops-footer')).toHaveText('共 0 个域名')

  await panel(page).getByRole('button', { name: '添加域名' }).click()
  const dialog = page.getByRole('dialog', { name: '添加域名' })
  await dialog.getByLabel('域名', { exact: true }).fill('panel.example.test')
  await dialog.getByLabel('备注').fill('备注')
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('域名格式不正确')
  await expect(dialog.getByLabel('域名', { exact: true })).toHaveValue('panel.example.test')
  await expect(dialog.getByLabel('备注')).toHaveValue('备注')

  state.createMode = 'empty'
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/admin/system/domains/panel').map((call) => call.body)).toEqual([
    { hostname: 'panel.example.test', note: '备注' },
    { hostname: 'panel.example.test', note: '备注' },
  ])
})

test('covers loading, network, and permission states', async ({ page }) => {
  const held = fixture()
  const gate = deferred()
  held.holdList = gate.promise
  await install(page, held)
  await page.goto('/system/distribution')
  await expect(panel(page).getByRole('status', { name: '正在加载域名' })).toBeVisible()
  gate.release()
  held.holdList = null
  const loaded = panel(page).getByText('primary.example.com')
  const raced = panel(page).getByRole('alert')
  await expect(loaded.or(raced)).toBeVisible()
  // Bootstrap can invalidate the first cached read. Retry once the session has settled.
  if (await raced.count()) await raced.getByRole('button', { name: '重试' }).click()
  await expect(loaded).toBeVisible()

  const offline = fixture()
  offline.abortList = true
  await install(page, offline)
  await page.goto('/system/distribution')
  await expect(panel(page).getByRole('alert')).toContainText('无法连接服务，请稍后重试')

  const denied = fixture()
  denied.listStatus = 403
  await install(page, denied)
  await page.goto('/system/distribution')
  const deniedAlert = panel(page).getByRole('alert')
  await expect(deniedAlert).toBeVisible()
  if ((await deniedAlert.textContent())?.includes('无法连接服务')) await deniedAlert.getByRole('button', { name: '重试' }).click()
  await expect(deniedAlert).toContainText('没有域名管理权限')
  denied.listStatus = 200
  await deniedAlert.getByRole('button', { name: '重试' }).click()
  await expect(panel(page).getByText('primary.example.com')).toBeVisible()
})

test.describe('390px domain list', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('wraps the hostname and keeps the menu inside the viewport', async ({ page }) => {
    const hostname = `${'long-domain-'.repeat(5)}example.com`
    const state = fixture({
      panel: [
        row({ id: 'panel-long', hostname, note: '一条很长的备注用来确认第一行可以换行而页面不出现横向滚动', enabled: true, verificationStatus: 'verified', verifiedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
      ],
      subscription: [],
      primaryPanelDomainId: 'panel-long',
      primarySubscriptionDomainId: null,
    })
    await install(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/system/distribution')
    const rowItem = panel(page).getByRole('listitem')
    const host = rowItem.locator('.sys-domain-host')
    const controls = rowItem.locator('.sys-domain-controls')
    await expect(host).toBeVisible()
    const hostBox = await host.boundingBox()
    const controlsBox = await controls.boundingBox()
    expect(controlsBox!.y).toBeGreaterThan(hostBox!.y + hostBox!.height - 1)
    expect(await panel(page).evaluate((card) => card.scrollWidth <= card.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

    await openMenu(page, hostname)
    const menu = page.getByRole('group', { name: '行操作' })
    await expect(menu).toBeVisible()
    const menuBox = await menu.boundingBox()
    expect(menuBox!.x).toBeGreaterThanOrEqual(0)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(391)
    expect(menuBox!.y).toBeGreaterThanOrEqual(0)
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(845)
    await page.keyboard.press('Escape')

    await openMenu(page, hostname)
    await page.getByRole('button', { name: '查看详情 / DNS 配置' }).click()
    const drawer = page.getByRole('dialog', { name: hostname })
    await expect(drawer).toBeVisible()
    const full = await drawer.evaluate((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        expected: Number.parseFloat(style.getPropertyValue('--dialog-viewport-width')),
        actual: rect.width,
      }
    })
    expect(Math.abs(full.actual - full.expected)).toBeLessThan(2)
  })
})
