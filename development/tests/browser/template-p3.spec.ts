import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const origin = 'http://template-p3.test'
const distribution = `${origin}/system/distribution`
const root = '/api/admin/system/subscription-templates'
const screenshotDir = 'development/screenshots/template-p3'
const now = '2026-11-20T09:25:00Z'
const groups = [{ name: 'Proxy', type: 'select', proxies: ['$SUBPANEL_NODES', 'DIRECT'] }]
const rules = ['IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', 'MATCH,Proxy']
const draft = `proxy-groups:\n  - name: Proxy\n    type: select\n    proxies: ["$SUBPANEL_NODES", DIRECT]\nrules:\n  - ${rules.join('\n  - ')}\n`
const providers = { local: { type: 'http', behavior: 'domain', format: 'yaml', url: 'https://example.test/rules.yaml', path: './rule-providers/local.yaml' } }
const revision = 4
const version = { id: 'v3', sequence: 3, createdAt: now, contentHash: 'normalized', validatorVersion: '1', createdBy: null }
const base = { id: 'office', name: '办公分流', revision, status: 'modified', publishedVersionId: version.id, publishedSequence: 3, publishedAt: now,
  updatedAt: now, createdAt: now, references: { isDefault: true, directBindings: 2, inheritedCount: 8 } }
const subscription = { id: 'sub_1', name: '办公室订阅', userId: 'usr_1', groupIds: [], enabled: true, defaultClient: 'mihomo',
  startsAt: null, expiresAt: null, tokenPreview: '******', subscriptionUrl: 'https://example.test/sub/redacted', links: {}, diagnostics: [] }

async function mockApp(page: Page, options: { empty?: boolean; baseDefault?: boolean } = {}) {
  let savedYaml = draft
  let savedName = base.name
  let savedRevision = revision
  let draftHash = 'draft-hash'
  let defaultId: string | null = options.baseDefault || options.empty ? null : base.id
  let defaultRevision = 3
  let published = version
  let fetchedAt: string | null = null
  let sourceUrl: string | null = null
  let archived = false
  let failImport = false
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request()
    const { pathname: path, searchParams } = new URL(request.url())
    if (!path.startsWith('/api/')) {
      const file = path.startsWith('/assets/') || path === '/theme-init.js' ? path : '/index.html'
      return route.fulfill({
        body: await readFile(resolve('dist/client' + file)),
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
      })
    }
    const method = request.method()
    const body = request.postDataJSON() as Record<string, unknown> | null
    calls.push({ method, path, body })
    const json = (data: unknown, status = 200) => route.fulfill({ json: data, status })
    const row = { ...base, name: savedName, revision: savedRevision, publishedSequence: published.sequence, publishedVersionId: published.id,
      references: { ...base.references, isDefault: defaultId === base.id, inheritedCount: defaultId === base.id ? 8 : 0 } }
    switch (path) {
      case '/api/bootstrap': return json({ initialized: true, user: { id: 'usr_1', username: 'admin', role: 'admin', enabled: true } })
      case '/api/admin/system/domains': return json({ panel: [], subscription: [], primaryPanelDomainId: null, primarySubscriptionDomainId: null, restrictionEnabled: false })
      case '/api/admin/system/subscription-platforms': return json({ platforms: [] })
      case '/api/admin/share-settings': return json({ settings: { enabled: true, createAllowed: true, maxSharesPerSubscription: 10, maxActiveSharesPerUser: 10, maxValidityDays: 30, defaultAllowOriginalLink: false, defaultAccessControl: 'none', requireLoginDefault: false, publicBaseUrl: '' } })
      case '/api/admin/users': return json({ users: [{ id: 'usr_1', username: 'admin' }], total: 1 })
      case '/api/admin/catalog': return json({ sources: [], nodes: [], groups: [] })
      case '/api/admin/plans': return json({ plans: [] })
      case '/api/admin/subscriptions':
        if (method === 'POST') return json({ subscription, token: 'mock-token', warning: '' }, 201)
        if (searchParams.get('pageSize') !== '100') return json({ subscriptions: [subscription], total: 1 })
        if (options.baseDefault) return json({ subscriptions: [subscription], total: 1 })
        return json({ subscriptions: searchParams.get('page') === '2' ? [{ id: 'sub_101', name: '第二页测试订阅' }] :
          [subscription, ...Array.from({ length: 99 }, (_, i) => ({ id: `other-${i}`, name: `测试订阅 ${i + 1}` }))], total: 101 })
      case '/api/admin/subscriptions/sub_1': return json({ subscription, warning: '' })
      case root:
        if (method === 'POST') {
          savedYaml = String(body?.yaml)
          savedName = String(body?.name)
          return json({ id: 'office', revision: savedRevision, draftHash: 'draft-hash' }, 201)
        }
        return json({ templates: options.empty || (searchParams.get('archived') === 'true') !== archived ? [] :
          [{ ...row, status: archived ? 'archived' : row.status }],
        defaultId, defaultRevision, total: options.empty || (searchParams.get('archived') === 'true') !== archived ? 0 : 1, page: 1, pageSize: 100 })
      case `${root}/office`:
        if (method === 'PUT') {
          savedYaml = String(body?.yaml)
          savedName = String(body?.name)
          if (body?.source) {
            const source = body.source as { url: string; fetchedAt: string }
            sourceUrl = source.url
            fetchedAt = source.fetchedAt
          }
          draftHash = 'new-hash'
          return json({ ok: true, revision: ++savedRevision, draftHash })
        }
        return json({ ...row, status: archived ? 'archived' : row.status, draft: savedYaml, draftHash, publishedVersion: published,
          sourceUrl, sourceFetchedAt: fetchedAt, sourceEtag: null, sourceLastModified: null })
      case `${root}/default`:
        defaultId = body?.templateId as string | null
        return json({ ok: true, revision: ++defaultRevision, references: row.references, inheritedCount: options.baseDefault ? 1 : 8 })
      case `${root}/office/versions`:
        return json({ versions: [version, { ...version, id: 'v2', sequence: 2 }], total: 2, page: 1, pageSize: 20 })
      case `${root}/office/rollback`:
        published = { ...version, id: 'v2', sequence: 2 }
        return json({ ok: true, revision: ++savedRevision, versionId: published.id, references: row.references })
      case `${root}/office/copy`: return json({ id: 'copy', revision: 1, draftHash: 'copy-hash' }, 201)
      case `${root}/copy`:
        return json({ ...row, id: 'copy', name: '办公分流 副本', status: 'draft', revision: 1, publishedVersionId: null,
          draft: savedYaml, draftHash: 'copy-hash', publishedVersion: null, sourceUrl: null, sourceFetchedAt: null,
          sourceEtag: null, sourceLastModified: null, references: { isDefault: false, inheritedCount: 0, directBindings: 0 } })
      case `${root}/office/archive`:
        archived = true
        return json({ ok: true, revision: ++savedRevision })
      case `${root}/bindings/sub_1`:
        return json({ subscriptionId: subscription.id, mode: 'inherit', templateId: null, revision: 2, updatedAt: null,
          effectiveTemplate: defaultId ? { templateId: base.id, templateName: base.name, versionId: published.id, sequence: published.sequence } : null })
      case `${root}/office/import`:
        if (failImport) return json({ error: { code: 'REMOTE_FETCH_FAILED', message: '导入失败，请手动重试' } }, 422)
        return json({ notModified: false, candidate: { yaml: `${draft}dns: {}\n`, ignored: ['dns'], diagnostics: [],
          normalized: { 'proxy-groups': groups, rules }, contentHash: 'content' },
        source: { url: body?.url, fetchedAt: now, etag: 'remote', lastModified: null } })
      case `${root}/validate`:
        return json({ ignored: ['dns'], diagnostics: [], normalized: { 'proxy-groups': groups, rules }, contentHash: 'content', validatorVersion: '1' })
      case `${root}/office/publish`:
        return json({ versionId: 'v4', sequence: 4, contentHash: 'content', revision: ++savedRevision, references: row.references })
      case `${root}/preview`:
        if (String(body?.yaml).startsWith('bad')) return json({ error: { code: 'TEMPLATE_INVALID', message: '配置校验失败',
          details: { diagnostics: [{ code: 'YAML_INVALID', path: 'rules[0]', line: 2, column: 1, message: '规则无效', severity: 'error' }] } } }, 422)
        return json({ groups, rules, ruleProviders: providers, ignored: [], diagnostics: [],
          subscriptionName: body?.subscriptionId ? '第二页测试订阅' : null, outputNodes: body?.subscriptionId ? 0 : null,
          zeroNodeReason: body?.subscriptionId ? 'expired' : null, effectiveVersionId: null })
      default: return json({ error: { code: 'NOT_MOCKED', message: '接口未模拟' } }, 404)
    }
  })
  return { calls, errors, failNextImport: () => { failImport = true } }
}

const templates = (page: Page) => page.getByRole('region', { name: '附加配置', exact: true })
const editFooter = (page: Page) => templates(page).locator('.template-editor-footer')

async function choose(control: Locator, page: Page, option: string) {
  await control.click()
  await page.getByRole('option', { name: option, exact: true }).click()
}


test('列表是默认视图，空状态保留默认配置和新增入口', async ({ page }) => {
  await mockApp(page, { empty: true })
  await page.goto(distribution)
  await expect(templates(page).getByText('暂无附加配置')).toBeVisible()
  await expect(templates(page).getByLabel('默认配置', { exact: true })).toHaveText('基础配置')
  await expect(templates(page).getByLabel('YAML', { exact: true })).toHaveCount(0)
  await templates(page).getByRole('button', { name: '新增配置' }).first().click()
  await expect(page).toHaveURL(/\?config=new$/u)
  await expect(templates(page).getByLabel('YAML', { exact: true })).toHaveValue(/MATCH,Proxy/u)
  await page.goBack()
  await expect(templates(page).getByText('暂无附加配置')).toBeVisible()
})

test('未保存时禁用发布，浏览器返回可继续、保存或放弃', async ({ page }) => {
  const { calls } = await mockApp(page)
  await page.goto(distribution)
  await templates(page).getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page).toHaveURL(/config=office/u)
  const name = templates(page).getByLabel('配置名称')
  await name.fill('本地更改')
  await expect(editFooter(page).getByRole('button', { name: '发布' })).toBeDisabled()
  await expect(editFooter(page).getByText('先保存草稿')).toBeVisible()
  await page.goBack()
  const dialog = page.getByRole('dialog', { name: '有未保存更改' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '继续编辑' }).click()
  await expect(name).toHaveValue('本地更改')
  await templates(page).getByRole('button', { name: '返回列表' }).click()
  await dialog.getByRole('button', { name: '保存并离开' }).click()
  await expect(templates(page).getByRole('row', { name: /本地更改/u })).toBeVisible()
  expect(calls.find(({ method }) => method === 'PUT')?.body).toMatchObject({ name: '本地更改', expectedRevision: revision })
  await templates(page).getByRole('button', { name: '编辑', exact: true }).click()
  await name.fill('不会保存')
  await templates(page).getByRole('button', { name: '返回列表' }).click()
  await dialog.getByRole('button', { name: '放弃更改' }).click()
  await expect(templates(page).getByRole('row', { name: /本地更改/u })).toBeVisible()
  expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(1)
})

test('取消抽屉保留原绑定，再保存时与订阅同一请求提交', async ({ page }) => {
  const { calls } = await mockApp(page)
  await page.goto(`${origin}/delivery/subscriptions`)
  const open = async () => {
    await page.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.getByLabel('附加配置', { exact: true })).toBeEnabled()
  }
  await open()
  const mode = page.getByLabel('附加配置', { exact: true })
  await expect(page.getByText('当前生效：办公分流 · v3')).toBeVisible()
  await expect(page.getByLabel('指定模板', { exact: true })).toHaveCount(0)
  await choose(mode, page, '指定模板')
  await choose(page.getByLabel('指定模板', { exact: true }), page, '办公分流 · v3')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(calls.filter(({ method }) => method !== 'GET')).toHaveLength(0)
  await open()
  await expect(mode).toHaveText('继承默认')
  await choose(mode, page, '指定模板')
  await choose(page.getByLabel('指定模板', { exact: true }), page, '办公分流 · v3')
  await page.getByRole('button', { name: '保存修改' }).click()
  await expect(page.getByText('订阅已更新。')).toBeVisible()
  expect(calls.filter(({ method }) => method !== 'GET')).toMatchObject([{
    method: 'PATCH', path: '/api/admin/subscriptions/sub_1',
    body: { templateBinding: { mode: 'specific', templateId: 'office', expectedRevision: 2 } },
  }])
})

test('预览加载完整分页，展示结构、原规则顺序和零节点阻断', async ({ page }) => {
  await mockApp(page)
  await page.goto(distribution)
  await templates(page).getByRole('button', { name: '更多操作' }).click()
  await templates(page).getByRole('button', { name: '预览', exact: true }).click()
  await expect(page).toHaveURL(/config=office&view=preview/u)
  await templates(page).getByRole('button', { name: '预览', exact: true }).click()
  await expect(templates(page).getByText('生产下发：选择订阅后核对')).toBeVisible()
  await templates(page).getByLabel('搜索预览订阅').fill('第二页')
  await choose(templates(page).getByLabel('预览订阅', { exact: true }), page, '第二页测试订阅')
  await expect(templates(page).getByText('策略配置预览')).toHaveCount(0)
  await templates(page).getByRole('button', { name: '预览', exact: true }).click()
  await expect(templates(page).getByText('第二页测试订阅 · 节点数 0')).toBeVisible()
  await expect(templates(page).getByText('生产下发受阻：订阅已过期')).toBeVisible()
  await templates(page).getByText('Proxy · select · 2 个成员').click()
  await expect(templates(page).getByText('$SUBPANEL_NODES', { exact: true })).toBeVisible()
  await expect(templates(page).locator('ol li')).toHaveText(rules)
  await expect(templates(page).getByText('local · domain · yaml')).toBeVisible()
  await expect(templates(page).locator('pre')).toContainText('rule-providers:')
})

test('候选导入失败保留编辑内容，发布确认列出忽略字段', async ({ page }) => {
  const { calls, failNextImport } = await mockApp(page)
  await page.goto(`${distribution}?config=office`)
  await choose(templates(page).getByLabel('来源'), page, '远程地址')
  const url = templates(page).getByLabel('HTTPS 地址')
  const secret = 'https://config.example.test/template?token=private'
  await url.fill(secret)
  await expect(url).toHaveAttribute('type', 'password')
  await templates(page).getByRole('button', { name: '导入／重新导入' }).click()
  const yaml = templates(page).getByLabel('YAML', { exact: true })
  await expect(yaml).toHaveValue(/dns: \{\}/u)
  await expect(templates(page).getByText('导入时发现忽略字段：dns')).toBeVisible()
  await expect(templates(page).getByText(/获取时间/u)).toBeVisible()
  await expect(url).toHaveValue('')
  expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(0)
  failNextImport()
  await templates(page).getByRole('button', { name: '导入／重新导入' }).click()
  await expect(templates(page).getByText('导入失败，请手动重试')).toBeVisible()
  await expect(yaml).toHaveValue(/dns: \{\}/u)
  await editFooter(page).getByRole('button', { name: '保存草稿' }).click()
  await expect(editFooter(page).getByRole('button', { name: '发布' })).toBeEnabled()
  await editFooter(page).getByRole('button', { name: '发布' }).click()
  const dialog = page.getByRole('dialog', { name: '发布配置' })
  await expect(dialog.getByText('发布「办公分流」的草稿修订 5，将影响 10 条订阅。')).toBeVisible()
  await expect(dialog.getByText('发布将忽略以下字段，请确认：dns')).toBeVisible()
  await dialog.getByRole('button', { name: '确认发布' }).click()
  await expect(dialog).toBeHidden()
  expect(calls.find(({ path }) => path.endsWith('/publish'))?.body).toEqual({ expectedRevision: 5, draftHash: 'new-hash', ignoredAcknowledged: true })
})

test('从基础配置切换默认前先统计继承订阅，提交后显示版本', async ({ page }) => {
  const { calls } = await mockApp(page, { baseDefault: true })
  await page.goto(distribution)
  const select = templates(page).getByLabel('默认配置', { exact: true })
  await choose(select, page, '办公分流 · v3')
  const dialog = page.getByRole('dialog', { name: '更改默认配置' })
  await expect(dialog.getByText('将影响 1 条继承默认的订阅。')).toBeVisible()
  expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(0)
  await dialog.getByRole('button', { name: '更改默认配置' }).click()
  await expect(select).toHaveText('办公分流 · v3')
  await expect(page.getByText('默认配置已保存')).toBeVisible()
})

test('校验错误定位到编辑器下方，修改 YAML 清除结果', async ({ page }) => {
  await mockApp(page)
  await page.goto(`${distribution}?config=office`)
  const yaml = templates(page).getByLabel('YAML', { exact: true })
  await yaml.fill('bad\n- broken')
  await editFooter(page).getByRole('button', { name: '预览' }).click()
  const result = templates(page).getByRole('region', { name: '校验结果' })
  await expect(result.getByText('rules[0]')).toBeVisible()
  await expect(result.getByText('第 2 行第 1 列')).toBeVisible()
  await expect(result.getByText('规则无效')).toBeVisible()
  await yaml.fill(draft)
  await expect(result.getByText('规则无效')).toHaveCount(0)
})

test('创建订阅时同一请求携带绑定，普通创建沿用继承默认', async ({ page }) => {
  const { calls } = await mockApp(page)
  await page.goto(`${origin}/delivery/subscriptions`)
  await page.getByRole('button', { name: '添加订阅' }).click()
  await page.getByLabel('订阅名称').fill('带绑定的订阅')
  await choose(page.getByLabel('附加配置', { exact: true }), page, '基础配置')
  await page.getByRole('button', { name: '保存订阅' }).click()
  await expect(page.getByText('订阅已添加')).toBeVisible()
  const writes = () => calls.filter(({ method }) => method !== 'GET')
  expect(writes()).toMatchObject([{ method: 'POST', path: '/api/admin/subscriptions',
    body: { templateBinding: { mode: 'base', expectedRevision: 1 } } }])
  await page.getByRole('button', { name: '添加订阅' }).click()
  await page.getByLabel('订阅名称').fill('继承默认的订阅')
  await page.getByRole('button', { name: '保存订阅' }).click()
  await expect(page.getByLabel('订阅名称')).toBeHidden()
  expect(writes()).toHaveLength(2)
  expect(writes()[1]?.body).not.toHaveProperty('templateBinding')
})

test('版本回退、复制和归档使用列表操作', async ({ page }) => {
  const { calls } = await mockApp(page, { baseDefault: true })
  await page.goto(distribution)
  const region = templates(page)
  const menu = region.getByRole('button', { name: '更多操作' })
  const chooseMenu = async (name: string) => {
    await menu.click()
    await region.getByRole('button', { name, exact: true }).click()
  }
  await chooseMenu('版本历史')
  const history = page.getByRole('dialog', { name: /版本历史/u })
  await history.getByRole('button', { name: '回退', exact: true }).click()
  await history.getByRole('button', { name: '确认回退至 v2' }).click()
  await expect(history.getByText('当前发布')).toBeVisible()
  await history.getByRole('button', { name: '关闭' }).click()
  await expect(region.getByRole('row', { name: /办公分流/u }).getByText('v2', { exact: true })).toBeVisible()
  await chooseMenu('复制为新配置')
  const copy = page.getByRole('dialog', { name: '复制为新配置' })
  await expect(copy.getByLabel('新配置名称')).toHaveValue('办公分流 副本')
  await copy.getByRole('button', { name: '复制为新配置' }).click()
  await expect(page).toHaveURL(/config=copy/u)
  await expect(region.getByLabel('配置名称')).toHaveValue('办公分流 副本')
  await page.goBack()
  await chooseMenu('归档')
  await page.getByRole('dialog', { name: '归档配置' }).getByRole('button', { name: '归档配置' }).click()
  await expect(region.getByText('暂无附加配置')).toBeVisible()
  await region.getByRole('button', { name: '查看已归档' }).click()
  await expect(region.getByRole('cell', { name: '已归档' })).toBeVisible()
  expect(calls.filter(({ method }) => method === 'POST')).toMatchObject([
    { path: `${root}/office/rollback`, body: { versionId: 'v2', expectedRevision: 4 } },
    { path: `${root}/office/copy`, body: { name: '办公分流 副本' } },
    { path: `${root}/office/archive`, body: { expectedRevision: 5 } },
  ])
})

for (const width of [390, 1440]) {
  test(`${width}px 列表、编辑、预览布局`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const { errors } = await mockApp(page)
    await page.goto(distribution)
    const region = templates(page)
    await expect(region.getByRole('row', { name: /办公分流/u })).toBeVisible()
    const capture = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      const size = await region.evaluate((element) => ({
        width: element.clientWidth, scrollWidth: element.scrollWidth,
        overflow: Array.from(element.querySelectorAll('*'))
          .filter((child) => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1)
          .map((child) => child.tagName + '.' + child.getAttribute('class')).slice(0, 15),
      }))
      expect(size.scrollWidth, JSON.stringify(size)).toBeLessThanOrEqual(size.width)
      if (process.env.TEMPLATE_P3_SCREENSHOTS === '1') {
        await mkdir(screenshotDir, { recursive: true })
        const viewport = page.viewportSize()!
        const height = await region.evaluate((element) => Math.ceil(element.getBoundingClientRect().height) + 220)
        await page.setViewportSize({ width, height: Math.max(viewport.height, height) })
        await region.evaluate((element) => element.scrollIntoView({ block: 'start' }))
        await page.screenshot({ path: `${screenshotDir}/${width}-${name}.png`, animations: 'disabled' })
        await page.setViewportSize(viewport)
      }
    }
    await capture('list')
    await region.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(region.getByLabel('配置名称')).toHaveValue('办公分流')
    if (width === 390) await expect(region.getByLabel('预览订阅', { exact: true })).toBeHidden()
    else await expect(region.getByLabel('预览订阅', { exact: true })).toBeVisible()
    await capture('editor')
    await editFooter(page).getByRole('button', { name: '预览' }).click()
    await region.getByLabel('搜索预览订阅').fill('第二页')
    await choose(region.getByLabel('预览订阅', { exact: true }), page, '第二页测试订阅')
    await editFooter(page).getByRole('button', { name: '预览' }).click()
    await expect(region.getByText('生产下发受阻：订阅已过期')).toBeVisible()
    await capture('preview')
    expect(errors).toEqual([])
  })
}
