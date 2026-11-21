import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.CORE_C_BASE_URL ?? 'http://127.0.0.1:4186'
const output = 'development/screenshots/core-c'
const now = '2026-11-21T09:00:00.000Z'
const timestamps = { createdAt: now, updatedAt: now }
const source = {
  ...timestamps, id: 'src_1', name: '亚太节点订阅', type: 'remote', enabled: true, keepOnFailure: true,
  warnings: [], detectedFormat: 'mihomo', lastSuccessAt: now, refreshIntervalMinutes: 60,
}
const node = {
  ...timestamps, id: 'node_1', displayName: '东京中继', protocol: 'vless', server: 'tokyo.example.com',
  port: 443, enabled: true, retained: false, sourceIds: [source.id], lastSeenAt: now, tags: ['中继'], region: '日本', order: 1,
}
const group = {
  ...timestamps, id: 'grp_1', name: '亚太分组', sourceIds: [source.id], includedNodeIds: [],
  excludedNodeIds: [], nodeOrder: [node.id], rules: { region: '日本' }, resolvedNodeIds: [node.id],
}
const subscription = { id: 'sub_1', name: '团队订阅', groupIds: [group.id] }
const fixtures = {
  '/api/bootstrap': { initialized: true, user: { id: 'usr_1', username: 'admin', role: 'admin' } },
  '/api/admin/catalog': { schemaVersion: 2, revision: 1, updatedAt: now, sources: [source], nodes: [node], groups: [group] },
  '/api/admin/catalog/sources/src_1/preview-diff': {
    id: 'd284b581-8f47-46cc-a524-ab43205809da', format: 'mihomo',
    diff: { added: 2, updated: 1, missing: 1, duplicates: 1, skipped: 4, parseFailed: 0 },
  },
  '/api/admin/catalog/sources/src_1/confirm-sync': { success: true, source },
  '/api/admin/catalog/nodes/node_1/details': {
    credentials: { uuid: 'e62263eb-c57d-43cf-8a2d-8fe09ce0d30b' },
    tls: { enabled: true }, extensions: {}, rawVariants: [],
  },
  '/api/admin/catalog/nodes/node_1/test-output': { outputNodes: 1, body: 'proxies: []', diagnostics: [] },
  '/api/admin/subscriptions': { subscriptions: [subscription] },
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
try {
  await mkdir(output, { recursive: true })
  for (const [width, height, layout] of [[1440, 900, 'sidebar'], [390, 844, 'topbar']]) {
    const context = await browser.newContext({ baseURL, viewport: { width, height } })
    await context.addInitScript((layout) => {
      localStorage.setItem('subpanel.theme', 'light')
      localStorage.setItem('subpanel:admin-layout', layout)
    }, layout)
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/admin/catalog/groups/preview') {
        const { subscriptionId } = route.request().postDataJSON()
        return route.fulfill({ json: {
          matched: 5, disabled: 1, incompatible: 1, outputNodes: 3, affectedSubscriptions: 2,
          nodes: [{ id: node.id, displayName: node.displayName }],
          entitlement: subscriptionId ? { authorizedNodeIds: [node.id], outputNodes: 1, reason: null } : undefined,
        } })
      }
      return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
    })
    const page = await context.newPage()
    const openRow = async (path, name, action) => {
      await page.goto(`/catalog/${path}`)
      await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: '更多操作' }).click()
      await page.getByRole('button', { name: action, exact: true }).click()
    }
    const capture = async (name) => {
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `${output}/${name}-${width}.png`, animations: 'disabled' })
    }

    await openRow('sources', source.name, '刷新')
    await expect(page.getByRole('region', { name: '同步差异' })).toContainText('解析失败')
    await capture('sync-diff')
    await page.getByRole('button', { name: '确认同步' }).click()
    await expect(page.getByText('来源已刷新')).toBeVisible()

    await openRow('nodes', node.displayName, '编辑')
    await expect(page.getByLabel('uuid', { exact: true })).toBeVisible()
    await capture('node-drawer')
    await page.getByRole('button', { name: '测试转换输出' }).click()
    await expect(page.getByText('可输出 1 个节点')).toBeVisible()

    await openRow('groups', group.name, '编辑')
    await page.getByLabel('订阅权限预览').click()
    await page.getByRole('option', { name: subscription.name }).click()
    await expect(page.getByRole('region', { name: '分组规则预览' })).toContainText('授权 1')
    await capture('group-preview')
    await context.close()
  }
} finally {
  await browser.close()
}
