import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const directory = 'development/screenshots/sub-modal-p1'
const user = { id: 'member', username: 'member', role: 'user', enabled: true, email: 'member@example.test' }
const date = '2026-11-24T00:00:00Z'
const version = { id: 'version', number: 1, config: { duration: { value: 30, unit: 'day' }, quotaBytes: null, groupIds: [], nodeIds: [], limits: { speedLimitMbps: 0 } } }
const template = { id: 'template', name: '测试模板', status: 'enabled', allowRedemption: true, currentVersion: version }
const bindingsPath = '/api/admin/users/member/template-bindings'
const subscriptionPath = '/api/admin/users/member/subscription'

async function checkDialog(page: Page, dialog: Locator, size: 'm' | 'l', width: number, screenshot?: string, mask: Locator[] = []) {
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog).toHaveAttribute('data-size', size)
  await expect(dialog).toHaveCSS('width', `${Math.min(width - 32, size === 'm' ? 520 : 720)}px`)
  const bounds = (await dialog.boundingBox())!
  expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0)
  expect(bounds.y + bounds.height / 2).toBeCloseTo(760 / 2, 0)
  await expect(page.locator('dialog:modal')).toHaveCount(1)
  await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden')
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  if (width === 390) await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toHaveCSS('height', '44px')
  if (screenshot) {
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: `${directory}/${screenshot}-${width}.png`, mask })
  }
}

async function choose(dialog: Locator, label: string, option: string) {
  await dialog.getByLabel(label, { exact: true }).click()
  await dialog.getByRole('option', { name: option, exact: true }).click()
}

async function rowAction(page: Page, rowName: string, action: string) {
  const row = page.getByRole('row').filter({ hasText: rowName })
  await row.getByRole('button', { name: '更多操作' }).click()
  await row.getByRole('button', { name: action, exact: true }).click()
}

async function setup(page: Page) {
  const sources: Array<Record<string, unknown>> = []
  const nodes: Array<Record<string, unknown>> = []
  const remote = { id: 'remote', name: '远程来源', type: 'remote', enabled: true, createdAt: date, updatedAt: date, warnings: [] }
  sources.push(remote)
  const imported = ['导入节点甲', '导入节点乙'].map((displayName, index) => ({
    id: `imported-${index}`, displayName, protocol: 'http', server: 'example.test', port: 80,
    sourceIds: ['source'], enabled: true, retained: false, tags: [], createdAt: date, updatedAt: date,
  }))
  let member = user
  const binding = { templateId: template.id, templateStatus: 'enabled', status: 'active', startsAt: date, expiresAt: null }
  let bindings: Array<typeof binding> = []
  let revision = 1
  let subscriptionUrl: string | null = null
  let rotatedUrl: string | null = null
  let failNodePatch = true
  let batchQuantity = 0
  let job: { id: string; action: string; total: number; processed: number; failures: number; status: string; busy: number } | undefined
  const codes = Array.from({ length: 18 }, (_, index) => `MOCK-CODE-${String(index).padStart(4, '0')}`)
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const body = () => request.postDataJSON() as Record<string, unknown>
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status })
    switch (path) {
      case '/api/bootstrap': return json({ initialized: true, user: { id: 'admin', username: 'admin', role: 'admin', enabled: true } })
      case '/api/admin/catalog': return json({ sources, nodes, groups: [] })
      case '/api/admin/catalog/preview': return json({ format: 'uri-list', nodes: imported, warnings: [] })
      case '/api/admin/catalog/sources':
        sources.push({ ...body(), id: 'source', createdAt: date, updatedAt: date, warnings: [] })
        nodes.push(...imported)
        return json({ source: sources.at(-1) }, 201)
      case '/api/admin/catalog/sources/source':
        Object.assign(sources[1], body())
        return json({ source: sources[1] })
      case '/api/admin/catalog/sources/remote/preview-diff':
        return json({ id: 'preview', format: 'uri-list', diff: { added: 2, updated: 0, missing: 0, duplicates: 0, skipped: 0, parseFailed: 0 } })
      case '/api/admin/catalog/sources/remote/confirm-sync':
      case '/api/admin/catalog/sources/remote/cancel-sync': return json({ success: true })
      case '/api/admin/catalog/nodes':
        nodes.push({ ...body(), id: 'node', sourceIds: [], createdAt: date, updatedAt: date })
        return json({ node: nodes.at(-1) }, 201)
      case '/api/admin/catalog/nodes/node/details':
        return json({ credentials: {}, extensions: {}, rawVariants: [] })
      case '/api/admin/catalog/nodes/node':
        if (failNodePatch) {
          failNodePatch = false
          return json({ error: { code: 'VALIDATION_ERROR', message: '模拟保存错误' } }, 422)
        }
        Object.assign(nodes.at(-1)!, body())
        return json({ node: nodes.at(-1) })
      case '/api/admin/users/options':
      case '/api/admin/users': return json({ users: [member], total: 1 })
      case '/api/admin/users/member':
        if (method === 'PATCH') member = { ...member, email: String(body().email) }
        return json({ user: member })
      case bindingsPath: return json({ revision, bindings })
      case `${bindingsPath}/template/preview`:
        expect(Object.fromEntries(new URL(request.url()).searchParams)).toEqual({
          expectedRevision: '1', mode: 'assign', expiry: 'permanent',
        })
        return json({ changes: [{ before: null, after: binding }] })
      case `${bindingsPath}/template`:
        expect(method).toBe('PUT')
        expect(body()).toEqual({
          expectedRevision: 1, mode: 'assign', expiry: { type: 'permanent' },
          startsAt: Date.parse(date), requestId: expect.any(String),
        })
        bindings = [binding]
        subscriptionUrl = `${new URL(request.url()).origin}/s/${randomUUID()}`
        return json({ revision: ++revision, changes: [{ before: null, after: binding }] })
      case `${subscriptionPath}/summary`:
        return json({
          status: bindings.length ? 'active' : 'none', effectiveBindingCount: bindings.length,
          expiresAt: null, latestExpiresAt: null, lastExpiredAt: null,
          permanent: bindings.length > 0, nodes: [], subscriptionUrl, logs: [],
        })
      case `${subscriptionPath}/reset-token`:
        expect(method).toBe('POST')
        expect(body()).toEqual({ expectedRevision: 2 })
        rotatedUrl = `${new URL(request.url()).origin}/s/${randomUUID()}`
        subscriptionUrl = rotatedUrl
        revision += 1
        return json({ ok: true })
      case '/api/admin/compile-jobs': return json({ jobs: job ? [job] : [] })
      case '/api/admin/compile-jobs/batch/capabilities': return json({ unified: true })
      case '/api/admin/compile-jobs/batch/preview':
        expect(body()).toEqual({ ids: [user.id], operation: { action: 'assign', templateId: template.id } })
        return json({ previewId: 'preview', fingerprint: 'fixture', selected: 1, affected: 1, missing: 0, platforms: [] })
      case '/api/admin/compile-jobs/batch':
        expect(body()).toEqual({
          ids: [user.id], operation: { action: 'assign', templateId: template.id },
          previewId: 'preview', fingerprint: 'fixture',
        })
        job = { id: 'job', action: 'assign', total: 1, processed: 0, failures: 0, status: 'queued', busy: 0 }
        return json({ job }, 201)
      case '/api/admin/compile-jobs/job/run':
        expect(method).toBe('POST')
        job = { ...job!, status: 'completed', processed: 1 }
        return json({ job })
      case '/api/admin/compile-jobs/job': return json({ job })
      case '/api/admin/compile-jobs/job/items': return json({ items: [] })
      case '/api/admin/subscription-templates': return json({ templates: [template] })
      case '/api/admin/subscription-templates/template/versions': return json({ versions: [version] })
      case '/api/admin/redemption-batches':
        if (method === 'POST') {
          batchQuantity = Number(body().quantity)
          return json({ id: 'batch', codes: codes.slice(0, batchQuantity) }, 201)
        }
        return json({ items: [], total: 0 })
      case '/api/admin/redemption-batches/batch':
        return json({ batch: { id: 'batch', name: '测试批次', templateName: template.name, templateVersion: 1, status: 'active', quantity: batchQuantity } })
      case '/api/admin/redemption-batches/batch/codes': return json({ items: [], total: 0 })
      default: return json({}, 404)
    }
  })
  return { codes, rotatedUrl: () => rotatedUrl }
}

for (const width of [1440, 1024, 390]) {
  test.describe(`P1 · ${width}px`, () => {
    test.use({ viewport: { width, height: 760 }, hasTouch: width === 390, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })

    test('source previews, file batch import, node create and edit', async ({ page }) => {
      await setup(page)
      await page.goto('/catalog/sources')
      const trigger = page.getByRole('button', { name: '添加来源' })
      await trigger.click()
      const source = page.getByRole('dialog', { name: '添加来源' })
      await expect(source.getByLabel('来源名称')).toBeFocused()
      await page.mouse.click(3, 3)
      await expect(trigger).toBeFocused()
      await trigger.click()
      await source.getByLabel('来源名称').fill('批量来源')
      await choose(source, '来源类型', '文件导入')
      await source.locator('input[type=file]').setInputFiles({
        name: 'nodes.txt', mimeType: 'text/plain',
        buffer: Buffer.from('http://one.example.test:80\nhttp://two.example.test:80'),
      })
      await source.getByRole('button', { name: '预览', exact: true }).click()
      await expect(source.getByText('检测到 2 个节点')).toBeVisible()
      await page.mouse.click(3, 3)
      await expect(source.getByRole('button', { name: '继续编辑' })).toHaveCount(0)
      await source.getByRole('button', { name: '取消' }).click()
      await expect(source.getByRole('button', { name: '继续编辑' })).toBeFocused()
      await source.getByRole('button', { name: '继续编辑' }).click()
      await checkDialog(page, source, 'l', width, 'source-import')
      await source.getByRole('button', { name: '保存来源' }).click()
      await expect(source).toBeHidden()
      await expect(trigger).toBeFocused()
      await rowAction(page, '批量来源', '编辑')
      const editSource = page.getByRole('dialog', { name: '编辑来源' })
      await editSource.getByLabel('来源名称').fill('已编辑来源')
      await editSource.getByRole('button', { name: '保存修改' }).click()
      await expect(page.getByRole('row').filter({ hasText: '已编辑来源' })).toBeVisible()

      await rowAction(page, '远程来源', '刷新')
      const sync = page.getByRole('dialog', { name: '同步差异预览' })
      await expect(sync.getByRole('button', { name: '确认同步' })).toBeEnabled()
      await checkDialog(page, sync, 'l', width, 'source-sync')
      await sync.getByRole('button', { name: '确认同步' }).click()
      await expect(sync).toBeHidden()

      await page.goto('/catalog/nodes')
      await expect(page.getByText('导入节点甲')).toBeVisible()
      await expect(page.getByText('导入节点乙')).toBeVisible()
      await page.getByRole('button', { name: '添加节点' }).click()
      const node = page.getByRole('dialog', { name: '添加节点' })
      await node.getByLabel('节点名称').fill('手动节点')
      await choose(node, '协议', 'http')
      await node.getByLabel('服务器').fill('node.example.test')
      await node.getByLabel('端口').fill('80')
      await checkDialog(page, node, 'l', width, 'node-create')
      await node.getByRole('button', { name: '保存节点' }).click()
      await rowAction(page, '手动节点', '编辑')
      const editNode = page.getByRole('dialog', { name: '编辑节点' })
      await editNode.getByLabel('节点名称').fill('已编辑节点')
      await editNode.getByRole('button', { name: '保存修改' }).click()
      await expect(editNode.getByText('模拟保存错误')).toBeVisible()
      await expect(editNode.getByLabel('节点名称')).toHaveValue('已编辑节点')
      await editNode.getByRole('button', { name: '保存修改' }).click()
      await expect(editNode).toBeHidden()
      await expect(page.getByText('已编辑节点')).toBeVisible()
    })

    test('user authorization binds a template, resets the link and runs a batch job', async ({ page }) => {
      const { rotatedUrl } = await setup(page)
      await page.goto('/delivery/subscriptions')
      await expect(page).toHaveURL(/\/users$/u)
      const menu = page.getByLabel('member 的操作')
      await menu.click()
      await page.getByRole('menuitem', { name: '修改邮箱' }).click()
      const userEdit = page.getByRole('dialog', { name: '编辑用户' })
      await userEdit.getByLabel('邮箱').fill('updated@example.test')
      await checkDialog(page, userEdit, 'm', width)
      await userEdit.getByRole('button', { name: '保存' }).click()
      await expect(userEdit).toBeHidden()
      await expect(menu).toBeFocused()
      await menu.click()
      await page.getByRole('menuitem', { name: '订阅授权' }).click()
      await expect(page).toHaveURL(/\/users\/member\?tab=subscription$/u)
      await expect(page.getByText('暂无绑定模板')).toBeVisible()
      const bind = page.getByRole('button', { name: '绑定模板', exact: true })
      await bind.click()
      const editor = page.getByRole('dialog', { name: '绑定模板' })
      await checkDialog(page, editor, 'l', width)
      const preview = editor.getByRole('button', { name: '预览影响' })
      await expect(preview).toBeDisabled()
      await editor.getByLabel('搜索模板').fill('无匹配结果')
      const selectTemplate = editor.getByLabel('模板', { exact: true })
      await selectTemplate.click()
      await expect(editor.getByRole('option', { name: '选择模板' })).toBeVisible()
      await expect(editor.getByRole('option', { name: template.name })).toHaveCount(0)
      await selectTemplate.click()
      await editor.getByLabel('搜索模板').fill(template.name)
      await choose(editor, '模板', template.name)
      await choose(editor, '有效期', '永久')
      await page.keyboard.press('Escape')
      await editor.getByRole('button', { name: '继续编辑' }).click()
      await expect(editor.getByLabel('有效期')).toHaveText('永久')
      const editorWindow = await editor.elementHandle()
      await preview.click()
      await expect(editor.getByText('有效 · 长期有效')).toBeVisible()
      expect(await editor.evaluate((element, previous) => element === previous, editorWindow)).toBe(true)
      await editor.getByRole('button', { name: '确认绑定', exact: true }).click()
      await expect(editor).toBeHidden()
      await expect(bind).toBeFocused()
      const row = page.getByRole('row').filter({ hasText: template.name })
      await expect(row.getByText('有效', { exact: true })).toBeVisible()
      await expect(row.getByText('长期有效')).toBeVisible()
      const update = row.getByRole('button', { name: '更新绑定', exact: true })
      await update.click()
      const updateDialog = page.getByRole('dialog', { name: '更新绑定' })
      await expect(updateDialog.getByLabel('操作')).toHaveText('更新现有绑定')
      await page.keyboard.press('Escape')
      await expect(update).toBeFocused()

      const linkActions = page.getByRole('button', { name: '订阅链接更多操作' })
      const reset = page.getByRole('button', { name: '重置链接' })
      await linkActions.click()
      await reset.click()
      const confirmation = page.getByRole('dialog', { name: '重置订阅链接' })
      await expect(confirmation).toHaveAttribute('data-size', 's')
      await expect(confirmation.getByText('旧链接将立即失效')).toBeVisible()
      const cancel = confirmation.getByRole('button', { name: '取消' })
      await expect(cancel).toBeFocused()
      await cancel.click()
      await expect(linkActions).toBeFocused()
      expect(rotatedUrl()).toBeNull()
      await linkActions.click()
      await reset.click()
      await confirmation.getByRole('button', { name: '重置链接', exact: true }).click()
      await expect(confirmation).toBeHidden()
      expect(rotatedUrl()).not.toBeNull()
      await page.getByRole('button', { name: '复制统一订阅链接' }).click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(rotatedUrl())

      await page.goto('/users')
      const batch = page.getByRole('button', { name: '批量任务' })
      await batch.click()
      const job = page.getByRole('dialog', { name: '订阅批量任务' })
      await expect(job).toHaveAttribute('data-size', 'xl')
      await job.getByLabel('用户编号').fill(user.id)
      await job.getByLabel('授权模板编号').fill(template.id)
      await job.getByRole('button', { name: '预览授权' }).click()
      const review = page.getByRole('dialog', { name: '绑定模板' })
      await expect(review.getByText('已选 1 个 · 预计影响 1 个 · 0 个已不存在')).toBeVisible()
      await review.getByRole('button', { name: '确认并创建任务' }).click()
      await expect(review).toBeHidden()
      await expect(job).toBeVisible()
      await expect(job.getByRole('status')).toContainText('绑定模板 · 待执行 · 已处理 0/1')
      await job.getByRole('button', { name: '执行任务' }).click()
      await expect(job.getByText(/已完成.*已处理 1\/1/)).toBeVisible()
      await job.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(job).toBeHidden()
    })

    test('single and batch redemption results preserve one-time presentation', async ({ page }) => {
      const { codes } = await setup(page)
      await page.goto('/delivery/redemptions')
      const trigger = page.getByRole('button', { name: '生成兑换码', exact: true })
      for (const quantity of [1, codes.length]) {
        await trigger.click()
        const editor = page.getByRole('dialog', { name: '生成兑换码' })
        await editor.getByLabel('批次名称').fill('测试批次')
        await choose(editor, '订阅模板', '测试模板')
        await editor.getByLabel('生成数量').fill(String(quantity))
        await editor.getByLabel('兑换截止时间').fill('2030-01-01T12:00')
        await checkDialog(page, editor, 'l', width, quantity > 1 ? 'redemption-create' : undefined)
        const original = await editor.elementHandle()
        await editor.getByRole('button', { name: '生成', exact: true }).click()
        const result = page.getByRole('dialog', { name: '兑换码已生成' })
        await expect(result.locator('code')).toHaveCount(quantity)
        expect(await result.evaluate((element, previous) => previous === element, original)).toBe(true)
        await checkDialog(page, result, 'm', width, quantity === 1 ? 'redemption-single' : 'redemption-batch')
        await result.getByRole('button', { name: quantity === 1 ? '复制' : '复制第 1 个兑换码', exact: true }).click()
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(codes[0])
        if (quantity > 1) {
          const list = result.getByRole('list', { name: '完整兑换码' })
          expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
          await result.getByRole('button', { name: '复制全部' }).click()
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(codes.join('\n'))
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const download = page.waitForEvent('download')
          await result.getByRole('button', { name: '导出 CSV' }).click()
          const stream = await (await download).createReadStream()
          const chunks = []
          for await (const chunk of stream) chunks.push(chunk)
          expect(Buffer.concat(chunks).toString()).toBe(`code\r\n${codes.slice(0, quantity).join('\r\n')}\r\n`)
        }
        await page.mouse.click(3, 3)
        await expect(result.getByRole('button', { name: '确认关闭' })).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(result.getByRole('button', { name: '返回结果' })).toBeFocused()
        await result.getByRole('button', { name: '返回结果' }).click()
        await result.getByRole('button', { name: '完成' }).click()
        await result.getByRole('button', { name: '确认关闭' }).click()
        await expect(result).toHaveCount(0)
        await expect(page.getByText(codes[0], { exact: true })).toHaveCount(0)
        await expect(trigger).toBeFocused()
      }
    })
  })
}
