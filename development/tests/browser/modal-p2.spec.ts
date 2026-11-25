import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const screenshots = 'development/screenshots/sub-modal-p2'
type Handler = (route: Route) => Promise<void>

async function mock(page: Page, handlers: Record<string, unknown | Handler>, role = 'admin') {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const user = { id: 'fixture', username: 'fixture', role, enabled: true }
    if (path === '/api/bootstrap') return route.fulfill({ json: { initialized: true, user } })
    const entry = handlers[path]
    if (typeof entry === 'function') return (entry as Handler)(route)
    return route.fulfill({ status: entry === undefined ? 404 : 200, json: entry ?? {} })
  })
}

async function verify(dialog: Locator, size: string, width: number, screenshot?: string) {
  await expect(dialog).toHaveAttribute('data-size', size)
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  const area = await dialog.boundingBox()
  expect(area!.x + area!.width / 2).toBeCloseTo(width / 2, 0)
  expect(area!.width).toBeLessThan(width)
  await expect(dialog.getByRole('heading', { level: 2 })).toBeInViewport()
  if (screenshot) {
    await mkdir(screenshots, { recursive: true })
    await dialog.page().screenshot({ path: `${screenshots}/${screenshot}-${width}.png` })
  }
}

for (const width of [1440, 1024, 390]) {
  test.describe(`${width}px P2 dialogs`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: width === 390, reducedMotion: 'reduce' })

    test('announcement validates, saves, edits and confirms deletion', async ({ page }) => {
      const notices: { id: number; title: string }[] = []
      await mock(page, {
        '/api/admin/notices': async (route: Route) => {
          if (route.request().method() === 'POST') notices.push({
            id: 1, publishedAt: '2026-01-01T00:00:00Z', ...route.request().postDataJSON(),
          })
          await route.fulfill({ json: { notices } })
        },
        '/api/admin/notices/1': async (route: Route) => {
          if (route.request().method() === 'DELETE') notices.pop()
          else Object.assign(notices[0], route.request().postDataJSON())
          await route.fulfill({ json: { notice: notices[0] ?? null } })
        },
      })
      await page.goto('/operations/notices')
      const trigger = page.getByRole('button', { name: '新建公告' })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '新建公告' })
      await verify(dialog, 'l', width, 'notice')
      await expect(dialog.getByLabel('标题')).toBeFocused()
      await dialog.getByRole('button', { name: '发布公告' }).click()
      await expect(dialog.getByRole('alert')).toHaveText('请填写标题和正文')
      await dialog.getByLabel('标题').fill('测试公告')
      await page.mouse.click(2, 2)
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await dialog.getByRole('button', { name: '继续编辑' }).click()
      await expect(dialog.getByLabel('标题')).toHaveValue('测试公告')
      await dialog.getByLabel('正文').fill('公告内容')
      await dialog.getByRole('button', { name: '发布公告' }).click()
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
      await page.getByRole('button', { name: '管理公告 测试公告' }).click()
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      const edit = page.getByRole('dialog', { name: '编辑公告' })
      await expect(edit.getByLabel('正文')).toHaveValue('公告内容')
      await edit.getByLabel('标题').fill('已修改的公告')
      await edit.getByRole('button', { name: '保存修改' }).click()
      await page.getByRole('button', { name: '管理公告 已修改的公告' }).click()
      await page.getByRole('button', { name: '删除', exact: true }).click()
      const confirmation = page.getByRole('dialog', { name: '删除公告' })
      await verify(confirmation, 's', width)
      await page.mouse.click(2, 2)
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: '删除公告' }).click()
      await expect(page.getByText('暂无公告')).toBeVisible()
    })

    test('group opens an L node picker within the M draft', async ({ page }) => {
      let created = false
      await mock(page, {
        '/api/admin/catalog': { nodes: [], groups: [], sources: [] },
        '/api/admin/subscriptions': { subscriptions: [] },
        '/api/admin/catalog/groups/preview': { matched: 0, disabled: 0, incompatible: 0, outputNodes: 0, affectedSubscriptions: 0, nodes: [] },
        '/api/admin/catalog/groups': async (route: Route) => {
          expect(route.request().postDataJSON()).toMatchObject({ name: '测试分组' })
          created = true
          await route.fulfill({ json: {} })
        },
      })
      await page.goto('/catalog/groups')
      const trigger = page.getByRole('button', { name: '添加分组', exact: true })
      await trigger.click()
      const editor = page.getByRole('dialog', { name: '添加分组' })
      await verify(editor, 'm', width)
      await editor.getByLabel('分组名称').fill('测试分组')
      await editor.getByRole('button', { name: '选择关联节点' }).click()
      const picker = page.getByRole('dialog', { name: '选择关联节点' })
      await verify(picker, 'l', width, 'group-nodes')
      await expect(page.locator('dialog:modal')).toHaveCount(1)
      await picker.getByRole('button', { name: '完成' }).click()
      await expect(editor.getByLabel('分组名称')).toHaveValue('测试分组')
      await editor.getByRole('button', { name: '保存分组' }).click()
      await expect(editor).toBeHidden()
      expect(created).toBe(true)
      await expect(trigger).toBeFocused()
    })

    test('invitation keeps its result in the original dialog', async ({ page }) => {
      const code = randomUUID()
      await mock(page, { '/api/admin/invitations': async (route: Route) => {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toMatchObject({ type: 'multi', maxUses: 3 })
          await route.fulfill({ json: { invitations: [{ id: 'fixture', code, link: `https://example.test/invite/${code}` }] } })
        } else await route.fulfill({ json: { invitations: [] } })
      } })
      await page.goto('/invites')
      const trigger = page.getByRole('button', { name: '创建邀请码' })
      await trigger.click()
      const form = page.getByRole('dialog', { name: '创建邀请码' })
      await verify(form, 'm', width, 'invitation')
      await form.getByLabel('可用次数').fill('3')
      await form.getByRole('button', { name: '生成邀请码' }).click()
      const result = page.getByRole('dialog', { name: '邀请码已生成' })
      await expect(result.getByText(code)).toBeVisible()
      await page.mouse.click(2, 2)
      await expect(result).toBeVisible()
      await result.getByRole('button', { name: '完成' }).click()
      await expect(trigger).toBeFocused()
    })

    test('app creates and edits using the platform fields', async ({ page }) => {
      let apps: Array<{ id: string; name: string }> = []
      await mock(page, {
        '/api/admin/system/app-downloads': { enabled: true },
        '/api/admin/apps': async (route: Route) => {
          if (route.request().method() === 'POST') {
            const body = route.request().postDataJSON()
            apps = [{ ...body, id: 'app', platforms: body.platforms.map((platform: object) => ({ sortOrder: 0, ...platform })) }]
          }
          await route.fulfill({ json: { apps, schemaVersion: 1, revision: 1, updatedAt: null } })
        },
        '/api/admin/apps/app': async (route: Route) => {
          expect(route.request().method()).toBe('PUT')
          Object.assign(apps[0], route.request().postDataJSON())
          await route.fulfill({ json: {} })
        },
      })
      await page.goto('/catalog/apps')
      await page.getByRole('button', { name: '添加 APP' }).click()
      const add = page.getByRole('dialog', { name: '添加 APP' })
      await verify(add, 'l', width, 'app')
      await add.getByLabel('名称', { exact: true }).fill('测试客户端')
      await add.getByLabel('下载链接', { exact: true }).fill('https://example.test/download')
      await add.getByRole('button', { name: '保存 APP' }).click()
      await expect(add).toBeHidden()
      await page.getByRole('button', { name: '管理 APP 测试客户端' }).click()
      await page.getByRole('button', { name: '编辑 测试客户端' }).click()
      const edit = page.getByRole('dialog', { name: '编辑 APP' })
      await expect(edit.getByLabel('下载链接', { exact: true })).toHaveValue('https://example.test/download')
      await edit.getByLabel('名称', { exact: true }).fill('测试客户端二')
      await edit.getByRole('button', { name: '保存修改' }).click()
      await expect(page.getByText('测试客户端二', { exact: true })).toBeVisible()
    })

    test('domain errors stay in the M dialog until the request succeeds', async ({ page }) => {
      let attempts = 0
      await mock(page, {
        '/api/admin/system/domains': { panel: [], subscription: [], primaryPanelDomainId: null, primarySubscriptionDomainId: null, restrictionEnabled: false },
        '/api/admin/system/subscription-platforms': { platforms: [] },
        '/api/admin/system/domains/panel': async (route: Route) => {
          expect(route.request().postDataJSON()).toEqual({ hostname: 'panel.example.test', note: '备注' })
          attempts++
          if (attempts === 1) await route.fulfill({ status: 400, json: { error: { message: '添加失败，请重试' } } })
          else await route.fulfill({ json: {} })
        },
      })
      await page.goto('/system/distribution')
      await page.getByRole('region', { name: '面板域名' }).getByRole('button', { name: '添加域名' }).click()
      const dialog = page.getByRole('dialog', { name: '添加域名' })
      await verify(dialog, 'm', width, 'domain')
      await dialog.getByLabel('域名', { exact: true }).fill('panel.example.test')
      await dialog.getByLabel('备注').fill('备注')
      const submit = dialog.getByRole('button', { name: '添加', exact: true })
      await submit.click()
      await expect(dialog.getByRole('alert')).toContainText('添加失败，请重试')
      await expect(dialog.getByLabel('备注')).toHaveValue('备注')
      await submit.click()
      await expect(dialog).toBeHidden()
      expect(attempts).toBe(2)
    })

    test('unified subscription imports a client, creates a scoped share and revokes all shares', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const shareToken = randomUUID()
      let revoked = false
      await mock(page, {
        '/api/user/subscription': {
          status: 'active', expiresAt: null, lastExpiredAt: null, permanent: true,
          subscriptionUrl: 'https://example.test/s/subscription-token',
          supportedFormats: ['mihomo'], importPlatforms: [{ platform: 'mihomo', displayName: 'Mihomo' }],
          shareEnabled: true, hasAvailableNodes: true, nodeCount: 1,
        },
        '/api/apps': { apps: [], downloadsEnabled: true },
        '/api/shares': async (route: Route) => {
          expect(route.request().method()).toBe('POST')
          expect(route.request().postDataJSON()).toMatchObject({ scope: { type: 'unified' }, remark: '分享测试' })
          await route.fulfill({ status: 201, json: {
            share: { id: 'share', scope: { type: 'unified' }, status: 'active' },
            token: shareToken,
            linkBaseUrl: 'https://example.test',
          } })
        },
        '/api/shares/revoke-all': async (route: Route) => {
          expect(route.request().method()).toBe('POST')
          revoked = true
          await route.fulfill({ status: 204 })
        },
      }, 'user')
      await page.goto('/subscriptions')
      await page.getByRole('button', { name: '导入客户端' }).click()
      const imports = page.getByRole('dialog', { name: '导入客户端' })
      await verify(imports, 'm', width, 'client-import')
      await expect(imports.getByRole('link', { name: 'Mihomo' })).toHaveAttribute('href', /^clash:/)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '分享', exact: true }).click()
      const share = page.getByRole('dialog', { name: '分享订阅' })
      await verify(share, 'm', width, 'share')
      await share.getByLabel('备注').fill('分享测试')
      await share.getByRole('button', { name: '创建', exact: true }).click()
      await share.getByRole('button', { name: '复制分享链接' }).click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`https://example.test/s/${shareToken}`)
      await page.keyboard.press('Escape')

      await page.getByText('更多', { exact: true }).click()
      await page.getByRole('button', { name: '撤销全部分享' }).click()
      const confirm = page.getByRole('dialog', { name: '撤销全部分享' })
      await verify(confirm, 's', width)
      await confirm.getByRole('button', { name: '撤销', exact: true }).click()
      await expect(confirm).toBeHidden()
      await expect(page.getByRole('status')).toHaveText('已撤销全部分享')
      expect(revoked).toBe(true)
    })

    test('knowledge base creates an article and reloads it for editing', async ({ page }) => {
      const category = { id: 1, name: '文档分类', sort: 0 }
      let article: Record<string, unknown> | undefined
      await mock(page, {
        '/api/admin/kb/categories': { categories: [category] },
        '/api/admin/kb/articles': async (route: Route) => {
          if (route.request().method() === 'POST') article = {
            id: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...route.request().postDataJSON(),
          }
          await route.fulfill({ json: { articles: article ? [article] : [], total: article ? 1 : 0 } })
        },
        '/api/admin/kb/articles/1': async (route: Route) => {
          if (route.request().method() === 'PUT') article = { ...article, ...route.request().postDataJSON() }
          await route.fulfill({ json: { article } })
        },
      })
      await page.goto('/kb/manage')
      await page.getByRole('button', { name: '新建文章' }).click()
      const create = page.getByRole('dialog', { name: '新建文章' })
      await verify(create, 'xl', width, 'knowledge-base')
      await create.getByLabel('标题').fill('测试文章')
      await create.getByLabel('正文（Markdown）').fill('# 示例')
      await create.getByRole('button', { name: '创建文章' }).click()
      await page.getByRole('button', { name: '测试文章', exact: true }).click()
      const edit = page.getByRole('dialog', { name: '编辑文章' })
      await expect(edit.getByLabel('正文（Markdown）')).toHaveValue('# 示例')
      await edit.getByLabel('标题').fill('更新后的文章')
      await edit.getByRole('button', { name: '保存修改' }).click()
      await expect(page.getByRole('button', { name: '更新后的文章', exact: true })).toBeVisible()
    })

    test('mail template saves and confirms restoring the default', async ({ page }) => {
      const template = { key: 'verification', subject: '邮件标题', body: '邮件正文' }
      let writes = 0
      await mock(page, {
        '/api/admin/mail-templates': { templates: [template] },
        '/api/admin/mail-broadcasts': { broadcasts: [] },
        '/api/admin/system/reminders': { reminder_days: 3 },
        '/api/admin/mail-templates/verification': async (route: Route) => {
          writes++
          if (route.request().method() === 'PUT') Object.assign(template, route.request().postDataJSON())
          else expect(route.request().method()).toBe('DELETE')
          await route.fulfill({ json: {} })
        },
      })
      await page.goto('/system/mail')
      const trigger = page.getByRole('button', { name: '编辑 verification' })
      await trigger.click()
      const editor = page.getByRole('dialog', { name: '编辑邮件模板 · verification' })
      await verify(editor, 'xl', width, 'mail-template')
      await editor.getByLabel('标题').fill('新邮件标题')
      await editor.getByRole('button', { name: '保存模板' }).click()
      await expect(editor).toBeHidden()
      expect(writes).toBe(1)
      await trigger.click()
      await editor.getByRole('button', { name: '恢复默认' }).click()
      const confirmation = page.getByRole('dialog', { name: '恢复默认模板' })
      await verify(confirmation, 's', width)
      await expect(page.locator('dialog:modal')).toHaveCount(1)
      await confirmation.getByRole('button', { name: '恢复默认' }).click()
      await expect(confirmation).toBeHidden()
      expect(writes).toBe(2)
    })

    test('account email moves to verification in the same M window', async ({ page }) => {
      const currentPassword = randomUUID()
      const nextPassword = randomUUID()
      const verificationCode = String(Math.floor(100_000 + Math.random() * 900_000))
      const user = { id: 'fixture', username: 'fixture', role: 'user', enabled: true, email: null }
      const profile = { user, emailBound: false, avatar: { type: 'none' }, session: null }
      await mock(page, {
        '/api/account/profile': profile,
        '/api/account/email/bind': {},
        '/api/account/email/bind/confirm': async (route: Route) => {
          expect(route.request().postDataJSON()).toMatchObject({ code: verificationCode })
          await route.fulfill({ json: {} })
        },
        '/api/account/password': {},
      }, 'user')
      await page.goto('/me/security')
      await page.getByRole('button', { name: '修改密码' }).click()
      const password = page.getByRole('dialog', { name: '修改密码' })
      await expect(password.getByText('用户名不可修改，新密码须为 12 至 128 个字符', { exact: true })).toBeVisible()
      await verify(password, 'm', width, 'account-password')
      await password.getByLabel('当前密码').fill(currentPassword)
      await password.getByLabel('新密码', { exact: true }).fill(nextPassword)
      await password.getByLabel('确认新密码').fill(randomUUID())
      await password.getByRole('button', { name: '更新密码' }).click()
      await expect(password.getByRole('alert')).toHaveText('两次输入的新密码不一致')
      await password.getByLabel('确认新密码').fill(nextPassword)
      await password.getByRole('button', { name: '更新密码' }).click()
      await expect(password).toBeHidden()
      await page.getByRole('button', { name: '绑定邮箱' }).click()
      const email = page.getByRole('dialog', { name: '绑定邮箱' })
      await verify(email, 'm', width)
      await email.getByLabel('邮箱', { exact: true }).fill('example@example.test')
      await email.getByRole('button', { name: '获取验证码' }).click()
      const code = email.getByLabel('邮箱验证码')
      await expect(code).toBeFocused()
      await expect(page.locator('dialog:modal')).toHaveCount(1)
      await code.fill(verificationCode)
      await email.getByRole('button', { name: '确认绑定' }).click()
      await expect(email).toBeHidden()
      await expect(page.getByText('邮箱已绑定')).toBeVisible()
    })

    test('ticket status uses M reopening and S closing', async ({ page }) => {
      const ticket = {
        id: 1, userId: 'fixture', username: 'fixture', title: '测试工单', level: 0,
        status: 'closed', createdAt: '2026-01-01', updatedAt: '2026-01-01',
      }
      await mock(page, {
        '/api/admin/tickets/1': { ticket, replies: [] },
        '/api/admin/tickets/1/reopen': { ticket: { ...ticket, status: 'open' } },
        '/api/admin/tickets/1/close': { ticket },
      })
      await page.goto('/delivery/tickets/1')
      await page.getByRole('button', { name: '重开工单' }).click()
      const reopen = page.getByRole('dialog', { name: '重开工单' })
      await verify(reopen, 'm', width, 'ticket-status')
      await reopen.getByRole('button', { name: '确认重开' }).click()
      await expect(reopen).toBeHidden()
      await page.getByRole('button', { name: '关闭工单' }).click()
      const close = page.getByRole('dialog', { name: '关闭工单' })
      await verify(close, 's', width)
      await close.getByRole('button', { name: '关闭工单' }).click()
      await expect(close).toBeHidden()
      await expect(page.getByRole('button', { name: '重开工单' })).toBeVisible()
    })

    test('entitlement template editor submits resources and duration from L', async ({ page }) => {
      const name = '测试权益模板'
      const group = { id: 'group', name: '测试分组' }
      const config = {
        groupIds: [group.id], nodeIds: [], duration: { value: 30, unit: 'day' },
        quotaBytes: null, resetPolicy: 'none', limits: { speedLimitMbps: 0 },
      }
      let created = false
      await mock(page, {
        '/api/admin/catalog': { sources: [], nodes: [], groups: [group] },
        '/api/admin/subscription-templates': async (route: Route) => {
          const template = {
            id: 'template', name, description: '', allowRedemption: false, status: 'enabled',
            revision: 1, ownerUserId: null, boundUserCount: 0, subscriptionCount: 0,
            currentVersion: { id: 'version', number: 1, config },
          }
          if (route.request().method() === 'POST') {
            expect(route.request().postDataJSON()).toEqual({ name, description: '', allowRedemption: false, config })
            created = true
            return route.fulfill({ status: 201, json: { template } })
          }
          await route.fulfill({ json: { templates: created ? [template] : [] } })
        },
      })
      await page.goto('/plans')
      await expect(page).toHaveURL(/\/delivery\/templates$/u)
      await page.getByRole('button', { name: '新建模板' }).click()
      const dialog = page.getByRole('dialog', { name: '新建权益模板' })
      await verify(dialog, 'l', width)
      await dialog.getByLabel('模板名称').fill(name)
      await dialog.getByLabel('期限', { exact: true }).fill('30')
      await dialog.getByLabel('单位', { exact: true }).click()
      await dialog.getByRole('option', { name: '天', exact: true }).click()
      const save = dialog.getByRole('button', { name: '保存模板' })
      await save.click()
      await expect(dialog.getByText('请选择节点或动态分组')).toBeVisible()
      expect(created).toBe(false)
      await dialog.getByRole('checkbox', { name: '使用分组 测试分组' }).check()
      await save.click()
      await expect(dialog).toBeHidden()
      const row = page.getByRole('row').filter({ hasText: name })
      await expect(row.locator('td[data-label="资源数"]')).toHaveText('1')
      await expect(row.locator('td[data-label="绑定用户数"]')).toHaveText('0')
      await expect(row.locator('td[data-label="默认时长"]')).toHaveText('30 天')
      await expect(row.getByText('已启用')).toBeVisible()
    })
  })
}
