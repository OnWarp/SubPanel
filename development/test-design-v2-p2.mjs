import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.DESIGN_V2_BASE_URL ?? 'http://127.0.0.1:4181'
const output = 'development/screenshots/design-v2-p2'
const now = '2026-11-21T08:30:00.000Z'
const users = [{ id: 'usr_1', username: 'alice', role: 'user', enabled: true, email: 'alice@example.com', subscriptionCount: 1, createdAt: now }]
const subscription = {
  id: 'sub_1', userId: 'usr_1', name: '主力订阅', groupIds: ['grp_1'], tokenPrefix: 'abcd', enabled: true,
  defaultClient: 'mihomo', revision: 2, startsAt: Date.parse(now), expiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
  createdAt: now, updatedAt: now, planId: 'plan_1', planName: '月付', trafficGb: 100, speedLimitMbps: 0, deviceLimit: 3,
  links: { mihomo: 'https://sub.example/sub/token?client=mihomo', singbox: 'https://sub.example/sub/token?client=singbox' },
  diagnostics: { mihomo: { inputNodes: 2, outputNodes: 2, skippedNodes: 0, available: true, diagnostics: [] } },
}
const plans = [{ id: 'plan_1', name: '月付', description: '30 天', groupIds: ['grp_1'], durationDays: 30, trafficGb: 100, speedLimitMbps: 0, deviceLimit: 3, enabled: true, sortOrder: 0 }]
const catalog = { schemaVersion: 2, revision: 1, updatedAt: now, sources: [], nodes: [], groups: [{ id: 'grp_1', name: '默认分组', sourceIds: [], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [], createdAt: now, updatedAt: now }] }
const templates = {
  templates: [{ id: 'tpl_1', name: '办公分流', revision: 2, status: 'published', publishedVersionId: 'ver_1', publishedAt: now, publishedSequence: 3, updatedAt: now, createdAt: now, references: { isDefault: true, directBindings: 0, inheritedCount: 1 } }],
  defaultId: 'tpl_1', defaultRevision: 1, total: 1, page: 1, pageSize: 100,
}
const binding = { mode: 'inherit', revision: 1, effectiveTemplate: { templateId: 'tpl_1', templateName: '办公分流', versionId: 'ver_1', sequence: 3 } }
const domain = { id: 'dom_1', hostname: 'panel.example', enabled: true, verificationStatus: 'verified', verifiedAt: now, lastCheckAt: now, lastCheckError: null, note: '', createdAt: now, updatedAt: now }
const fixtures = {
  '/api/bootstrap': { initialized: true, user: { id: 'usr_admin', username: 'admin', role: 'admin', enabled: true } },
  '/api/admin/catalog': catalog,
  '/api/admin/plans': { plans },
  '/api/admin/subscriptions': { subscriptions: [subscription], total: 1 },
  '/api/admin/subscriptions/trial': { trialPlanId: null, trialDays: null },
  '/api/admin/users': { users, total: 1, page: 1, pageSize: 20 },
  '/api/admin/invitations': { invitations: [] },
  '/api/admin/shares': { shares: [{ id: 'shr_1', ownerUserId: 'usr_1', subscriptionId: 'sub_1', tokenPrefix: 'abcd', remark: '给同事', status: 'active', expiresAt: '2027-01-01T00:00:00.000Z', accessCount: 2, maxAccessCount: null, createdAt: now }] },
  '/api/admin/share-settings': { settings: { enabled: true, createAllowed: true, maxSharesPerSubscription: 5, maxActiveSharesPerUser: 10, maxValidityDays: 30, defaultAllowOriginalLink: false, defaultAccessControl: 'none', requireLoginDefault: false, publicBaseUrl: '' } },
  '/api/admin/tickets': { tickets: [{ id: 1, userId: 'usr_1', username: 'alice', title: '无法更新订阅', level: 1, status: 'open', createdAt: now, updatedAt: now, lastReplyBy: 'user', lastReplyAt: now }], total: 1 },
  '/api/admin/system/registration': { mode: 'invite' },
  '/api/admin/email-domains': { domains: [{ domain: 'example.com', createdAt: now }] },
  '/api/admin/system/mail': { settings: { provider: 'smtp', from: 'panel@example.com', smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'panel', smtpPasswordSet: true, resendApiKeySet: false } },
  '/api/admin/mail-templates': { templates: [{ key: 'verification', subject: '验证码', body: '你好 {{username}}' }] },
  '/api/admin/mail-broadcasts': { broadcasts: [{ id: 'bc_1', subject: '维护通知', status: 'sent', total: 3, sent: 3, failed: 0, created_at: now }] },
  '/api/admin/system/reminders': { reminder_days: 3 },
  '/api/admin/system/domains': { panel: [domain], subscription: [{ ...domain, id: 'dom_2', hostname: 'sub.example' }], primaryPanelDomainId: 'dom_1', primarySubscriptionDomainId: 'dom_2', restrictionEnabled: true },
  '/api/admin/system/subscription-platforms': { platforms: [{ platform: 'mihomo', displayName: 'Mihomo', enabled: true, sortOrder: 0 }] },
  '/api/admin/system/subscription-templates': templates,
  '/api/admin/system/subscription-templates/bindings/sub_1': binding,
  '/api/health': { ok: true, version: '0.1.0', cron: { status: 'success', ranAt: now, finishedAt: now } },
  '/api/admin/system/status': { status: { databaseName: 'subpanel', modules: [{ module: 'delivery', label: '订阅', backend: 'd1', schemaVersion: 4, updatedAt: now }], migrations: [{ name: '0001_init', appliedAt: now }] } },
}

const routes = [
  ['registration', '/system/registration', 1, '系统设置', '邮箱域名白名单'],
  ['mail', '/system/mail', 1, '系统设置', '到期提醒'],
  ['distribution', '/system/distribution', 1, '系统设置', '订阅平台展示'],
  ['status', '/system/status', 1, '系统设置', '来源刷新定时任务'],
  ['subscriptions', '/delivery/subscriptions', 2, '订阅', '主力订阅'],
  ['shares', '/delivery/shares', 2, '分享管理', '给同事'],
  ['plans', '/plans', 1, '订阅计划', '注册试用'],
  ['users', '/users', 1, '用户管理', 'alice'],
  ['tickets', '/delivery/tickets', 1, '工单', '无法更新订阅'],
  ['invites', '/invites', 1, '用户管理', '注册邀请码'],
]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ baseURL })
await page.route('**/api/**', route => {
  const path = new URL(route.request().url()).pathname
  const body = fixtures[path]
  return route.fulfill({ status: body ? 200 : 404, json: body ?? { error: { message: '未模拟' } } })
})

try {
  await mkdir(output, { recursive: true })
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 })
    const themes = width === 390 ? ['light', 'dark'] : ['light']
    for (const theme of themes) {
      for (const [name, path, level, title, readyText] of routes) {
        await page.goto(path)
        await page.evaluate(({ theme, layout }) => {
          localStorage.setItem('subpanel:layout:admin:usr_admin', JSON.stringify({
            pc: { navigation: layout },
            theme,
          }))
        }, { theme, layout: width === 1440 ? 'sidebar' : 'topbar' })
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.locator('h1')).toHaveCount(level === 1 ? 1 : 0)
        await expect(page.getByRole('heading', { level, name: title, exact: true })).toBeVisible()
        await expect(page.getByText(readyText, { exact: true }).first()).toBeAttached()
        if (name === 'subscriptions') {
          await page.getByRole('button', { name: '更多操作' }).click()
          await page.getByRole('button', { name: '查看详情' }).click()
          const details = page.getByRole('dialog', { name: '主力订阅' })
          await expect(details.getByText('基本信息')).toBeVisible()
          await expect(details.locator('.key-value-rows').first()).toBeVisible()
          await expect(details.locator('.subscription-link-row .link-url')).toBeVisible()
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} overflows at ${width}`)
        await page.screenshot({ path: join(output, `${name}-${width}-${theme}.png`), animations: 'disabled' })
        if (name === 'subscriptions') await page.keyboard.press('Escape')
      }
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/delivery/subscriptions')
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑订阅' })
  await expect(editor).toBeVisible()
  const focusedClose = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '关闭')
  assert.equal(focusedClose, false)
  await editor.getByLabel('订阅名称').fill('改过的名称')
  await page.keyboard.press('Escape')
  await expect(editor.getByText('关闭将放弃未保存的更改')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editor.getByText('关闭将放弃未保存的更改')).toHaveCount(0)
  await expect(editor).toBeVisible()
  await page.keyboard.press('Escape')
  await editor.getByRole('button', { name: '放弃更改' }).click()
  await expect(editor).toBeHidden()

  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await editor.getByLabel('订阅名称').fill('立即取消')
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByText('关闭将放弃未保存的更改')).toHaveCount(0)
  console.log('Subscription drawer keyboard and discard prompt passed')
} finally {
  await browser.close()
}
