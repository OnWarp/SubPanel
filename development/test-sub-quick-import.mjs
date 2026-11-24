import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const baseURL = process.env.SUB_QUICK_BASE_URL ?? 'http://127.0.0.1:4187'
const output = 'development/screenshots/sub-quick-import'
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
    auto: 'https://sub.example/sub/sample',
    mihomo: 'https://sub.example/sub/sample/mihomo',
    singbox: 'https://sub.example/sub/sample/singbox',
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


const shareId = 'sample'.padEnd(43, '_')
const limitedShareId = 'limited'.padEnd(43, '_')
const clients = ['mihomo', 'clash', 'clash-meta', 'stash', 'singbox', 'karing', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket']
const prefixes = {
  mihomo: 'clash://install-config?url=',
  clash: 'clash://install-config?url=',
  'clash-meta': 'clash://install-config?url=',
  stash: 'stash://install-config?url=',
  surge: 'surge:///install-config?url=',
  loon: 'loon://import?sub=',
  shadowrocket: 'shadowrocket://add/sub://',
}
for (const client of clients) subscription.links[client] = subscription.links.auto + '/' + client
const before = process.argv.includes('--before')
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
await mkdir(output, { recursive: true })

try {
  let importClicks = 0
  for (const width of [1440, 1024, 390]) {
    for (const surface of ['personal', 'admin', 'share']) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        userAgent: width === 390 ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        permissions: ['clipboard-read', 'clipboard-write'],
      })
      try {
        const page = await context.newPage()
        page.setDefaultTimeout(7000)
        const user = surface === 'admin' ? admin : surface === 'personal' ? { ...admin, role: 'user', id: 'usr_2' } : null
        await context.route('**/api/**', async (route) => {
          const { pathname, searchParams } = new URL(route.request().url())
          const respond = json => route.fulfill({ json })
          if (pathname === '/api/bootstrap') return respond({ initialized: true, user })
          if (pathname === '/api/account/profile') return respond({ user, avatar: { url: '/logo.png' } })
          if (pathname === '/api/account/subscriptions') return respond({ subscriptions: [subscription], shareEnabled: true })
          if (pathname === '/api/me/subscriptions/sub_1' || pathname === '/api/admin/subscriptions/sub_1') return respond({ subscription })
          if (pathname === '/api/admin/subscriptions') return respond({ subscriptions: [subscription], total: 1, page: 1, pageSize: 20 })
          if (pathname === '/api/admin/users') return respond({ users: [admin], total: 1 })
          if (pathname === '/api/admin/catalog') return respond({ groups: [], nodes: [], sources: [] })
          if (pathname === '/api/admin/plans') return respond({ plans: [] })
          if (pathname.includes('/bindings/')) return respond({ mode: 'inherit', revision: 1, effectiveTemplate: null })
          if (pathname.endsWith('/meta')) return respond({ meta: { subscriptionName: subscription.name, nodeCount: 2 }, linkBaseUrl: 'https://sub.example' })
          if (pathname.endsWith('/export')) {
            if (searchParams.get('type') === 'link') {
              if (pathname.includes(limitedShareId)) return route.fulfill({ status: 404, json: { error: { message: '链接不可用' } } })
              return respond({ link: subscription.links.auto })
            }
            return route.fulfill({
              body: 'proxies: []',
              headers: { 'content-type': 'application/yaml', 'content-disposition': 'attachment; filename="sample.yaml"' },
            })
          }
          if (pathname === '/api/account/subscription-platforms') return respond({ platforms: ['auto', ...clients].map(platform => ({ platform })) })
          return respond({})
        })
        await page.goto(baseURL + { personal: '/subscriptions', admin: '/delivery/subscriptions', share: '/s/' + shareId }[surface])
        if (surface === 'admin') {
          await page.getByRole('button', { name: '更多操作', exact: true }).first().click()
          await page.getByRole('button', { name: '查看详情' }).click()
        }
        const linkHeading = page.getByRole('heading', { name: { personal: '订阅链接', admin: '客户端链接', share: '客户端导入' }[surface], exact: true })
        await linkHeading.scrollIntoViewIfNeeded()
        const screenshot = () => page.screenshot({
          path: `${output}/${before ? 'before' : 'after'}-${surface}-${width}.png`,
          animations: 'disabled',
        })
        if (before || surface !== 'share') await screenshot()
        if (!before) {
          const panel = surface === 'admin' ? page.getByRole('dialog', { name: '主订阅' }) : page
          const copyName = surface === 'personal' ? '复制' : '复制订阅链接'
          await panel.getByRole('button', { name: copyName, exact: true }).click()
          await page.waitForFunction(async expected => (await navigator.clipboard.readText()) === expected, subscription.links.auto)
          assert.equal(await panel.getByText(subscription.links.auto, { exact: true }).count(), 1)

          if (surface === 'share') await screenshot()
          const disclosure = panel.getByText('更多导入方式', { exact: true })
          const imports = panel.locator('.subscription-imports')
          const primaryImports = await imports.locator('a:visible').count()
          assert.equal(primaryImports, surface === 'share' ? (width === 390 ? 3 : 1) : (width === 390 ? 4 : 3))
          await disclosure.click()
          const anchors = await imports.locator('a').all()
          const expectedClients = Object.keys(prefixes).filter(client =>
            surface !== 'share' || !['clash', 'clash-meta', 'stash'].includes(client))
          assert.equal(anchors.length, expectedClients.length)
          const clicked = []
          await page.exposeFunction('recordImport', href => clicked.push(href))
          await page.evaluate(() => {
            document.addEventListener('click', event => {
              const anchor = event.target.closest('.subscription-imports a')
              if (anchor) {
                event.preventDefault()
                window.recordImport(anchor.getAttribute('href'))
              }
            })
          })
          for (const anchor of anchors) await anchor.click()
          const expected = expectedClients.map(client => {
            const link = surface === 'share'
              ? `https://sub.example/api/shares/${shareId}/export?client=${client}`
              : subscription.links[client]
            return prefixes[client] + (client === 'shadowrocket' ? Buffer.from(link).toString('base64') : encodeURIComponent(link))
          })
          assert.deepEqual(clicked.sort(), expected.sort())
          importClicks += clicked.length
          await panel.getByText('未检测到该应用，请先安装', { exact: true }).waitFor()
          await imports.getByRole('button', { name: /复制 sing-box 链接/i }).click()
          await page.waitForFunction(async expected => (await navigator.clipboard.readText()) === expected, surface === 'share'
            ? `https://sub.example/api/shares/${shareId}/export?client=singbox`
            : subscription.links.singbox)
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
          if (surface === 'share') {
            await page.goto(baseURL + '/s/' + limitedShareId)
            await page.getByRole('button', { name: '复制订阅链接', exact: true }).click()
            await page.getByText('链接不可用', { exact: true }).waitFor()
            assert.equal(await page.getByText(subscription.links.auto, { exact: true }).count(), 0)
            await page.getByText('更多导入方式', { exact: true }).click()
            await page.getByText('下载配置', { exact: true }).click()
            const download = page.waitForEvent('download')
            await imports.getByRole('button', { name: 'Mihomo / Clash', exact: true }).click()
            assert.match((await download).suggestedFilename(), /\.ya?ml$/)
          }
        }
      } finally {
        await context.close()
      }
    }
  }
  console.log(before ? 'Captured 9 baseline screenshots' : `Verified ${importClicks} import clicks, 18 copy actions and 9 layouts`)
} finally {
  await browser.close()
}
