import { expect, test, type Page } from '@playwright/test'

test.describe.serial('Administrator frontend', () => {
  async function loginAdmin(page: Page) {
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('correct horse battery staple')
    await page.getByRole('button', { name: '登录' }).click()
  }

  const sidebar = (page: Page) => page.getByRole('navigation', { name: '主导航' })
  async function openNodeSection(page: Page, label: string) {
    await sidebar(page).getByRole('link', { name: '节点管理', exact: true }).click()
    await page.getByRole('navigation', { name: '节点管理导航' }).getByRole('link', { name: label, exact: true }).click()
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
    await expect(sidebar(page).getByRole('link')).toHaveText(['概览', '节点管理', '订阅管理', '用户管理', '运营管理', '系统设置'])
    await sidebar(page).getByRole('link', { name: '节点管理', exact: true }).click()
    await expect(page).toHaveURL(/\/catalog\/nodes$/)
    await expect(page.getByRole('navigation', { name: '节点管理导航' }).getByRole('link')).toHaveText(['节点', '来源', '分组'])
  })

  test('previews and saves a source, then keeps the edit drawer open on backdrop clicks', async ({ page }) => {
    await loginAdmin(page)
    await openNodeSection(page, '来源')
    await expect(page).toHaveURL(/\/catalog\/sources$/)
    await expect(page.getByRole('heading', { name: '来源', exact: true })).toBeVisible()
    const card = page.getByRole('region', { name: '来源', exact: true })
    await expect(card.getByRole('group', { name: '筛选' }).getByRole('button', { name: '添加来源' })).toBeVisible()
    await expect(card.locator('footer')).toContainText(/共 \d+ 个来源/)
    await expect(page.locator('.workspace-topbar').getByRole('button', { name: '退出登录' })).toHaveCount(0)
    await page.locator('.sidebar .admin-account summary').click()
    const accountMenu = page.getByRole('navigation', { name: '管理员账号菜单' })
    await expect(accountMenu.getByRole('button', { name: '退出登录' })).toBeVisible()
    await expect(accountMenu.getByRole('button', { name: '外观' })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '添加来源' }).click()
    const drawer = page.getByRole('dialog', { name: '添加来源' })
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveAttribute('data-size', 'l')
    await drawer.getByLabel('来源名称').fill('Primary source')
    await drawer.getByLabel('来源内容').fill('ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@ss.example.com:8388#Primary')
    await drawer.getByRole('button', { name: '预览' }).click()
    await expect(drawer.getByText('检测到 1 个节点')).toBeVisible()
    await drawer.getByRole('button', { name: '保存来源' }).click()
    await expect(page.getByRole('row', { name: /Primary source/ })).toBeVisible()

    await page.getByRole('row', { name: /Primary source/ }).getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('row', { name: /Primary source/ }).getByRole('button', { name: '编辑' }).click()
    const editDrawer = page.getByRole('dialog', { name: '编辑来源' })
    await expect(editDrawer).toBeVisible()
    await editDrawer.dispatchEvent('pointerdown')
    await expect(editDrawer).toBeVisible()
  })

  test('keeps an edit drawer open when Escape is pressed during save', async ({ page }) => {
    await loginAdmin(page)
    await openNodeSection(page, '来源')
    await page.route('**/api/admin/catalog/sources/*/preview-diff', (route) => route.fulfill({
      status: 422, json: { error: { code: 'REMOTE_FETCH_FAILED', message: '远程来源请求失败' } },
    }))
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
    await drawer.getByLabel('来源类型').click()
    await drawer.getByRole('option', { name: '远程订阅', exact: true }).click()
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
    await openNodeSection(page, '来源')
    await page.getByRole('button', { name: '添加来源' }).click()
    const drawer = page.getByRole('dialog', { name: '添加来源' })
    await drawer.getByLabel('来源名称').fill('File source')
    await drawer.getByLabel('来源类型').click()
    await drawer.getByRole('option', { name: '文件导入', exact: true }).click()
    const content = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@file.example.com:8388#File'
    await drawer.locator('input[type="file"]').setInputFiles({ name: 'nodes.txt', mimeType: 'text/plain', buffer: Buffer.from(content) })
    await expect(drawer.getByLabel('来源内容')).toHaveValue(content)
    await drawer.getByRole('button', { name: '预览' }).click()
    await expect(drawer.getByText('检测到 1 个节点')).toBeVisible()
    await drawer.getByRole('button', { name: '取消' }).click()
  })

  test('keeps source filters and batch actions in the data section', async ({ page }) => {
    await loginAdmin(page)
    await page.setViewportSize({ width: 800, height: 800 })
    await openNodeSection(page, '来源')
    await expect(page).toHaveURL(/\/catalog\/sources$/)
    const section = page.locator('section[aria-labelledby="sources-title"]')
    await expect(section.locator('.catalog-filters').getByLabel('搜索来源')).toBeVisible()
    await expect(section.locator('.catalog-filters').getByLabel('来源状态')).toBeVisible()
    await expect(page.locator('.workspace-topbar')).not.toContainText('个节点')
    const table = section.locator('table')
    await expect(table).toBeVisible()
    const row = section.getByRole('row').nth(1)
    await row.getByRole('checkbox', { name: /选择来源/ }).check()
    const toolbar = section.getByRole('toolbar', { name: '批量操作' })
    await expect(toolbar).toBeVisible()
    await expect(section.locator('.catalog-filters').getByLabel('搜索来源')).toBeVisible()
    await expect(section.locator('.catalog-filters').getByLabel('来源状态')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(section.locator('footer')).toBeVisible()
    const filtersBox = await section.locator('.catalog-filters').boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    expect(filtersBox).not.toBeNull()
    expect(toolbarBox).not.toBeNull()
    expect(filtersBox!.y + filtersBox!.height).toBeLessThanOrEqual(toolbarBox!.y + 1)
  })

  test('keeps source filters available when batch actions appear on narrow screens', async ({ page }) => {
    await loginAdmin(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/catalog/sources')
    const section = page.locator('section[aria-labelledby="sources-title"]')
    await section.getByRole('checkbox', { name: '选择全部来源' }).check()
    await expect(section.getByRole('checkbox', { name: /选择来源/ }).first()).toBeChecked()
    const toolbar = section.getByRole('toolbar', { name: '批量操作' })
    await expect(toolbar).toBeVisible()
    await expect(section.locator('.catalog-filters')).toBeVisible()
    await expect(section.locator('footer')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('reports a failed batch refresh preview without confirming it', async ({ page }) => {
    await loginAdmin(page)
    const now = new Date().toISOString()
    let finishRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => { finishRefresh = resolve })
    await page.route('**/api/admin/catalog/sources/src_1/preview-diff', async (route) => {
      await refreshGate
      await route.fulfill({ status: 422, json: { error: { code: 'REMOTE_HTTP_ERROR', message: '来源返回 HTTP 错误' } } })
    })
    await page.route('**/api/admin/catalog', (route) => route.fulfill({ json: {
      schemaVersion: 2, revision: 1, updatedAt: now,
      sources: [{ id: 'src_1', name: 'Remote source', type: 'remote', enabled: true, refreshIntervalMinutes: 60, warnings: [], updatedAt: now, createdAt: now }],
      nodes: [], groups: [],
    } }))
    await page.goto('/catalog/sources')
    const section = page.locator('section[aria-labelledby="sources-title"]')
    await section.getByRole('checkbox', { name: '选择来源 Remote source' }).check()
    await section.getByRole('toolbar', { name: '批量操作' }).getByRole('button', { name: '刷新' }).click()
    const drawer = page.getByRole('dialog', { name: '同步差异预览' })
    await expect(drawer.getByRole('button', { name: '确认同步' })).toBeDisabled()
    finishRefresh()
    await expect(drawer.getByRole('alert')).toContainText('来源返回 HTTP 错误')
    await expect(drawer.getByRole('button', { name: '确认同步' })).toBeDisabled()
  })

  test('allows safe edits to remote source settings without exposing stored secrets', async ({ page }) => {
    await loginAdmin(page)
    const now = new Date().toISOString()
    const source = { id: 'src_42', name: 'Remote source', type: 'remote', enabled: true, keepOnFailure: true, refreshIntervalMinutes: 60, remoteHost: 'remote.example.com', warnings: [], updatedAt: now, createdAt: now }
    let updateBody: Record<string, unknown> | null = null
    await page.route('**/api/admin/catalog', (route) => route.fulfill({ json: { schemaVersion: 2, revision: 1, updatedAt: now, sources: [source], nodes: [], groups: [] } }))
    await page.route('**/api/admin/catalog/sources/src_42', async (route) => {
      if (route.request().method() === 'PUT') {
        updateBody = route.request().postDataJSON() as Record<string, unknown>
        await route.fulfill({ json: { success: true, source } })
      } else await route.continue()
    })
    await page.goto('/catalog/sources')
    const drawer = page.getByRole('dialog', { name: '编辑来源' })
    const row = page.getByRole('row', { name: /Remote source/ })
    await row.getByRole('button', { name: '更多操作' }).click()
    await row.getByRole('button', { name: '编辑' }).click()
    await drawer.getByText('高级设置', { exact: true }).click()
    await expect(drawer.getByText('同步失败时保留上次成功导入的节点')).toBeVisible()
    await expect(drawer.getByLabel('远程 URL')).toHaveValue('')
    await expect(drawer.getByLabel('请求 Headers')).toHaveValue('')
    await drawer.getByLabel('远程 URL').fill('https://new.example.com/source')
    await drawer.getByLabel('请求 Headers').fill('{}')
    await drawer.getByLabel('刷新周期').fill('120')
    await drawer.getByLabel('导入格式').click()
    await drawer.getByRole('option', { name: 'Mihomo' }).click()
    await drawer.getByRole('button', { name: '保存修改' }).click()
    await expect.poll(() => updateBody).toEqual({
      name: 'Remote source', enabled: true, url: 'https://new.example.com/source', headers: {},
      refreshIntervalMinutes: 120, formatOverride: 'mihomo',
    })
  })

  test('keeps the remote source settings after the first preview fails', async ({ page }) => {
    await loginAdmin(page)
    const now = new Date().toISOString()
    const source = { id: 'src_43', name: 'Failing remote', type: 'remote', enabled: true, refreshIntervalMinutes: 60, warnings: [], updatedAt: now, createdAt: now }
    let created = false
    await page.route('**/api/admin/catalog/sources', async (route) => {
      created = true
      await route.fulfill({ status: 201, json: { success: true, source } })
    })
    await page.route('**/api/admin/catalog/sources/src_43/preview-diff', (route) => route.fulfill({
      status: 422, json: { error: { code: 'REMOTE_FETCH_FAILED', message: '远程来源请求失败' } },
    }))
    await page.route('**/api/admin/catalog', (route) => route.fulfill({ json: {
      schemaVersion: 2, revision: 1, updatedAt: now, sources: created ? [source] : [], nodes: [], groups: [],
    } }))
    await page.goto('/catalog/sources')
    await page.getByRole('button', { name: '添加来源' }).click()
    const drawer = page.getByRole('dialog', { name: '添加来源' })
    await drawer.getByLabel('来源名称').fill('Failing remote')
    await drawer.getByLabel('来源类型').click()
    await drawer.getByRole('option', { name: '远程订阅', exact: true }).click()
    await drawer.getByLabel('远程 URL').fill('https://remote.example.com/source')
    await drawer.getByRole('button', { name: '保存来源' }).click()
    const preview = page.getByRole('dialog', { name: '同步差异预览' })
    await expect(preview.getByRole('alert')).toContainText('远程来源请求失败')
    await expect(preview.getByRole('button', { name: '确认同步' })).toBeDisabled()
    await preview.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('row', { name: /Failing remote/ })).toBeVisible()
  })

  test('filters nodes and batch disables a selected node', async ({ page }) => {
    await loginAdmin(page)
    await sidebar(page).getByRole('link', { name: '节点管理', exact: true }).click()
    await expect(page).toHaveURL(/\/catalog\/nodes$/)
    await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible()
    const nodeSection = page.locator('section[aria-labelledby="nodes-title"]')
    await expect(nodeSection.locator('.catalog-filters').getByLabel('搜索节点')).toBeVisible()
    await expect(page.locator('.page-toolbar[aria-label="节点筛选"]')).toHaveCount(0)
    await expect(nodeSection.locator('footer')).toBeVisible()

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
    await expect(section.getByText('1 / 2 页')).toBeVisible()
    await section.getByLabel('选择当前页节点').check()
    await expect(section.getByRole('toolbar', { name: '批量操作' })).toContainText('已选择 20 项')
    await expect(section.locator('tbody tr')).toHaveCount(20)
    await section.getByRole('button', { name: '下一页' }).click()
    await expect(section.locator('tbody tr').first().getByRole('cell').nth(1)).toHaveText('21')
    await section.getByLabel('每页显示').click()
    await section.getByRole('option', { name: '50', exact: true }).click()
    await expect(section.locator('tbody tr')).toHaveCount(25)
    await expect(section.getByText('1 / 1 页')).toBeVisible()

    await page.goto('/catalog/sources')
    await expect(page.getByRole('columnheader', { name: '节点' })).toBeVisible()
    await expect(page.getByRole('row', { name: /Many source/ }).getByRole('cell').nth(4)).toHaveText('25')
  })

  test('creates a group and keeps edit and batch confirmation surfaces open on backdrop clicks', async ({ page }) => {
    await loginAdmin(page)
    await openNodeSection(page, '分组')
    await expect(page).toHaveURL(/\/catalog\/groups$/)
    await expect(page.getByRole('heading', { name: '分组', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '添加分组' }).click()
    const createDrawer = page.getByRole('dialog', { name: '添加分组' })
    await expect(createDrawer).toHaveAttribute('data-size', 'l')
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
    await row.getByRole('button', { name: '更多操作' }).click()
    await row.getByRole('button', { name: '编辑' }).click()
    const editDrawer = page.getByRole('dialog', { name: '编辑分组' })
    await editDrawer.dispatchEvent('pointerdown')
    await expect(editDrawer).toBeVisible()
    await editDrawer.locator('.sp-dialog-body').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(editDrawer.getByRole('button', { name: '关闭' })).toBeInViewport()
    await editDrawer.getByRole('button', { name: '关闭' }).click()

    await page.getByRole('checkbox', { name: '选择全部分组' }).check()
    await expect(row.getByRole('checkbox', { name: /选择分组/ })).toBeChecked()
    await page.getByRole('checkbox', { name: '选择全部分组' }).uncheck()
    await row.getByRole('checkbox', { name: /选择分组/ }).check()
    await page.getByRole('toolbar', { name: '批量操作' }).getByRole('button', { name: '删除' }).click()
    const confirm = page.getByRole('dialog', { name: '删除分组' })
    await confirm.dispatchEvent('pointerdown')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
  })

  test('creates a subscription, shows links and diagnostics, and exposes batch controls', async ({ page }, testInfo) => {
    await loginAdmin(page)
    await sidebar(page).getByRole('link', { name: '订阅管理', exact: true }).click()
    await expect(page).toHaveURL(/\/delivery\/subscriptions$/)
    await expect(page.getByRole('heading', { name: '订阅', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '添加订阅' }).click()
    const createDrawer = page.getByRole('dialog', { name: '添加订阅' })
    await expect(createDrawer).toHaveAttribute('data-size', 'l')
    await createDrawer.getByLabel('订阅名称').fill('Primary subscription')
    await createDrawer.getByLabel('所属用户').click()
    await createDrawer.getByRole('option').first().click()
    await createDrawer.getByRole('button', { name: '全选使用分组' }).click()
    await expect(createDrawer.getByLabel('使用分组 Primary group')).toBeChecked()
    await createDrawer.getByRole('button', { name: '反选使用分组' }).click()
    await createDrawer.getByLabel('使用分组 Primary group').check()
    await createDrawer.getByRole('button', { name: '保存订阅' }).click()

    const row = page.getByRole('row', { name: /Primary subscription/ })
    await expect(row).toBeVisible()
    await expect(row.getByRole('cell').nth(3)).toHaveText('Primary group')
    await expect(row.getByRole('cell').nth(4)).toHaveText('正常')
    await expect(row.getByRole('cell').nth(5)).toHaveText(/^创建 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}更新 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/)
    await row.getByRole('button', { name: '更多操作' }).click()
    await row.getByRole('button', { name: '查看详情' }).click()
    const details = page.getByRole('dialog', { name: 'Primary subscription', exact: true })
    await expect(details).toHaveAttribute('data-size', 'l')
    await expect(details.getByText('客户端链接')).toBeVisible()
    await expect(details.getByText('正常', { exact: true })).toBeVisible()
    await expect(details.getByText('生效方式')).toBeVisible()
    await expect(details.getByText('继承默认')).toBeVisible()
    await expect(details.getByText('模板', { exact: true })).toBeVisible()
    await expect(details.getByText('发布版本')).toBeVisible()
    await details.getByText('更多导入方式', { exact: true }).click()
    const formats = details.getByRole('combobox', { name: '查看格式' })
    const links = details.locator('.subscription-link-row .link-url')
    await expect(formats).toHaveText('Mihomo')
    await expect(links).toHaveCount(1)
    const primaryLink = await links.innerText()
    await formats.click()
    await details.getByRole('option', { name: 'sing-box', exact: true }).click()
    await expect(links).toHaveText(primaryLink)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await details.getByRole('button', { name: '复制 sing-box 链接' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${primaryLink}/singbox`)
    await formats.click()
    await details.getByRole('option', { name: 'Mihomo', exact: true }).click()
    const detailActions = details.getByRole('button', { name: '更多操作' })
    await detailActions.click()
    await expect(details.getByRole('button', { name: '重置令牌' })).toBeVisible()
    await detailActions.click()
    await expect(details.getByRole('button', { name: '重置令牌' })).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('drawer-wide.png'), animations: 'disabled' })
    const desktopViewport = page.viewportSize()!
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(details).toHaveCSS('width', '390px')
    await expect(links).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('drawer-narrow.png'), animations: 'disabled' })
    await page.setViewportSize(desktopViewport)
    const diagnostics = details.locator('details').filter({ hasText: '兼容诊断' })
    await expect(diagnostics).not.toHaveAttribute('open', '')
    await diagnostics.getByText('兼容诊断', { exact: true }).click()
    await expect(diagnostics).toHaveAttribute('open', '')
    await details.getByRole('button', { name: '显示 Mihomo 二维码' }).click()
    const qrDialog = page.getByRole('dialog', { name: 'Mihomo 二维码' })
    await expect(qrDialog.getByRole('img', { name: 'Mihomo 订阅二维码' })).toBeVisible()
    await qrDialog.getByRole('button', { name: '关闭' }).click()
    await details.dispatchEvent('pointerdown')
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: '关闭' }).click()
    const more = row.getByRole('button', { name: '更多操作' })
    await expect(more).toBeFocused()

    const search = page.getByRole('searchbox', { name: '搜索订阅' })
    await search.fill('Primary subscription')
    await expect(row).toBeVisible()
    const selectedRow = row.getByRole('checkbox', { name: /选择订阅/ })
    await selectedRow.check()
    const workspace = await page.locator('.workspace-content').elementHandle()
    const history = await page.evaluate(() => history.length)
    const url = page.url()
    await page.getByRole('button', { name: '收起侧栏' }).click()

    const sidebarAccount = page.locator('.sidebar .admin-account summary')
    await sidebarAccount.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '侧边栏', pressed: true })).toBeVisible()
    const topbarOption = page.getByRole('button', { name: '顶部导航', exact: true })
    await topbarOption.focus()
    await page.keyboard.press('Enter')

    const topbarAccount = page.locator('.admin-desktop-topbar .admin-account summary')
    await expect(topbarAccount).toBeFocused()
    await expect(sidebar(page).getByRole('link')).toHaveText(['概览', '节点', '订阅', '用户', '运营', '设置'])
    // Subscriptions sit in a domain that has section tabs. The domain link marks
    // the location; the section tab marks the page.
    await expect(sidebar(page).getByRole('link', { name: '订阅', exact: true })).toHaveAttribute('aria-current', 'location')
    await expect(page.getByRole('navigation', { name: '订阅管理导航' }).getByRole('link', { name: '订阅列表', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page).toHaveURL(url)
    expect(await page.evaluate(() => history.length)).toBe(history)
    expect(await workspace?.evaluate(element => element === document.querySelector('.workspace-content'))).toBe(true)
    await expect(search).toHaveValue('Primary subscription')
    await expect(selectedRow).toBeChecked()

    await more.click()
    await row.getByRole('button', { name: '查看详情' }).click()
    await expect(details.getByText('客户端链接')).toBeVisible()
    await details.getByRole('button', { name: '显示 Mihomo 二维码' }).click()
    await expect(qrDialog).toBeVisible()
    await qrDialog.getByRole('button', { name: '关闭' }).click()
    await details.getByRole('button', { name: '关闭' }).click()
    await expect(more).toBeFocused()
    await expect(selectedRow).toBeChecked()

    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: 760, height: viewport.height })
    await expect(page.locator('.admin-mobile-dock')).toBeVisible()
    await expect(page.locator('.admin-desktop-topbar')).toBeHidden()
    await expect(sidebar(page)).toHaveCount(1)
    await page.setViewportSize(viewport)
    await expect(topbarAccount).toBeVisible()
    await topbarAccount.click()
    await expect(page.getByRole('button', { name: '顶部导航', pressed: true })).toBeVisible()
    await page.getByRole('button', { name: '侧边栏', exact: true }).click()
    await expect(sidebarAccount).toBeFocused()
    await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible()
    await expect(selectedRow).toBeChecked()
    await sidebarAccount.click()
    await page.getByRole('button', { name: '顶部导航', exact: true }).click()
    await page.reload()
    await expect(topbarAccount).toBeVisible()
    await expect(page).toHaveURL(url)

    await page.getByRole('checkbox', { name: '选择当前页订阅' }).check()
    await expect(row.getByRole('checkbox', { name: /选择订阅/ })).toBeChecked()
    await page.getByRole('checkbox', { name: '选择当前页订阅' }).uncheck()
    await row.getByRole('checkbox', { name: /选择订阅/ }).check()
    await page.getByRole('toolbar', { name: '批量操作' }).getByRole('button', { name: '停用' }).click()
    const confirm = page.getByRole('dialog', { name: '停用订阅' })
    await confirm.dispatchEvent('pointerdown')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
  })

  test('keeps share filters, actions and confirmation usable at narrow widths', async ({ page }) => {
    await loginAdmin(page)
    await page.setViewportSize({ width: 390, height: 844 })
    const share = {
      id: 'share_demo', ownerUserId: 'owner_demo', subscriptionId: 'sub_demo',
      tokenPrefix: 'example', remark: 'Example share', status: 'active',
      expiresAt: '2099-01-01T00:00:00Z', accessCount: 0, maxAccessCount: null,
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
    }
    await page.route('**/api/admin/shares', (route) => route.fulfill({ json: { shares: [share] } }))
    await page.goto('/delivery/shares')

    const card = page.getByRole('region', { name: '分享管理', exact: true })
    await expect(card.getByRole('combobox', { name: '分享状态' })).toBeVisible()
    await expect(card.locator('footer')).toContainText('共 1 个分享')
    const row = card.locator('tbody tr').filter({ hasText: 'Example share' })
    const more = row.getByRole('button', { name: '更多操作' })
    await more.press('Enter')
    await expect(row.getByRole('button', { name: '禁用分享 Example share' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(row.getByRole('button', { name: '禁用分享 Example share' })).toBeHidden()
    await more.click()
    await row.getByRole('button', { name: '撤销分享 Example share' }).click()
    await expect(page.getByRole('dialog', { name: '撤销分享' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('adds invite-code batch controls while keeping the administrator from being disabled', async ({ page }) => {
    await loginAdmin(page)
    await sidebar(page).getByRole('link', { name: '用户管理', exact: true }).click()
    await expect(page).toHaveURL(/\/users$/)
    const topbar = page.locator('.workspace-topbar')
    await expect(topbar.getByRole('heading', { name: '用户管理' })).toBeVisible()
    await expect(topbar.getByRole('button', { name: '创建邀请' })).toHaveCount(0)
    await expect(page.getByLabel('邀请用户名')).toHaveCount(0)
    expect(await topbar.evaluate((element) => getComputedStyle(element).height)).toBe('48px')
    expect(await topbar.getByRole('heading', { name: '用户管理' }).evaluate((element) => getComputedStyle(element).fontSize)).toBe('20px')

    const adminRow = page.getByRole('row', { name: /admin/ })
    await adminRow.getByLabel('admin 的操作').click()
    await expect(adminRow.getByRole('menuitem', { name: '停用' })).toBeDisabled()
    await page.keyboard.press('Escape')

    const section = page.locator('section[aria-labelledby="users-card-title"]')
    await section.getByRole('button', { name: '邀请用户' }).click()
    await expect(page).toHaveURL(/\/invites$/)
    await expect(page.getByRole('heading', { name: '注册邀请码' })).toBeVisible()
    await expect(page.getByLabel('邀请用户名')).toHaveCount(0)
    await page.getByRole('button', { name: '批量单次' }).click()
    await page.getByLabel('生成数量').fill('2')
    await page.getByRole('button', { name: '生成邀请码' }).click()
    const codes = page.getByRole('checkbox', { name: /选择邀请码/ })
    await expect(codes).toHaveCount(2)
    await codes.nth(0).check()
    await codes.nth(1).check()
    const toolbar = page.getByRole('toolbar', { name: '批量操作' })
    await expect(toolbar).toContainText('已选择 2 项')
    await page.setViewportSize({ width: 390, height: 844 })
    const more = toolbar.getByRole('button', { name: '更多批量操作' })
    await expect(more).toBeVisible()
    await more.click()
    await toolbar.locator('.batch-more-menu').getByRole('button', { name: '停用' }).click()
    const confirm = page.getByRole('dialog', { name: '停用邀请码' })
    await confirm.dispatchEvent('pointerdown')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
  })

  test('keeps the password reset dialog open while its request is running', async ({ page }) => {
    await loginAdmin(page)
    await expect(page).toHaveURL(/\/dashboard$/)
    const api = async (method: 'PUT' | 'POST', path: string, data: Record<string, unknown>) => {
      const result = await page.evaluate(async ({ method, path, data }) => {
        const response = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        return { ok: response.ok, status: response.status, body: await response.text() }
      }, { method, path, data })
      expect(result.ok, `${method} ${path} returned ${result.status} ${result.body}`).toBe(true)
      return (result.body ? JSON.parse(result.body) : {}) as Record<string, any>
    }
    await api('PUT', '/api/admin/system/registration', { mode: 'invite' })
    const invite = await api('POST', '/api/admin/invites', {})
    const redeemed = await api('POST', '/api/register', {
      username: 'reset-target',
      password: 'reset target password',
      email: 'reset-target@example.com',
      inviteCode: String(invite.invite.code),
    })
    expect(redeemed.user?.id).toBeTruthy()
    await api('POST', '/api/login', { username: 'admin', password: 'correct horse battery staple' })
    await page.goto('/users')

    let finishReset!: () => void
    const resetGate = new Promise<void>((resolve) => { finishReset = resolve })
    await page.route('**/api/admin/users/*/reset-password', async (route) => {
      await resetGate
      await route.continue()
    })
    const row = page.getByRole('row', { name: /reset-target/ })
    await row.getByLabel('reset-target 的操作').click()
    await row.getByRole('menuitem', { name: '重置密码' }).click()
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
