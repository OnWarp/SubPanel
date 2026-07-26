import { expect, test, type Page } from '@playwright/test'

test.describe.serial('Administrator frontend', () => {
  async function loginAdmin(page: Page) {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码').fill('correct horse battery staple')
    await page.getByRole('button', { name: '登录' }).click()
  }

  test('opens the administrator dashboard and exposes the core navigation', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '初始化管理员' })).toBeVisible()
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill('correct horse battery staple')
    await page.getByRole('button', { name: '创建管理员' }).click()

    await expect(page).toHaveURL(/\/login$/)
    await loginAdmin(page)

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
    await expect(page.locator('.workspace-topbar').getByRole('heading', { name: '概览' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '来源', exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '节点', exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '分组', exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '订阅', exact: true })).toBeVisible()
    await expect(page.locator('.workspace-topbar').getByRole('link', { name: 'GitHub 仓库' })).toHaveAttribute('href', 'https://github.com/kadidalax/SubPanel')
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'GitHub 仓库' })).toHaveAttribute('href', 'https://github.com/kadidalax/SubPanel')
  })

  test('previews and saves a source, then keeps the edit drawer open on backdrop clicks', async ({ page }) => {
    await loginAdmin(page)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '来源', exact: true }).click()
    await expect(page).toHaveURL(/\/catalog\/sources$/)
    await expect(page.getByRole('heading', { name: '来源', exact: true })).toBeVisible()
    const topbar = page.locator('.workspace-topbar')
    await expect(topbar.getByRole('heading', { name: '来源', exact: true })).toBeVisible()
    await expect(topbar).toContainText(/\d+ 个来源/)
    await expect(page.locator('.workspace-content .page-header')).toHaveCount(0)
    await expect(topbar.getByRole('button', { name: '退出登录' })).toHaveCount(0)
    await expect(page.locator('.sidebar-account').getByRole('button', { name: '退出登录' })).toBeVisible()
    const themeBox = await topbar.getByRole('button', { name: '主题' }).boundingBox()
    const addBox = await topbar.getByRole('button', { name: '添加来源' }).boundingBox()
    expect(themeBox).not.toBeNull()
    expect(addBox).not.toBeNull()
    expect(addBox!.x).toBeGreaterThan(themeBox!.x + themeBox!.width)

    await page.getByRole('button', { name: '添加来源' }).click()
    const drawer = page.getByRole('dialog', { name: '添加来源' })
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveClass(/drawer-medium/)
    await drawer.getByLabel('来源名称').fill('Primary source')
    await drawer.getByLabel('来源内容').fill('ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@ss.example.com:8388#Primary')
    await drawer.getByRole('button', { name: '预览' }).click()
    await expect(drawer.getByText('检测到 1 个节点')).toBeVisible()
    await drawer.getByRole('button', { name: '保存来源' }).click()
    await expect(page.getByRole('row', { name: /Primary source/ })).toBeVisible()

    await page.getByRole('row', { name: /Primary source/ }).getByRole('button', { name: '编辑' }).click()
    const editDrawer = page.getByRole('dialog', { name: '编辑来源' })
    await expect(editDrawer).toBeVisible()
    await editDrawer.dispatchEvent('pointerdown')
    await expect(editDrawer).toBeVisible()
  })

  test('keeps an edit drawer open when Escape is pressed during save', async ({ page }) => {
    await loginAdmin(page)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '来源', exact: true }).click()
    let finishSave!: () => void
    const saveGate = new Promise<void>((resolve) => { finishSave = resolve })
    await page.route('**/api/admin/catalog/sources', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await saveGate
      await route.continue()
    })

    await page.getByRole('button', { name: '添加来源' }).click()
    const drawer = page.getByRole('dialog', { name: '添加来源' })
    await drawer.getByLabel('来源名称').fill('Slow source')
    await drawer.getByLabel('来源类型').selectOption('remote')
    await drawer.getByLabel('远程 URL').fill('https://slow.example.com/subscription')
    await drawer.getByRole('button', { name: '保存来源' }).click()
    await expect(drawer.getByRole('button', { name: '保存中' })).toBeVisible()
    await page.keyboard.press('Escape')
    const remainedOpen = await drawer.isVisible()
    finishSave()
    expect(remainedOpen).toBe(true)
  })

  test('loads a real local file when the source type is file', async ({ page }) => {
    await loginAdmin(page)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '来源', exact: true }).click()
    await page.getByRole('button', { name: '添加来源' }).click()
    const drawer = page.getByRole('dialog', { name: '添加来源' })
    await drawer.getByLabel('来源名称').fill('File source')
    await drawer.getByLabel('来源类型').selectOption('file')
    const content = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@file.example.com:8388#File'
    await drawer.getByLabel('来源文件').setInputFiles({ name: 'nodes.txt', mimeType: 'text/plain', buffer: Buffer.from(content) })
    await expect(drawer.getByLabel('来源内容')).toHaveValue(content)
    await drawer.getByRole('button', { name: '预览' }).click()
    await expect(drawer.getByText('检测到 1 个节点')).toBeVisible()
    await drawer.getByRole('button', { name: '取消' }).click()
  })

  test('keeps source filters beside the title and batch actions on the right', async ({ page }) => {
    await loginAdmin(page)
    await page.setViewportSize({ width: 800, height: 800 })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '来源', exact: true }).click()
    await expect(page).toHaveURL(/\/catalog\/sources$/)
    const section = page.locator('section[aria-labelledby="sources-title"]')
    await expect(section.locator('.section-heading').getByLabel('搜索来源')).toBeVisible()
    await expect(section.locator('.section-heading').getByLabel('来源状态')).toBeVisible()
    await expect(page.locator('.workspace-topbar')).not.toContainText('个节点')
    const table = section.locator('table')
    await expect(table).toBeVisible()
    const before = await table.boundingBox()
    const row = section.getByRole('row').nth(1)
    await row.getByRole('checkbox', { name: /选择来源/ }).check()
    const toolbar = section.locator('.section-heading').getByRole('toolbar', { name: '批量操作' })
    await expect(toolbar).toBeVisible()
    const after = await table.boundingBox()
    expect(after?.y).toBe(before?.y)
    await expect(section.locator('.data-header-count')).toHaveCount(0)
    const filtersBox = await section.locator('.data-header-filters').boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    expect(filtersBox).not.toBeNull()
    expect(toolbarBox).not.toBeNull()
    expect(filtersBox!.x + filtersBox!.width).toBeLessThanOrEqual(toolbarBox!.x + 1)
  })

  test('keeps source filters available when batch actions appear on narrow screens', async ({ page }) => {
    await loginAdmin(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/catalog/sources')
    const section = page.locator('section[aria-labelledby="sources-title"]')
    const heading = section.locator('.section-heading')
    const before = await heading.boundingBox()
    const row = section.getByRole('row').nth(1)
    await row.getByRole('checkbox', { name: /选择来源/ }).check()
    const toolbar = section.getByRole('toolbar', { name: '批量操作' })
    await expect(toolbar).toBeVisible()
    await expect(section.locator('.data-header-filters')).toBeVisible()
    await expect(section.locator('.data-header-count')).toHaveCount(0)
    const after = await heading.boundingBox()
    expect(after?.y).toBe(before?.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('reports a failed result from a batch source refresh', async ({ page }) => {
    await loginAdmin(page)
    const now = new Date().toISOString()
    let finishRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => { finishRefresh = resolve })
    await page.route('**/api/admin/catalog/sources/src_1/refresh', async (route) => {
      await refreshGate
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, source: { id: 'src_1', name: 'Remote source', type: 'remote', enabled: true, warnings: [], updatedAt: now, createdAt: now } }),
      })
    })
    await page.route('**/api/admin/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        updatedAt: now,
        sources: [{ id: 'src_1', name: 'Remote source', type: 'remote', enabled: true, refreshIntervalMinutes: 60, warnings: [], updatedAt: now, createdAt: now }],
        nodes: [],
        groups: [],
      }),
    }))
    await page.goto('/catalog/sources')
    const section = page.locator('section[aria-labelledby="sources-title"]')
    const checkbox = section.getByRole('row').nth(1).getByRole('checkbox', { name: /选择来源/ })
    await checkbox.check()
    await section.getByRole('toolbar', { name: '批量操作' }).getByRole('button', { name: '刷新' }).click()
    await expect(checkbox).toBeDisabled()
    finishRefresh()
    await expect(page.getByRole('alert')).toContainText('1 项未完成')
    await expect(page.getByText('批量操作已完成', { exact: true })).toHaveCount(0)
  })

  test('allows safe edits to remote source settings without exposing stored secrets', async ({ page }) => {
    await loginAdmin(page)
    const now = new Date().toISOString()
    const source = { id: 'src_42', name: 'Remote source', type: 'remote', enabled: true, refreshIntervalMinutes: 60, remoteHost: 'remote.example.com', warnings: [], updatedAt: now, createdAt: now }
    let updateBody: Record<string, unknown> | null = null
    await page.route('**/api/admin/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: now, sources: [source], nodes: [], groups: [] }),
    }))
    await page.route('**/api/admin/catalog/sources/src_42', async (route) => {
      if (route.request().method() === 'PUT') {
        updateBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, source }) })
      } else await route.continue()
    })
    await page.goto('/catalog/sources')
    const drawer = page.getByRole('dialog', { name: '编辑来源' })
    await page.getByRole('row', { name: /Remote source/ }).getByRole('button', { name: '编辑' }).click()
    await expect(drawer.getByLabel('远程 URL')).toBeEnabled()
    await expect(drawer.getByLabel('请求 Headers')).toBeEnabled()
    await drawer.getByLabel('远程 URL').fill('https://new.example.com/source')
    await drawer.getByLabel('请求 Headers').fill('{}')
    await drawer.getByLabel('刷新周期').fill('120')
    await drawer.getByRole('button', { name: '保存修改' }).click()
    await expect.poll(() => updateBody).toEqual({
      name: 'Remote source',
      enabled: true,
      url: 'https://new.example.com/source',
      headers: {},
      refreshIntervalMinutes: 120,
    })
  })

  test('warns without shifting layout when a remote source is saved but its first fetch fails', async ({ page }) => {
    await loginAdmin(page)
    const now = new Date().toISOString()
    const source = { id: 'src_43', name: 'Failing remote', type: 'remote', enabled: true, refreshIntervalMinutes: 60, remoteHost: 'remote.example.com', lastErrorCode: 'REMOTE_FETCH_FAILED', warnings: [], updatedAt: now, createdAt: now }
    let created = false
    await page.route('**/api/admin/catalog/sources', async (route) => {
      if (route.request().method() === 'POST') {
        created = true
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: false, source }) })
      } else await route.continue()
    })
    await page.route('**/api/admin/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: now, sources: created ? [source] : [], nodes: [], groups: [] }),
    }))
    await page.goto('/catalog/sources')
    const section = page.locator('section[aria-labelledby="sources-title"]')
    const before = await section.boundingBox()
    await page.getByRole('button', { name: '添加来源' }).click()
    const drawer = page.getByRole('dialog', { name: '添加来源' })
    await drawer.getByLabel('来源名称').fill('Failing remote')
    await drawer.getByLabel('来源类型').selectOption('remote')
    await drawer.getByLabel('远程 URL').fill('https://remote.example.com/source')
    await drawer.getByRole('button', { name: '保存来源' }).click()
    const warning = page.getByRole('status')
    await expect(warning).toContainText('来源已保存，但首次抓取失败，已保留来源')
    await expect(warning).toHaveClass(/warning/)
    await expect(warning).not.toHaveClass(/success/)
    await expect(page.getByText('来源已添加', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    const after = await section.boundingBox()
    expect(after?.y).toBe(before?.y)
  })

  test('filters nodes and batch disables a selected node', async ({ page }) => {
    await loginAdmin(page)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '节点', exact: true }).click()
    await expect(page).toHaveURL(/\/catalog\/nodes$/)
    await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible()
    const nodeSection = page.locator('section[aria-labelledby="nodes-title"]')
    await expect(nodeSection.locator('.section-heading').getByLabel('搜索节点')).toBeVisible()
    await expect(page.locator('.page-toolbar[aria-label="节点筛选"]')).toHaveCount(0)
    await expect(nodeSection.locator('.data-header-count')).toHaveCount(0)

    await page.getByLabel('搜索节点').fill('Primary')
    const row = page.getByRole('row', { name: /Primary/ })
    await expect(row).toBeVisible()
    await row.getByRole('checkbox', { name: /选择节点/ }).check()
    await expect(page.getByRole('toolbar', { name: '批量操作' })).toContainText('已选择 1 项')
    await page.getByRole('toolbar', { name: '批量操作' }).getByRole('button', { name: '停用' }).click()
    const confirm = page.getByRole('dialog', { name: '停用节点' })
    await expect(confirm).toBeVisible()
    await confirm.dispatchEvent('pointerdown')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '确认停用' }).click()
    await expect(row.getByText('已停用')).toBeVisible()
  })

  test('paginates nodes and shows source node counts', async ({ page }) => {
    await loginAdmin(page)
    const now = new Date().toISOString()
    const source = { id: 'many-source', name: 'Many source', type: 'manual', enabled: true, warnings: [], updatedAt: now, createdAt: now }
    const nodes = Array.from({ length: 25 }, (_, index) => ({
      id: `many-node-${index}`,
      protocol: 'ss',
      displayName: `Many node ${index + 1}`,
      server: `node-${index + 1}.example.com`,
      port: 8388,
      sourceIds: [source.id],
      enabled: true,
      retained: false,
      order: index,
      updatedAt: now,
      createdAt: now,
    }))
    await page.route('**/api/admin/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: now, sources: [source], nodes, groups: [] }),
    }))

    await page.goto('/catalog/nodes')
    const section = page.locator('section[aria-labelledby="nodes-title"]')
    await expect(section.locator('tbody tr')).toHaveCount(20)
    await expect(section.getByRole('columnheader', { name: '序号' })).toBeVisible()
    await expect(section.locator('tbody tr').first().getByRole('cell').nth(1)).toHaveText('1')
    await expect(section.getByText('第 1 / 2 页')).toBeVisible()
    await section.getByLabel('选择当前页节点').check()
    await expect(section.getByRole('toolbar', { name: '批量操作' })).toContainText('已选择 20 项')
    await expect(section.locator('tbody tr')).toHaveCount(20)
    await section.getByRole('button', { name: '下一页' }).click()
    await expect(section.locator('tbody tr').first().getByRole('cell').nth(1)).toHaveText('21')
    await section.getByLabel('每页显示').selectOption('50')
    await expect(section.locator('tbody tr')).toHaveCount(25)
    await expect(section.getByText('第 1 / 1 页')).toBeVisible()

    await page.goto('/catalog/sources')
    await expect(page.getByRole('columnheader', { name: '节点' })).toBeVisible()
    await expect(page.getByRole('row', { name: /Many source/ }).getByRole('cell').nth(4)).toHaveText('25')
  })

  test('creates a group and keeps edit and batch confirmation surfaces open on backdrop clicks', async ({ page }) => {
    await loginAdmin(page)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '分组', exact: true }).click()
    await expect(page).toHaveURL(/\/catalog\/groups$/)
    await expect(page.getByRole('heading', { name: '分组', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '添加分组' }).click()
    const createDrawer = page.getByRole('dialog', { name: '添加分组' })
    await expect(createDrawer).toHaveClass(/drawer-wide/)
    await createDrawer.getByLabel('分组名称').fill('Primary group')
    await createDrawer.getByRole('button', { name: '全选包含来源' }).click()
    await expect(createDrawer.getByLabel('包含来源 Primary source').first()).toBeChecked()
    await createDrawer.getByRole('button', { name: '反选包含来源' }).click()
    await expect(createDrawer.getByLabel('包含来源 Primary source').first()).not.toBeChecked()
    await createDrawer.getByLabel('包含来源 Primary source').first().check()
    await createDrawer.getByRole('button', { name: '全选单独包含节点' }).click()
    await createDrawer.getByRole('button', { name: '反选单独包含节点' }).click()
    await createDrawer.getByRole('button', { name: '保存分组' }).click()

    const row = page.getByRole('row', { name: /Primary group/ }).last()
    await expect(row).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '来源数' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '节点数' })).toBeVisible()
    await expect(row.getByRole('cell').nth(2)).toHaveText('1')
    await expect(row.getByRole('cell').nth(3)).toHaveText('0')
    await row.getByRole('button', { name: '编辑' }).click()
    const editDrawer = page.getByRole('dialog', { name: '编辑分组' })
    await editDrawer.dispatchEvent('pointerdown')
    await expect(editDrawer).toBeVisible()
    await editDrawer.locator('.drawer-content').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(editDrawer.getByRole('button', { name: '关闭' })).toBeInViewport()
    await editDrawer.getByRole('button', { name: '关闭' }).click()

    await row.getByRole('checkbox', { name: /选择分组/ }).check()
    await page.getByRole('toolbar', { name: '批量操作' }).getByRole('button', { name: '删除' }).click()
    const confirm = page.getByRole('dialog', { name: '删除分组' })
    await confirm.dispatchEvent('pointerdown')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
  })

  test('creates a subscription, shows links and diagnostics, and exposes batch controls', async ({ page }) => {
    await loginAdmin(page)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '订阅', exact: true }).click()
    await expect(page).toHaveURL(/\/delivery\/subscriptions$/)
    await expect(page.getByRole('heading', { name: '订阅', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '添加订阅' }).click()
    const createDrawer = page.getByRole('dialog', { name: '添加订阅' })
    await expect(createDrawer).toHaveClass(/drawer-medium/)
    await createDrawer.getByLabel('订阅名称').fill('Primary subscription')
    await createDrawer.getByLabel('所属用户').selectOption({ index: 0 })
    await createDrawer.getByRole('button', { name: '全选使用分组' }).click()
    await expect(createDrawer.getByLabel('使用分组 Primary group')).toBeChecked()
    await createDrawer.getByRole('button', { name: '反选使用分组' }).click()
    await createDrawer.getByLabel('使用分组 Primary group').check()
    await createDrawer.getByRole('button', { name: '保存订阅' }).click()

    const row = page.getByRole('row', { name: /Primary subscription/ })
    await expect(row).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '来源数' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '节点数' })).toBeVisible()
    await expect(row.getByRole('cell').nth(3)).toHaveText('1')
    await expect(row.getByRole('cell').nth(4)).toHaveText('1')
    await expect(row.getByRole('cell').nth(5)).toHaveText('0')
    await row.getByRole('button', { name: '查看详情' }).click()
    const details = page.getByRole('dialog', { name: '订阅详情' })
    await expect(details).toHaveClass(/drawer-large/)
    await expect(details.getByText('客户端链接')).toBeVisible()
    const diagnostics = details.locator('details').filter({ hasText: '兼容诊断' })
    await expect(diagnostics).toHaveAttribute('open', '')
    await diagnostics.getByText('兼容诊断', { exact: true }).click()
    await expect(diagnostics).not.toHaveAttribute('open', '')
    await details.getByRole('button', { name: '显示 Mihomo 二维码' }).click()
    const qrDialog = page.getByRole('dialog', { name: 'Mihomo 二维码' })
    await expect(qrDialog.getByRole('img', { name: 'Mihomo 订阅二维码' })).toBeVisible()
    await qrDialog.getByRole('button', { name: '关闭' }).click()
    await details.dispatchEvent('pointerdown')
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: '关闭' }).click()

    await row.getByRole('checkbox', { name: /选择订阅/ }).check()
    await page.getByRole('toolbar', { name: '批量操作' }).getByRole('button', { name: '停用' }).click()
    const confirm = page.getByRole('dialog', { name: '停用订阅' })
    await confirm.dispatchEvent('pointerdown')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
  })

  test('adds invite batch controls while keeping the administrator unselectable', async ({ page }) => {
    await loginAdmin(page)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '用户与邀请', exact: true }).click()
    await expect(page).toHaveURL(/\/users$/)
    const topbar = page.locator('.workspace-topbar')
    await expect(topbar.getByRole('button', { name: '创建邀请' })).toBeVisible()
    await expect(topbar.getByLabel('邀请用户名')).toHaveCount(0)
    await expect(page.locator('section[aria-labelledby="users-title"] .section-heading').getByLabel('邀请用户名')).toBeVisible()
    await expect(page.locator('section[aria-labelledby="invites-title"] .section-heading').getByLabel('邀请用户名')).toHaveCount(0)
    await expect(page.locator('.nav-section').filter({ has: page.getByText('监控', { exact: true }) }).getByRole('link', { name: '节点', exact: true })).toBeVisible()
    expect(await topbar.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(60)
    expect(Number.parseFloat(await topbar.getByRole('heading', { name: '用户与邀请' }).evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(18)

    for (const username of ['batch-one', 'batch-two']) {
      await page.getByLabel('邀请用户名').fill(username)
      await page.getByRole('button', { name: '创建邀请' }).click()
      await expect(page.getByRole('row', { name: new RegExp(username) })).toBeVisible()
    }

    const adminRow = page.getByRole('row', { name: /admin/ })
    await expect(adminRow.getByRole('checkbox', { name: /启用 admin/ })).toBeDisabled()
    await page.getByRole('row', { name: /batch-one/ }).getByRole('checkbox', { name: /选择邀请/ }).check()
    await page.getByRole('row', { name: /batch-two/ }).getByRole('checkbox', { name: /选择邀请/ }).check()
    const toolbar = page.getByRole('toolbar', { name: '批量操作' })
    await expect(toolbar).toContainText('已选择 2 项')
    await page.setViewportSize({ width: 390, height: 844 })
    const more = toolbar.getByRole('button', { name: '更多批量操作' })
    await expect(more).toBeVisible()
    await more.click()
    await toolbar.locator('.batch-more-menu').getByRole('button', { name: '撤销' }).click()
    const confirm = page.getByRole('dialog', { name: '撤销邀请' })
    await confirm.dispatchEvent('pointerdown')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
  })

  test('keeps the password reset dialog open while its request is running', async ({ page }) => {
    await loginAdmin(page)
    await page.goto('/users')
    await page.getByLabel('邀请用户名').fill('reset-target')
    await page.getByRole('button', { name: '创建邀请' }).click()
    const inviteToken = new URL(await page.getByRole('textbox', { name: '邀请链接' }).inputValue()).pathname.split('/').at(-1)
    const redeemed = await page.request.post(`/api/invites/${inviteToken}`, {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { password: 'reset target password' },
    })
    expect(redeemed.status()).toBe(201)
    await page.reload()

    let finishReset!: () => void
    const resetGate = new Promise<void>((resolve) => { finishReset = resolve })
    await page.route('**/api/admin/users/*/password', async (route) => {
      await resetGate
      await route.continue()
    })
    await page.getByRole('row', { name: /reset-target/ }).getByRole('button', { name: /重置 reset-target 的密码/ }).click()
    const dialog = page.getByRole('dialog', { name: '重置用户密码' })
    await dialog.getByLabel('新密码', { exact: true }).fill('new reset target password')
    await dialog.getByLabel('确认新密码').fill('new reset target password')
    await dialog.getByRole('button', { name: '确认重置' }).click()
    await expect(dialog.getByRole('button', { name: '确认重置' })).toBeDisabled()
    await page.keyboard.press('Escape')
    const remainedOpen = await dialog.isVisible()
    finishReset()
    expect(remainedOpen).toBe(true)
  })
})
