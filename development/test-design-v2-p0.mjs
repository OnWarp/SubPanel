import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.DESIGN_V2_BASE_URL ?? 'http://127.0.0.1:4181'
const output = 'development/screenshots/design-v2-p0'
const now = '2026-11-20T08:30:00.000Z'
const sources = [
  { id: 'src_1', name: 'Main Subscription', type: 'remote', remoteHost: 'main.example.com', detectedFormat: 'mihomo', lastSuccessAt: now, refreshIntervalMinutes: 60, enabled: true },
  { id: 'src_2', name: 'Backup Source', type: 'remote', remoteHost: 'backup.example.com', refreshIntervalMinutes: 120, lastErrorCode: 'FETCH_FAILED', enabled: true },
  { id: 'src_3', name: 'Manual Nodes', type: 'manual', detectedFormat: 'uri-list', lastSuccessAt: now, enabled: false },
].map(source => ({ createdAt: now, updatedAt: now, warnings: [], keepOnFailure: true, ...source }))
const nodes = sources.flatMap(({ id }, index) => Array.from({ length: [128, 46, 12][index] }, () => ({ sourceIds: [id] })))
const fixtures = {
  '/api/bootstrap': { initialized: true, user: { id: 'usr_1', username: 'admin', role: 'admin' } },
  '/api/admin/catalog': { schemaVersion: 2, revision: 1, updatedAt: now, sources, nodes, groups: [] },
  '/api/admin/stats': { users: 1284, activeSubscriptions: 936, expiringSubscriptions: 18, pendingTickets: 6, plans: 4, groups: 12, nodes: 186 },
  '/api/admin/catalog/preview': { format: 'uri-list', nodes: [{ protocol: 'ss', displayName: 'Demo', server: 'demo.example.com', port: 8388 }], warnings: [] },
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ baseURL })
await page.route('**/api/**', route => {
  const path = new URL(route.request().url()).pathname
  return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
})

try {
  await mkdir(output, { recursive: true })
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 })
    for (const theme of ['light', 'dark']) {
      for (const [name, path, title, readyText] of [
        ['sources', '/catalog/sources', '来源', 'Main Subscription'],
        ['dashboard', '/dashboard', '概览', '1284'],
      ]) {
        await page.goto(path)
        await page.evaluate(({ theme, layout }) => {
          localStorage.setItem('subpanel.theme', theme)
          localStorage.setItem('subpanel:admin-layout', layout)
        }, { theme, layout: width === 1440 ? 'sidebar' : 'topbar' })
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.locator('h1')).toHaveCount(1)
        await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
        await expect(page.getByText(readyText, { exact: true })).toBeVisible()
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        await page.screenshot({ path: join(output, `${name}-${width}-${theme}.png`), animations: 'disabled' })
      }
    }
  }

  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Built CSS minifies 0ms to 0s; either serialisation means zero duration.
  assert.match(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--duration-ui').trim()), /^0(m?s)?$/)

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/catalog/sources')
    await expect(page.getByText('Main Subscription')).toBeVisible()
    const search = page.getByRole('searchbox', { name: '搜索来源' })
    const status = page.getByRole('combobox', { name: '来源状态' })
    const add = page.getByRole('button', { name: '添加来源' })
    const bounds = await Promise.all([search.boundingBox(), status.boundingBox(), add.boundingBox()])
    assert(bounds.every(box => box && box.x >= 0 && box.x + box.width <= width))
    assert(bounds[0].x + bounds[0].width <= bounds[1].x && bounds[1].x + bounds[1].width <= bounds[2].x)
    assert(Math.max(...bounds.map(box => box.y)) - Math.min(...bounds.map(box => box.y)) < 10)
    await expect(page.locator('.batch-toolbar')).toHaveCount(0)
    await search.fill('Backup')
    await expect(page.getByText('Main Subscription')).toHaveCount(0)
    await page.getByRole('button', { name: '重置筛选' }).click()
    await status.click()
    await page.getByRole('option', { name: '已停用' }).click()
    await expect(page.getByText('Manual Nodes')).toBeVisible()
    await expect(page.getByText('Main Subscription')).toHaveCount(0)
    await page.getByRole('button', { name: '重置筛选' }).click()
    await page.getByRole('checkbox', { name: '选择来源 Main Subscription' }).check()
    await expect(page.locator('.batch-toolbar')).toBeVisible()
    await page.getByRole('checkbox', { name: '选择来源 Main Subscription' }).uncheck()
    await expect(page.locator('.batch-toolbar')).toHaveCount(0)

    const more = page.getByRole('row').filter({ hasText: 'Main Subscription' }).getByRole('button', { name: '更多操作' })
    await more.focus()
    await more.press('Enter')
    const edit = page.getByRole('button', { name: '编辑', exact: true })
    await expect(edit).toBeVisible()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    await expect(edit).toBeHidden()
    await expect(more).toBeFocused()
    assert(await more.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none'))
    await more.press('Enter')
    await edit.click()
    const drawer = page.getByRole('dialog', { name: '编辑来源' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByLabel('请求 Headers')).toBeHidden()
    await drawer.getByText('高级设置').click()
    await expect(drawer.getByLabel('请求 Headers')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(more).toBeFocused()

    await add.focus()
    await add.press('Enter')
    const createDrawer = page.getByRole('dialog', { name: '添加来源' })
    await expect(createDrawer.getByLabel('来源预览')).toHaveCount(0)
    await createDrawer.getByLabel('来源内容').fill('example input')
    await createDrawer.getByRole('button', { name: '预览', exact: true }).click()
    await expect(createDrawer.getByLabel('来源预览')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(createDrawer).toBeHidden()
    await expect(add).toBeFocused()
    console.log(`Sources keyboard and controls passed at ${width}px`)
  }

  const summaries = page.locator('.admin-account summary:visible')
  await page.getByRole('searchbox').fill('Backup')
  await summaries.click()
  await page.getByRole('button', { name: '侧边栏' }).click()
  await expect(summaries).toBeFocused()
  await expect(page.getByRole('searchbox')).toHaveValue('Backup')
  const collapse = page.getByRole('button', { name: '收起侧栏' })
  await collapse.click()
  await expect(page.getByRole('button', { name: '展开侧栏' })).toBeFocused()
  await page.reload()
  await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible()
  assert.equal(await page.evaluate(() => localStorage.getItem('subpanel:admin-layout')), 'sidebar')
  await summaries.click()
  await page.keyboard.press('Escape')
  await expect(summaries).toBeFocused()
  await expect(page.getByRole('navigation', { name: '管理员账号菜单' })).toBeHidden()
  console.log('Layout, sidebar and account menu focus passed')
} finally {
  await browser.close()
}
