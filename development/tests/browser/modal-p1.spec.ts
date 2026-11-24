import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const directory = 'development/screenshots/sub-modal-p1'
const user = { id: 'member', username: 'member', role: 'user', enabled: true, email: 'member@example.test' }
const plan = { id: 'plan', name: '标准计划', enabled: true, durationDays: 30, groupIds: [], trafficGb: 0, speedLimitMbps: 0, deviceLimit: 0 }
const date = '2026-11-24T00:00:00Z'
const version = { id: 'version', number: 1, config: { duration: { value: 30, unit: 'day' }, quotaBytes: null, groupIds: [], nodeIds: [], limits: { speedLimitMbps: 0 } } }
const template = { id: 'template', name: '测试模板', allowRedemption: true, currentVersion: version }

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
  let subscription: Record<string, unknown> | undefined
  let failNodePatch = true
  let batchQuantity = 0
  const job = { id: 'job', action: 'plan', total: 1, processed: 0, failures: 0, status: 'queued', busy: 0 }
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
        member = { ...member, email: String(body().email) }
        return json({ user: member })
      case '/api/admin/users/member/subscription-plan':
        if (method === 'POST') expect(body()).toMatchObject({ action: 'grant', planId: plan.id })
        return json({ state: 'none', current: null, latest: null })
      case '/api/admin/plans': return json({ plans: [plan] })
      case '/api/admin/system/subscription-templates': return json({ templates: [] })
      case '/api/admin/system/subscription-templates/bindings/sub':
        return json({ mode: 'inherit', effectiveTemplate: null, revision: 1 })
      case '/api/admin/subscriptions/output-preview': return json({ outputNodes: 0, planGroupIds: [] })
      case '/api/admin/subscriptions':
        if (method === 'GET') return json({ subscriptions: subscription ? [subscription] : [], total: Number(!!subscription) })
        subscription = { ...body(), id: 'sub', links: {}, diagnostics: {}, createdAt: date, updatedAt: date }
        return json({ subscription, warning: '' }, 201)
      case '/api/admin/subscriptions/sub':
        if (method === 'PATCH') Object.assign(subscription!, body())
        return json({ subscription, warning: '' })
      case '/api/admin/compile-jobs/batch/preview':
        expect(body()).toMatchObject({ ids: ['sub'], operation: { action: 'plan', planId: 'plan' } })
        return json({ previewId: 'preview', fingerprint: 'fixture', selected: 1, affected: 1, missing: 0, platforms: [] })
      case '/api/admin/compile-jobs/batch': return json({ job }, 201)
      case '/api/admin/compile-jobs/job/run':
      case '/api/admin/compile-jobs/job':
        return json({ job: { ...job, status: 'completed', processed: 1 } })
      case '/api/admin/compile-jobs/job/items': return json({ items: [] })
      case '/api/admin/shares':
        return json({ share: { id: 'share' }, token: randomUUID() }, 201)
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
  return { codes }
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

    test('subscription issue, edit, share and user plan assignment', async ({ page }) => {
      await setup(page)
      await page.goto('/delivery/subscriptions')
      const add = page.getByRole('button', { name: '添加订阅' }).first()
      await add.click()
      const create = page.getByRole('dialog', { name: '添加订阅' })
      await choose(create, '订阅模板', '测试模板 · v1 · 30 天')
      await choose(create, '所属用户', 'member')
      await checkDialog(page, create, 'l', width, 'subscription-issue')
      await create.getByRole('button', { name: '保存订阅' }).click()
      const details = page.getByRole('dialog', { name: '测试模板' })
      await expect(details).toBeVisible()
      await expect(page.locator('dialog:modal')).toHaveCount(1)
      await details.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(add).toBeFocused()
      await rowAction(page, '测试模板', '编辑')
      const edit = page.getByRole('dialog', { name: '编辑订阅' })
      await edit.getByLabel('订阅名称').fill('已编辑订阅')
      await edit.getByRole('button', { name: '取消' }).click()
      await edit.getByRole('button', { name: '继续编辑' }).click()
      await edit.getByRole('button', { name: '保存修改' }).click()
      await expect(edit).toBeHidden()

      await rowAction(page, '已编辑订阅', '临时分享')
      const share = page.getByRole('dialog', { name: '临时分享' })
      await share.getByLabel('备注').fill('本地回归')
      await page.keyboard.press('Escape')
      await share.getByRole('button', { name: '继续编辑' }).click()
      await checkDialog(page, share, 'm', width, 'subscription-share')
      await share.getByRole('button', { name: '创建', exact: true }).click()
      const result = page.getByRole('dialog', { name: '分享已创建' })
      await expect(result.getByLabel('分享链接')).toBeFocused()
      await page.mouse.click(3, 3)
      await expect(result).toBeVisible()
      await result.getByRole('button', { name: '完成' }).click()
      await expect(page.getByLabel('分享链接', { exact: true })).toHaveCount(0)

      await page.getByLabel('选择订阅 已编辑订阅').check()
      const moreBatch = page.getByRole('button', { name: '更多批量操作' })
      if (await moreBatch.isVisible()) await moreBatch.click()
      await page.getByRole('button', { name: '更换计划', exact: true }).click()
      const planDialog = page.getByRole('dialog', { name: '更换计划' })
      await choose(planDialog, '目标计划', '标准计划')
      await checkDialog(page, planDialog, 'm', width, 'subscription-plan')
      const planWindow = await planDialog.elementHandle()
      await planDialog.getByRole('button', { name: '预览影响' }).click()
      await expect(planDialog.getByText('已选 1 个 · 预计影响 1 个')).toBeVisible()
      expect(await planDialog.evaluate((element, previous) => element === previous, planWindow)).toBe(true)
      await planDialog.getByRole('button', { name: '确认并创建任务' }).click()
      const job = page.getByRole('dialog', { name: '订阅批量任务' })
      await job.getByRole('button', { name: '执行任务' }).click()
      await expect(job.getByText(/已完成.*已处理 1\/1/)).toBeVisible()
      await job.getByRole('button', { name: '关闭', exact: true }).click()

      await page.goto('/users')
      const menu = page.getByLabel('member 的操作')
      await menu.click()
      await page.getByRole('menuitem', { name: '改邮箱' }).click()
      const userEdit = page.getByRole('dialog', { name: '编辑用户' })
      await userEdit.getByLabel('邮箱').fill('updated@example.test')
      await checkDialog(page, userEdit, 'm', width, 'user-edit')
      await userEdit.getByRole('button', { name: '保存' }).click()
      await expect(userEdit).toBeHidden()
      await expect(menu).toBeFocused()
      await menu.click()
      await page.getByRole('menuitem', { name: '管理订阅计划' }).click()
      const rights = page.getByRole('dialog', { name: 'member · 订阅计划' })
      await expect(rights.getByRole('button', { name: '确认开通' })).toBeEnabled()
      await rights.getByLabel('备注').fill('开通测试')
      await checkDialog(page, rights, 'l', width, 'user-entitlement')
      await rights.getByRole('button', { name: '确认开通' }).click()
      await expect(rights).toBeHidden()
      await expect(menu).toBeFocused()
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
