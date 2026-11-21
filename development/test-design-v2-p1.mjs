import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.DESIGN_V2_BASE_URL ?? 'http://127.0.0.1:4181'
const output = 'development/screenshots/design-v2-p1'
const now = '2026-11-20T08:30:00.000Z'
const dates = { createdAt: now, updatedAt: now }
const sources = [
  { id: 'src_1', name: 'Main Subscription', type: 'remote', remoteHost: 'main.example.com', detectedFormat: 'mihomo', lastSuccessAt: now, refreshIntervalMinutes: 60, enabled: true },
  { id: 'src_2', name: 'Backup Source', type: 'remote', remoteHost: 'backup.example.com', refreshIntervalMinutes: 120, lastErrorCode: 'FETCH_FAILED', enabled: true },
  { id: 'src_3', name: 'Manual Nodes', type: 'manual', detectedFormat: 'uri-list', lastSuccessAt: now, enabled: false },
].map(source => ({ ...dates, warnings: [], keepOnFailure: true, ...source }))
const nodes = [
  ['Tokyo Edge', 'ss', 'src_1'],
  ['Singapore Relay', 'vless', 'src_1'],
  ['Seoul Backup', 'trojan', 'src_2'],
  ['Taipei Manual', 'ss', 'src_3'],
].map(([displayName, protocol, source], order) => ({
  ...dates, id: `node_${order}`, displayName, protocol, sourceIds: [source],
  server: `${displayName.split(' ')[0].toLowerCase()}.example.com`, port: 443,
  enabled: order !== 3, retained: order === 3, order,
}))
const groups = [
  { id: 'grp_1', name: 'Asia Pacific', sourceIds: ['src_1'], includedNodeIds: ['node_2'] },
  { id: 'grp_2', name: 'Fallback', sourceIds: ['src_2'], includedNodeIds: [] },
  { id: 'grp_3', name: 'Manual Pool', sourceIds: ['src_3'], includedNodeIds: [] },
].map(group => ({ ...dates, excludedNodeIds: [], nodeOrder: [], ...group }))
const catalog = { schemaVersion: 2, revision: 1, updatedAt: now, sources, nodes, groups }
const routes = [
  ['sources', '来源', 'Main Subscription'],
  ['nodes', '节点', 'Tokyo Edge'],
  ['groups', '分组', 'Asia Pacific'],
]
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ baseURL })
let catalogState = 'populated'
let unblockCatalog
const catalogGate = new Promise(resolve => { unblockCatalog = resolve })
await context.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname
  if (path === '/api/admin/catalog') {
    const state = catalogState
    if (state === 'pending') {
      await catalogGate
      return route.fulfill({ status: 500, json: { error: '加载失败' } })
    }
    return route.fulfill({ json: state === 'empty' ? { ...catalog, sources: [], nodes: [], groups: [] } : catalog })
  }
  if (path === '/api/admin/catalog/nodes/node_0' && route.request().method() === 'PATCH') {
    Object.assign(nodes[0], route.request().postDataJSON())
    return route.fulfill({ json: {} })
  }
  const fixtures = {
    '/api/bootstrap': { initialized: true, user: { id: 'usr_1', username: 'admin', role: 'admin' } },
    '/api/admin/subscriptions': { subscriptions: [] },
  }
  return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
})
const page = await context.newPage()
page.setDefaultTimeout(7000)
const go = name => page.goto(`/catalog/${name}`)
const noPageOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)

async function checkRowFocus(rowText, drawerTitle) {
  const more = page.getByRole('row').filter({ hasText: rowText }).getByRole('button', { name: '更多操作' })
  const edit = page.getByRole('button', { name: '编辑', exact: true })
  await more.focus()
  await more.press('Enter')
  await expect(edit).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(edit).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(edit).toBeHidden()
  await expect(more).toBeFocused()
  assert(await more.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none'))
  await more.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  const drawer = page.getByRole('dialog', { name: drawerTitle })
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(more).toBeFocused()
}

try {
  await mkdir(output, { recursive: true })
  for (const [width, theme, layout] of [
    [1440, 'light', 'sidebar'], [768, 'light', 'topbar'], [390, 'light', 'topbar'], [390, 'dark', 'topbar'], [320, 'light', 'topbar'],
  ]) {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 })
    await go('sources')
    await page.evaluate(({ theme, layout }) => {
      localStorage.setItem('subpanel.theme', theme)
      localStorage.setItem('subpanel:admin-layout', layout)
    }, { theme, layout })
    for (const [name, title, readyText] of routes) {
      await go(name)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('h1')).toHaveCount(1)
      await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: readyText })).toBeVisible()
      await expect(page.getByRole('toolbar', { name: '批量操作' })).toHaveCount(0)
      assert(await noPageOverflow(), `${name} at ${width}px`)
      if (width !== 320) await page.screenshot({ path: join(output, `${name}-${width}-${theme}.png`), animations: 'disabled' })
      const button = page.getByRole('row').filter({ hasText: readyText }).getByRole('button', { name: '更多操作' })
      const bounds = await button.boundingBox()
      assert(bounds.x + bounds.width <= width)
      await checkRowFocus(readyText, `编辑${title}`)
    }
  }

  await go('nodes')
  const moreFilters = page.locator('.sp-filter-more > summary')
  await expect(page.getByRole('combobox', { name: '节点协议' })).toBeHidden()
  await moreFilters.press('Enter')
  const protocol = page.getByRole('combobox', { name: '节点协议' })
  await protocol.click()
  await page.getByRole('option', { name: 'vless' }).click()
  await expect(page.getByText('Singapore Relay')).toBeVisible()
  await expect(page.getByText('Tokyo Edge')).toHaveCount(0)
  await protocol.press('Escape')
  await expect(protocol).toBeHidden()
  await expect(moreFilters).toHaveText('更多筛选（已生效）')
  await expect(moreFilters).toBeFocused()
  await page.getByRole('button', { name: '重置筛选' }).click()
  const search = page.getByRole('searchbox')
  await expect(search).toBeFocused()
  await expect(page.getByText('Tokyo Edge')).toBeVisible()

  await page.getByRole('checkbox', { name: '选择节点 Tokyo Edge' }).check()
  const batch = page.getByRole('toolbar', { name: '批量操作' })
  await expect(batch).toContainText('已选择 1 项')
  const moreBatch = batch.getByRole('button', { name: '更多批量操作' })
  await moreBatch.press('Enter')
  const options = batch.getByRole('group', { name: '批量操作选项' })
  await expect(options.getByRole('button')).toHaveCount(4)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Escape')
  await expect(options).toBeHidden()
  await expect(moreBatch).toBeFocused()
  await moreBatch.press('Enter')
  await options.getByRole('button', { name: '停用', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '停用节点' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(moreBatch).toBeFocused()
  await batch.getByRole('button', { name: '清除选择' }).click()
  await expect(search).toBeFocused()

  await search.fill('Tokyo')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.admin-account summary:visible').click()
  await page.getByRole('button', { name: '侧边栏' }).click()
  await expect(search).toHaveValue('Tokyo')
  await expect(page.getByText('Singapore Relay')).toHaveCount(0)

  const nodeRow = page.getByRole('row').filter({ hasText: 'Tokyo Edge' })
  await nodeRow.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByText('启用节点', { exact: true }).click()
  await page.getByRole('button', { name: '保存修改' }).click()
  await expect(nodeRow.getByText('已停用')).toBeVisible()
  await expect(page.getByText('节点已更新')).toBeVisible()

  await go('groups')
  await page.getByRole('checkbox', { name: '选择分组 Asia Pacific' }).check()
  await page.getByRole('searchbox').fill('missing')
  await expect(page.getByText('暂无匹配分组')).toBeVisible()
  await expect(batch).toHaveCount(0)
  await page.getByRole('button', { name: '重置筛选' }).click()
  await expect(page.getByText('Asia Pacific')).toBeVisible()

  catalogState = 'pending'
  await go('nodes')
  await expect(page.getByText('正在加载节点')).toBeVisible()
  await expect(page.locator('table[aria-busy="true"] tbody tr[aria-hidden="true"]')).toHaveCount(3)
  unblockCatalog()
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  await expect(page.getByText('暂无节点', { exact: true })).toHaveCount(0)
  catalogState = 'empty'
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('暂无节点', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '管理来源' }).click()
  await expect(page.getByText('暂无来源', { exact: true })).toBeVisible()
  const addSource = page.getByRole('button', { name: '创建首个来源' })
  await addSource.click()
  await expect(page.getByRole('dialog', { name: '添加来源' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(addSource).toBeFocused()
  await go('groups')
  await expect(page.getByText('暂无分组', { exact: true })).toBeVisible()
  console.log('Catalog screenshots, filtering, selection, focus, layout, mutations and empty/error recovery passed')
} finally {
  await browser.close()
}
