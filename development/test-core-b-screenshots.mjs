import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const baseURL = process.env.CORE_B_BASE_URL ?? 'http://127.0.0.1:4179'
const output = 'development/screenshots/core-b'
const admin = { id: 'usr_1', username: 'admin', role: 'admin', enabled: true }
const subscription = {
  id: 'sub_1',
  userId: 'usr_2',
  name: '主订阅',
  groupIds: ['grp_1'],
  tokenPrefix: 'abcd1234',
  enabled: true,
  planId: 'plan_1',
  planName: '标准计划',
  planState: 'active',
  status: 'active',
  statusLabel: '正常',
  statusReason: '订阅有效',
  statusFix: null,
  trafficGb: 100,
  speedLimitMbps: 0,
  deviceLimit: 3,
  defaultClient: 'mihomo',
  revision: 2,
  startsAt: null,
  expiresAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z',
  links: {
    auto: 'https://sub.example/sub/example-token',
    mihomo: 'https://sub.example/sub/example-token/mihomo',
    singbox: 'https://sub.example/sub/example-token/singbox',
  },
  linkError: null,
  diagnostics: {
    mihomo: { inputNodes: 2, outputNodes: 2, skippedNodes: 0, diagnostics: [], available: true, rendererVersion: '2' },
  },
  authorizedNodeCount: 2,
  configVersion: 3,
  formats: [
    { platform: 'auto', displayName: '自动识别', capability: 'nodes', capabilityLabel: '仅节点订阅', compatible: true, outputNodes: 2, note: '识别到 Mihomo 时输出完整规则配置，识别失败回退为通用节点列表' },
    { platform: 'mihomo', displayName: 'Mihomo', capability: 'full', capabilityLabel: '完整规则配置', compatible: true, outputNodes: 2, note: null },
    { platform: 'singbox', displayName: 'sing-box', capability: 'nodes', capabilityLabel: '仅节点订阅', compatible: true, outputNodes: 2, note: null },
  ],
  fetch: { lastFetchAt: null, lastPlatform: null, lastOk: null, lastStatus: null, success: 0, failure: 0, durationMs: null },
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
})
await mkdir(output, { recursive: true })

try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 900 : 844 } })
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname
      if (path === '/api/bootstrap') return route.fulfill({ json: { initialized: true, user: admin } })
      if (path === '/api/admin/subscriptions' && route.request().method() === 'GET') {
        return route.fulfill({ json: { subscriptions: [subscription], total: 1, page: 1, pageSize: 20 } })
      }
      if (path === '/api/admin/subscriptions/output-preview') {
        return route.fulfill({ json: { planGroupIds: ['grp_1'], selectedGroupIds: ['grp_1'], authorizedGroupIds: ['grp_1'], outputNodes: 2 } })
      }
      if (path === '/api/admin/users') return route.fulfill({ json: { users: [{ id: 'usr_2', username: 'alice', role: 'user', enabled: true }], total: 1 } })
      if (path === '/api/admin/catalog') {
        return route.fulfill({ json: { groups: [{ id: 'grp_1', name: '默认分组' }], nodes: [], sources: [], revision: 1 } })
      }
      if (path === '/api/admin/plans') {
        return route.fulfill({ json: { plans: [{ id: 'plan_1', name: '标准计划', enabled: true, groupIds: ['grp_1'], durationDays: 30, trafficGb: 100, speedLimitMbps: 0, deviceLimit: 3 }] } })
      }
      if (path.startsWith('/api/admin/system/subscription-templates')) {
        return route.fulfill({ json: { templates: [], defaultId: null, total: 0 } })
      }
      if (path.includes('/bindings/')) {
        return route.fulfill({ json: { mode: 'inherit', revision: 1, effectiveTemplate: null } })
      }
      return route.fulfill({ json: {} })
    })
    await page.goto(`${baseURL}/delivery/subscriptions`)
    await page.getByRole('heading', { name: '订阅', exact: true }).waitFor()
    await page.getByRole('button', { name: '添加订阅' }).click()
    await page.getByRole('dialog', { name: '添加订阅' }).waitFor()
    await page.screenshot({ path: `${output}/wizard-${width}.png`, fullPage: false })
    await page.getByRole('dialog', { name: '添加订阅' }).getByRole('button', { name: '关闭' }).click()
    await page.getByRole('row', { name: /主订阅/ }).getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('button', { name: '查看详情' }).click()
    await page.getByRole('dialog', { name: '主订阅' }).waitFor()
    await page.screenshot({ path: `${output}/detail-${width}.png`, fullPage: false })
    await page.getByRole('dialog', { name: '主订阅' }).getByRole('button', { name: '关闭' }).click()
    await page.getByRole('checkbox', { name: /选择订阅/ }).check()
    await page.getByRole('toolbar', { name: '批量操作' }).waitFor()
    await page.screenshot({ path: `${output}/batch-${width}.png`, fullPage: false })
    await page.close()
  }
} finally {
  await browser.close()
}
