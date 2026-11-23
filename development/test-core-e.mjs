import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.CORE_E_BASE_URL ?? 'http://127.0.0.1:4193'
const root = '/api/admin/system/subscription-templates'
const output = 'development/screenshots/core-e'
const password = 'local verification admin password'
const username = 'core-e-viewer'
const singbox = process.env.SINGBOX_BIN ?? 'development/verification/singbox/bin/sing-box'
let cookie

async function request(path, body, method = body === undefined ? 'GET' : 'POST', status = 200) {
  const response = await fetch(baseURL + path, {
    method,
    headers: { origin: baseURL, 'content-type': 'application/json', ...(cookie && { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  expect(response.status, `${method} ${path} ${result.code ?? ''}`).toBe(status)
  if (path === '/api/login') cookie = response.headers.get('set-cookie').split(';', 1)[0]
  return result
}

if (!(await request('/api/bootstrap')).initialized) await request('/api/setup', { username: 'admin', password }, 'POST', 201)
await request('/api/login', { username: 'admin', password })
const adminCookie = cookie
if (!(await request('/api/admin/users')).users.some(user => user.username === username)) {
  const { mode } = await request('/api/admin/system/registration')
  await request('/api/admin/system/registration', { mode: 'invite' }, 'PUT')
  const { invitations } = await request('/api/admin/invitations', { type: 'batch', count: 1 }, 'POST', 201)
  const inviteCode = new URL(invitations[0].link).pathname.split('/').at(-1)
  await request('/api/register', { username, password, email: 'core-e-viewer@example.com', inviteCode }, 'POST', 201)
  await request('/api/admin/system/registration', { mode }, 'PUT')
}
const { user } = await request('/api/login', { username, password })
const userCookie = cookie
cookie = adminCookie

const link = (name, host) => `ss://${btoa('aes-128-gcm:synthetic-password')}@${host}:8388#${encodeURIComponent(name)}`
const name = 'sing-box 灰度验证'
const existing = await request('/api/admin/catalog')
let group = existing.groups.find(item => item.name === name)
if (!group) {
  const { source } = await request('/api/admin/catalog/sources', {
    type: 'manual', name, content: [link('东京示例', 'tokyo.example'), link('新加坡示例', 'singapore.example')].join('\n'),
  }, 'POST', 201)
  ;({ group } = await request('/api/admin/catalog/groups', {
    name, sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  }, 'POST', 201))
}
const { plans } = await request('/api/admin/plans')
const plan = plans.find(item => item.name === name) ?? (await request('/api/admin/plans', {
  name, groupIds: [group.id], durationDays: 365,
}, 'POST', 201)).plan

await request(root + '/rule-sources/local', { name: '本地分流', rules: ['DOMAIN,local.example,DIRECT'] })
const yaml = `subpanel:
  singbox:
    fakeIp: true
    dnsRules:
      - domainSuffix: local.example
        resolver: local
    localRuleSets:
      - name: 本地分流
        outbound: DIRECT
  client:
    dns:
      enable: true
      nameserver: [https://1.1.1.1/dns-query]
proxy-groups:
  - name: Proxy
    type: select
    proxies: [Fast, Backup, Balance, DIRECT]
  - name: Fast
    type: url-test
    proxies: ["$SUBPANEL_NODES"]
  - name: Backup
    type: fallback
    proxies: ["$SUBPANEL_NODES"]
  - name: Balance
    type: load-balance
    proxies: ["$SUBPANEL_NODES"]
rules:
  - DOMAIN-SUFFIX,example.org,DIRECT
  - MATCH,Proxy
`
const profile = await request(root, { name, yaml }, 'POST', 201)
const profilePath = `${root}/${profile.id}`
const publish = draft => request(`${profilePath}/publish`, {
  expectedRevision: draft.revision, draftHash: draft.draftHash, singbox: true,
})
const first = await publish(profile)
const { subscription, token } = await request('/api/admin/subscriptions', {
  userId: user.id, name, planId: plan.id, groupIds: [group.id], defaultClient: 'singbox',
  templateBinding: { mode: 'specific', templateId: profile.id, expectedRevision: 1 },
}, 'POST', 201)
const pull = (client, headers) => fetch(`${baseURL}/sub/${token}${client ? '/' + client : ''}`, { headers })
const response = await pull('singbox')
expect(response.status).toBe(200)
const body = await response.text()
const config = JSON.parse(body)
expect(config).toMatchObject({
  outbounds: [{ type: 'selector' }, { type: 'urltest' }, { type: 'urltest' }, { type: 'urltest' },
    { type: 'shadowsocks' }, { type: 'shadowsocks' }, { type: 'direct' }, { type: 'block' }],
  route: {
    final: 'Proxy',
    rule_set: [{ type: 'inline', tag: '本地分流', rules: [{ domain: ['local.example'] }] }],
    rules: expect.arrayContaining([{ domain_suffix: ['example.org'], outbound: 'direct' }]),
  },
  dns: {
    servers: expect.arrayContaining([{ type: 'fakeip', tag: 'fakeip', inet4_range: '198.18.0.0/15', inet6_range: '2001:2::/48' }]),
    rules: expect.arrayContaining([{ domain_suffix: ['local.example'], action: 'route', server: 'local-dns' }]),
  },
})
expect(await (await pull('sing-box')).text()).toBe(body)
expect(await (await pull('', { 'User-Agent': 'sing-box/1.14.4' })).text()).toBe(body)
expect((await pull('singbox', { 'If-None-Match': response.headers.get('etag') })).status).toBe(304)
const sample = join(await mkdtemp('/data/tmp/core-e-import-'), 'config.json')
await writeFile(sample, body)
await promisify(execFile)(singbox, ['check', '-c', sample], { timeout: 15000 })
if (process.env.CORE_E_WRITE_SAMPLE === '1') await writeFile('development/verification/core-e-singbox.json', body)

const preview = await request(root + '/preview', {
  profileId: profile.id, versionId: first.versionId, subscriptionId: subscription.id, platform: 'singbox',
})
expect(preview).toMatchObject({
  capability: 'full', inputNodes: 2, authorizedNodes: 2, outputNodes: 2, skippedNodes: 0,
  rendererVersion: '4', effectiveVersionId: first.versionId,
})
expect(preview.body).not.toContain('synthetic-password')
const nodesOnly = ['surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic']
for (const platform of nodesOnly) {
  const result = await request(root + '/preview', { subscriptionId: subscription.id, platform })
  expect(result).toMatchObject({ capability: 'nodes', outputNodes: 2 })
  expect((await pull(platform)).status).toBe(200)
}

const updated = await request(profilePath, {
  expectedRevision: first.revision, name, yaml: yaml.replace('example.org,DIRECT', 'example.org,Fast'),
}, 'PUT')
const second = await publish(updated)
expect(second.versionId).not.toBe(first.versionId)
const current = await pull('singbox', { 'If-None-Match': response.headers.get('etag') })
expect(current.status).toBe(200)
expect(JSON.parse(await current.text()).route.rules).toContainEqual({ domain_suffix: ['example.org'], outbound: 'Fast' })
await request(`${profilePath}/rollback`, { expectedRevision: second.revision, versionId: first.versionId })
expect(await (await pull('singbox')).text()).toBe(body)

await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
try {
  for (const [width, height, layout] of [[1440, 900, 'sidebar'], [390, 844, 'topbar']]) {
    const context = await browser.newContext({ baseURL, viewport: { width, height } })
    const signIn = async (session) => {
      const [name, value] = session.split('=')
      await context.addCookies([{ name, value, url: baseURL, httpOnly: true }])
    }
    await signIn(adminCookie)
    await context.addInitScript(layout => {
      localStorage.setItem('subpanel.theme', 'light')
      localStorage.setItem('subpanel:admin-layout', layout)
    }, layout)
    const page = await context.newPage()
    const capture = async name => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `${output}/${name}-${width}.png`, animations: 'disabled' })
    }

    await page.goto('/delivery/conversions')
    await expect(page.getByRole('row').filter({ hasText: name }).first()).toContainText('Mihomo · sing-box 1.14')
    await capture('profiles')
    await page.getByText('规则来源', { exact: true }).click()
    const hint = page.getByText(/验证 sing-box 原生规则集时/)
    await expect(hint).toBeVisible()
    await hint.scrollIntoViewIfNeeded()
    await capture('rule-library')

    await page.goto(`/delivery/conversions?config=${profile.id}`)
    await expect(page.getByLabel('配置名称')).toHaveValue(name)
    await page.getByRole('button', { name: '发布', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '发布配置' })
    await expect(dialog.getByLabel(/同时发布 sing-box 1.14/)).toBeVisible()
    await expect(dialog.locator('ins')).toHaveText('  - DOMAIN-SUFFIX,example.org,Fast')
    await capture('publish')
    await dialog.getByRole('button', { name: '取消' }).click()

    await page.goto('/delivery/subscriptions')
    await page.getByRole('row').filter({ hasText: name }).first().getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('button', { name: '查看详情', exact: true }).click()
    const diagnostic = page.getByRole('link', { name: /查看配置诊断/ })
    await expect(diagnostic).toBeVisible()
    await page.addStyleTag({ content: '.subscription-link-row .link-url { visibility: hidden; }' })
    await diagnostic.scrollIntoViewIfNeeded()
    await capture('subscription-details')
    await diagnostic.click()
    const platform = page.getByLabel('目标平台')
    await expect(platform).toContainText('sing-box 1.14')
    await expect(page.getByText('输入 2 · 授权 2 · 输出 2 · 跳过 0')).toBeVisible()
    await expect(page.locator('.template-preview pre')).toContainText('"rule_set"')
    await platform.click()
    expect(await page.getByRole('option').allTextContents()).toEqual([
      'Mihomo · 完整规则配置', 'sing-box 1.14 · 完整规则配置', 'Surge · 仅节点订阅',
      'Loon · 仅节点订阅', 'Quantumult X · 仅节点订阅', 'v2rayN · 仅节点订阅',
      'NekoBox · 仅节点订阅', 'Shadowrocket · 仅节点订阅', '通用 URI · 仅节点订阅',
    ])
    await page.keyboard.press('Escape')
    await page.getByText(/输出摘要/).scrollIntoViewIfNeeded()
    await capture('preview')

    await signIn(userCookie)
    await page.goto('/subscriptions')
    await expect(page.getByText('适用于 sing-box 1.14').first()).toBeVisible()
    await expect(page.getByText('仅节点订阅').first()).toBeVisible()
    await page.addStyleTag({ content: '.del-link-text, .ui3-platform-row code, .del-qr { visibility: hidden; }' })
    await page.getByText('适用于 sing-box 1.14').first().scrollIntoViewIfNeeded()
    await capture('user-formats')
    await context.close()
  }
} finally {
  await browser.close()
}
console.log('Authorized sing-box compile and kernel check, platform tiers, release and byte-for-byte rollback passed at 1440 and 390px')
