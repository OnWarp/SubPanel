import { expect, test } from '@playwright/test'

const entitlementPath = '/api/admin/subscription-templates'
const member = { id: 'usr_member', username: 'member', role: 'user', enabled: true }
const userPath = `/api/admin/users/${member.id}`
const resourceGroup = { id: 'private-group', name: '专属模板测试分组' }

test('创建专属权益模板后仍需单独绑定', async ({ page, baseURL }) => {
  const serverOrigin = new URL('/', baseURL).origin
  let privateTemplate: Record<string, unknown> | undefined
  const calls: { method: string; path: string; body: unknown }[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const body = request.postDataJSON()
    calls.push({ method, path, body })
    const json = (data: unknown, status = 200) => route.fulfill({ json: data, status })
    switch (path) {
      case '/api/bootstrap': return json({ initialized: true, user: { id: 'usr_1', username: 'admin', role: 'admin', enabled: true } })
      case userPath: return json({ user: member })
      case `${userPath}/template-bindings`: return json({ revision: 0, bindings: [] })
      case `${userPath}/subscription/summary`: return json({ expiresAt: null, permanent: false, nodes: [], subscriptionUrl: null, logs: [] })
      case entitlementPath: return json({ templates: privateTemplate ? [privateTemplate] : [], total: privateTemplate ? 1 : 0 })
      case `${userPath}/template-bindings/private-template`:
        privateTemplate = {
          id: 'private', name: body?.name, description: body?.description, allowRedemption: false,
          status: 'enabled', revision: 1, boundUserCount: 0, ownerUserId: member.id,
          currentVersion: { id: 'private-version', number: 1, config: body?.config },
        }
        return json({ template: privateTemplate }, 201)
      case '/api/admin/catalog': return json({ sources: [], nodes: [], groups: [resourceGroup] })
      default: return json({}, 404)
    }
  })
  const detail = `${serverOrigin}/users/${member.id}`
  await page.goto(detail)
  await page.getByRole('link', { name: '订阅授权', exact: true }).click()
  await expect(page.getByText('暂无绑定模板')).toBeVisible()
  await page.getByRole('link', { name: '新建专属模板' }).click()
  const dialog = page.getByRole('dialog', { name: '新建专属模板' })
  await expect(dialog).toHaveAttribute('data-size', 'l')
  const name = '专属权益'
  await dialog.getByLabel('模板名称').fill(name)
  await dialog.getByRole('checkbox', { name: `使用分组 ${resourceGroup.name}` }).check()
  await dialog.getByRole('button', { name: '保存模板' }).click()
  await expect(page).toHaveURL(`${detail}?tab=subscription`)
  await expect(dialog).toBeHidden()
  await expect(page.getByText('暂无绑定模板')).toBeVisible()
  await page.getByRole('button', { name: '绑定模板', exact: true }).click()
  const binding = page.getByRole('dialog', { name: '绑定模板' })
  await binding.getByLabel('模板', { exact: true }).click()
  await expect(binding.getByRole('option', { name, exact: true })).toBeVisible()

  expect(calls.filter(({ method }) => method !== 'GET')).toEqual([{
    method: 'POST', path: `${userPath}/template-bindings/private-template`,
    body: {
      name, description: '', allowRedemption: false,
      config: {
        groupIds: [resourceGroup.id], nodeIds: [], duration: { value: 1, unit: 'month' },
        quotaBytes: null, resetPolicy: 'none', limits: { speedLimitMbps: 0 },
      },
    },
  }])
})

test('retired conversion deep link redirects to entitlement templates', async ({ page }) => {
  await page.route('**/api/bootstrap', route => route.fulfill({
    json: { initialized: true, user: { id: 'usr_1', username: 'admin', role: 'admin', enabled: true } },
  }))
  await page.route('**/api/admin/subscription-templates**', route => route.fulfill({ json: { templates: [], total: 0 } }))
  await page.goto('/delivery/conversions')
  await expect(page).toHaveURL(/\/delivery\/templates$/)
})
