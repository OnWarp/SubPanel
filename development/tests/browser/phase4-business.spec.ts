import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'

const adminPassword = 'correct horse battery staple'
const memberPassword = 'phase4 member password'
const recyclePassword = 'phase4 recycle password'
const memberName = 'phase4-member'
const recycleName = 'phase4-recycle'
const templateName = 'Phase4 模板'
const nodeLine = (host: string, name: string) =>
  `ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@${host}:8388#${name}`
const outDir = '/data/tmp/sub-uiux2-phase4-grok'
const viewports = [1440, 1280, 1024, 768, 390] as const

type StepStatus = 'pass' | 'fail' | 'blocked' | 'known'
type StepResult = { id: string; name: string; status: StepStatus; detail: string }

function redact(value: string) {
  const locator = value.match(/^Locator: .+$/mu)?.[0] ?? value.match(/waiting for .+/u)?.[0] ?? ''
  const expected = value.match(/^Expected: .+$/mu)?.[0] ?? ''
  const at = value.match(/phase4-business\.spec\.ts:\d+:\d+/u)?.[0] ?? ''
  const summary = [value.split('\n')[0], locator, expected, at].filter(Boolean).join(' | ')
  return summary
    .replace(/\/s\/[A-Za-z0-9_-]+/gu, '/s/[redacted]')
    .replace(/\b[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){2}\b/gu, '[code]')
    .replace(/BOOTSTRAP_SECRET=\S+/gu, 'BOOTSTRAP_SECRET=[redacted]')
    .slice(0, 280)
}

test('real local API covers authorization, redemption, delivery and shell checks', async ({ page }, testInfo) => {
  test.setTimeout(900_000)
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(30_000)
  expect.configure({ timeout: 20_000 })
  await page.setViewportSize({ width: 1200, height: 680 })
  mkdirSync(`${outDir}/viewports`, { recursive: true })
  const results: StepResult[] = []
  const state: {
    memberCode: string
    recycleCode: string
    link: string
    rotated: string
    redemptionCode: string
    userId: string
    templateId: string
  } = { memberCode: '', recycleCode: '', link: '', rotated: '', redemptionCode: '', userId: '', templateId: '' }

  async function step(id: string, name: string, deps: string[], run: () => Promise<string | void>) {
    if (deps.some((dep) => results.find((item) => item.id === dep)?.status !== 'pass')) {
      results.push({ id, name, status: 'blocked', detail: '前置步骤未通过' })
      console.log(`${id} blocked`)
      return
    }
    try {
      const detail = (await run()) ?? ''
      if (detail.startsWith('known:')) {
        results.push({ id, name, status: 'known', detail: redact(detail.slice('known:'.length)) })
        console.log(`${id} known`)
        return
      }
      results.push({ id, name, status: 'pass', detail: redact(detail) })
      console.log(`${id} pass`)
    } catch (error) {
      const errorText = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '步骤失败'
      results.push({ id, name, status: 'fail', detail: redact(errorText) })
      console.log(`${id} fail`)
    }
  }

  try {
    await step('login', '管理员登录', [], async () => {
      await page.goto('/')
      const setup = page.getByRole('heading', { name: '初始化管理员' })
      const loginButton = page.getByRole('button', { name: '登录', exact: true })
      await expect(setup.or(loginButton)).toBeVisible()
      if (await setup.isVisible()) {
        if ((process.env.BOOTSTRAP_SECRET ?? '').length < 32) throw new Error('BOOTSTRAP_SECRET 未注入或长度不足')
        await page.getByLabel('管理员用户名').fill('Admin')
        await page.getByLabel('管理员密码').fill(adminPassword)
        await page.getByLabel('初始化密钥').fill(process.env.BOOTSTRAP_SECRET ?? '')
        await page.getByRole('button', { name: '创建管理员' }).click()
        await expect(page).toHaveURL(/\/login$/)
      }
      await page.goto('/login')
      await page.getByLabel('用户名', { exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(page.locator('#login-password')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: '显示密码' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeFocused()
      await page.getByLabel('用户名', { exact: true }).fill('admin')
      await page.getByLabel('密码', { exact: true }).fill(adminPassword)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(page).toHaveURL(/\/dashboard$/)
      await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
      return '登录后焦点顺序为用户名、密码、显示密码、登录'
    })

    await step('permissions-admin', '管理员可进入管理页', ['login'], async () => {
      await page.goto('/users')
      await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
      await page.goto('/delivery/templates')
      await expect(page.getByRole('heading', { name: '权益模板' })).toBeVisible()
      const registration = await page.evaluate(async () => {
        const response = await fetch('/api/admin/system/registration', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'invite' }),
        })
        return response.status
      })
      if (registration < 200 || registration >= 300) throw new Error(`注册模式保存失败 ${registration}`)
    })

    await step('distribution', '订阅分发设置可打开', ['login'], async () => {
      await page.goto('/system/distribution')
      await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()
      await expect(page.getByRole('navigation', { name: '系统设置导航' }).getByRole('link', { name: '订阅分发' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '分享开关' })).toBeVisible()
      await expect(page.getByText('分享功能开关控制普通用户的分享权限，管理员仍可分享。关闭期间所有分享链接暂停访问')).toBeVisible()
    })

    await step('import', '节点导入并预览', ['login'], async () => {
      await page.goto('/catalog/sources')
      await page.getByRole('button', { name: '添加来源' }).click()
      const drawer = page.getByRole('dialog', { name: '添加来源' })
      await drawer.getByLabel('来源名称').fill('Phase4 来源')
      await drawer.getByLabel('来源内容').fill(`${nodeLine('alpha.example.com', 'Alpha')}\n${nodeLine('beta.example.com', 'Beta')}`)
      await drawer.getByRole('button', { name: '预览' }).click()
      await expect(drawer.getByText('已解析 2 个节点')).toBeVisible()
      await drawer.getByRole('button', { name: '保存来源' }).click()
      await expect(drawer).toBeHidden()
      await expect(page.getByRole('row', { name: /Phase4 来源/ })).toBeVisible()
      await page.goto('/catalog/nodes')
      await expect(page.getByRole('row', { name: /Alpha/ })).toBeVisible()
      await expect(page.getByRole('row', { name: /Beta/ })).toBeVisible()
    })

    await step('template-create', '创建共享模板', ['import'], async () => {
      await page.goto('/delivery/templates')
      await page.getByRole('button', { name: '新建模板' }).click()
      const dialog = page.getByRole('dialog', { name: '新建权益模板' })
      await dialog.getByLabel('模板名称').fill(templateName)
      await dialog.getByLabel('期限').fill('7')
      await dialog.locator('#entitlement-unit').click()
      await dialog.getByRole('option', { name: '天', exact: true }).click()
      await dialog.getByRole('checkbox', { name: '开放兑换码发放' }).check()
      await dialog.getByText('指定节点快照').click()
      await selectSnapshotNode(dialog, 'Alpha')
      await dialog.getByRole('button', { name: '保存模板' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByRole('row', { name: new RegExp(templateName) })).toBeVisible()
    })

    await step('invite', '生成邀请码并注册用户', ['permissions-admin'], async () => {
      state.memberCode = await createInvite(page)
      state.recycleCode = await createInvite(page)
      await logout(page)
      await register(page, memberName, 'phase4-member@example.com', memberPassword, state.memberCode)
      await expect(page).toHaveURL(/\/home$/)
      await logout(page)
      await register(page, recycleName, 'phase4-recycle@example.com', recyclePassword, state.recycleCode)
      await expect(page).toHaveURL(/\/home$/)
      await logout(page)
      await login(page, 'admin', adminPassword)
      await expect(page).toHaveURL(/\/dashboard$/)
      const listed = await readJson(page, `/api/admin/users?q=${memberName}`)
      const user = (listed.users as { id: string; username: string }[]).find((item) => item.username === memberName)
      if (!user) throw new Error('注册用户未出现在管理列表')
      state.userId = user.id
    })

    await step('permissions-user', '普通用户看不到管理入口且管理接口拒绝', ['invite'], async () => {
      await logout(page)
      await login(page, memberName, memberPassword)
      await expect(page).toHaveURL(/\/home$/)
      await expect(page.getByRole('link', { name: '用户管理' })).toHaveCount(0)
      await expect(page.getByRole('link', { name: '订阅', exact: true })).toBeVisible()
      const denied = await page.evaluate(async () => {
        const response = await fetch('/api/admin/users', { credentials: 'same-origin' })
        return response.status
      })
      if (denied !== 401 && denied !== 403) throw new Error(`管理接口返回 ${denied}`)
      await page.goto('/users')
      await expect(page).not.toHaveURL(/\/users$/)
      await logout(page)
      await login(page, 'admin', adminPassword)
      return `管理接口返回 ${denied}`
    })

    await step('bind', '绑定模板并显示有效授权数', ['template-create', 'invite', 'permissions-user'], async () => {
      const templates = await readJson(page, '/api/admin/subscription-templates')
      const template = (templates.templates as { id: string; name: string; ownerUserId: string | null }[])
        .find((item) => item.name === templateName && !item.ownerUserId)
      if (!template) throw new Error('共享模板未出现在列表')
      state.templateId = template.id
      await openSubscription(page, memberName)
      await expect(page.getByText('暂无绑定模板')).toBeVisible()
      const before = await subscriptionSummary(page, state.userId)
      if (before.status !== 'none' || before.effectiveBindingCount !== 0 || before.lastExpiredAt !== null) {
        throw new Error(`绑定前摘要不是无授权 ${before.status}/${before.effectiveBindingCount}`)
      }
      await bindTemplate(page, templateName, '绑定模板')
      await expect(page.getByRole('row', { name: new RegExp(templateName) }).getByText('有效', { exact: true })).toBeVisible()
      const after = await subscriptionSummary(page, state.userId)
      if (after.status !== 'active' || after.effectiveBindingCount !== 1) {
        throw new Error(`绑定后有效授权数 ${after.effectiveBindingCount}，状态 ${after.status}`)
      }
      return '绑定前无授权且有效授权数为 0，绑定后为 1'
    })

    await step('preview', '节点预览只含已选节点', ['bind'], async () => {
      await page.getByRole('button', { name: '节点预览' }).click()
      const dialog = page.getByRole('dialog', { name: '节点预览' })
      await expect(dialog.getByRole('row', { name: /Alpha/ })).toBeVisible()
      await expect(dialog.getByRole('row', { name: /Beta/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })

    await step('copy', '复制统一订阅链接', ['bind'], async () => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.getByRole('button', { name: '复制统一订阅链接' }).click()
      state.link = await page.evaluate(() => navigator.clipboard.readText())
      if (!/\/s\/[A-Za-z0-9]{16}$/u.test(state.link)) throw new Error('新订阅链接不是 16 位无分隔符令牌')
      const downloaded = await fetchSubscription(page, state.link)
      if (downloaded.status !== 200 || !downloaded.hasAlpha || downloaded.hasBeta) throw new Error('绑定后的下发内容与所选节点不一致')
      return '新链接为 16 位且下发包含 Alpha'
    })

    await step('update', '更新绑定为长期有效并保留效果预览', ['bind'], async () => {
      const row = page.getByRole('row', { name: new RegExp(templateName) })
      await row.getByRole('button', { name: '更新绑定' }).click()
      const dialog = page.getByRole('dialog', { name: '更新绑定' })
      await expect(dialog.getByRole('button', { name: '续期' })).toHaveCount(0)
      await dialog.locator('#binding-expiry').click()
      await dialog.getByRole('option', { name: '永久', exact: true }).click()
      await dialog.getByRole('button', { name: '预览影响' }).click()
      await expect(dialog.getByLabel('授权影响')).toContainText('长期有效')
      await dialog.getByRole('button', { name: '确认更新' }).click()
      await expect(dialog).toBeHidden()
      await expect(row.getByText('长期有效')).toBeVisible()
      const summary = await subscriptionSummary(page, state.userId)
      if (!summary.permanent) throw new Error('更新后摘要未标记永久授权')
    })

    await step('pause-resume', '暂停并恢复授权', ['update'], async () => {
      await runRowAction(page, templateName, '暂停', '暂停授权')
      await expect(page.getByRole('row', { name: new RegExp(templateName) }).getByText('已暂停')).toBeVisible()
      const paused = await subscriptionSummary(page, state.userId)
      if (paused.effectiveBindingCount !== 0) throw new Error('暂停后有效授权数未归零')
      await runRowAction(page, templateName, '恢复', '恢复授权')
      await expect(page.getByRole('row', { name: new RegExp(templateName) }).getByText('有效', { exact: true })).toBeVisible()
      const resumed = await subscriptionSummary(page, state.userId)
      if (resumed.effectiveBindingCount !== 1) throw new Error('恢复后有效授权数不是 1')
    })

    await step('template-version', '模板改动立即作用于已有授权', ['pause-resume'], async () => {
      await page.goto('/delivery/templates')
      const row = page.getByRole('row', { name: new RegExp(`^${templateName}`) })
      await row.getByRole('button', { name: '更多操作' }).click()
      await page.getByRole('group', { name: '行操作' }).getByRole('button', { name: '编辑', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '编辑权益模板' })
      await dialog.getByText('指定节点快照').click()
      await selectSnapshotNode(dialog, 'Beta')
      await expect(dialog.getByText(/已绑定用户立即按最新配置交付/)).toBeVisible()
      await dialog.getByRole('button', { name: '保存模板' }).click()
      await expect(dialog).toBeHidden()
      await row.getByRole('button', { name: '更多操作' }).click()
      await page.getByRole('group', { name: '行操作' }).getByRole('button', { name: '版本历史', exact: true }).click()
      const history = page.getByRole('dialog', { name: /版本历史/ })
      await expect(history.getByText('已绑定用户读取最新版，这里只展示历史配置')).toBeVisible()
      await expect(history.getByText(/v2/)).toBeVisible()
      await page.keyboard.press('Escape')
      await openSubscription(page, memberName)
      await page.getByRole('button', { name: '节点预览' }).click()
      const preview = page.getByRole('dialog', { name: '节点预览' })
      await expect(preview.getByRole('row', { name: /Alpha/ })).toBeVisible()
      await expect(preview.getByRole('row', { name: /Beta/ })).toBeVisible()
      await page.keyboard.press('Escape')
      const downloaded = await fetchSubscription(page, state.link)
      if (downloaded.status !== 200 || !downloaded.hasAlpha || !downloaded.hasBeta) throw new Error('最新模板版本没有进入现有链接')
    })

    await step('exclusive', '专属模板创建后不自动绑定，再单独绑定', ['template-version'], async () => {
      await page.getByRole('link', { name: '新建专属模板' }).click()
      const dialog = page.getByRole('dialog', { name: '新建专属模板' })
      await expect(dialog.getByText('创建后回到订阅授权，需要再绑定才生效')).toBeVisible()
      await dialog.getByLabel('模板名称').fill(templateName)
      await dialog.getByText('指定节点快照').click()
      await selectSnapshotNode(dialog, 'Alpha')
      await dialog.getByRole('button', { name: '保存模板' }).click()
      await expect(page).toHaveURL(/tab=subscription/)
      await expect(page.getByRole('row', { name: /专属/ })).toHaveCount(0)
      await page.getByRole('button', { name: '绑定模板', exact: true }).click()
      const binding = page.getByRole('dialog', { name: '绑定模板' })
      await binding.locator('#binding-template').click()
      await expect(binding.getByRole('option', { name: /共享/ })).toBeVisible()
      await expect(binding.getByRole('option', { name: /专属/ })).toBeVisible()
      await binding.getByRole('option', { name: /专属/ }).click()
      await binding.getByRole('button', { name: '预览影响' }).click()
      await binding.getByRole('button', { name: '确认绑定' }).click()
      await expect(binding).toBeHidden()
      await expect(page.getByRole('row', { name: /专属/ })).toBeVisible()
      await expect(page.getByRole('row', { name: /共享/ })).toBeVisible()
      const summary = await subscriptionSummary(page, state.userId)
      if (summary.effectiveBindingCount !== 2) throw new Error(`两份绑定后有效授权数是 ${summary.effectiveBindingCount}`)
    })

    await step('batch-auth', '批量任务暂停共享授权后再恢复', ['exclusive'], async () => {
      await page.goto('/users')
      await page.getByRole('button', { name: '批量任务' }).click()
      const dialog = page.getByRole('dialog', { name: '订阅批量任务' })
      await dialog.getByLabel('用户编号').fill(state.userId)
      await dialog.getByLabel('授权模板编号').fill(state.templateId)
      await dialog.getByLabel('授权操作').click()
      await dialog.getByRole('option', { name: '暂停授权' }).click()
      await dialog.getByRole('button', { name: '预览授权' }).click()
      const confirm = page.getByRole('dialog', { name: '暂停授权' })
      await expect(confirm).toContainText('预计影响 1 个')
      await confirm.getByRole('button', { name: '确认并创建任务' }).click()
      await page.getByRole('button', { name: '执行任务' }).click()
      await expect(page.getByText(/已完成/)).toBeVisible()
      await page.keyboard.press('Escape')
      await openSubscription(page, memberName)
      await expect(page.getByRole('row', { name: /共享/ }).getByText('已暂停')).toBeVisible()
      await runRowAction(page, '共享', '恢复', '恢复授权')
      await expect(page.getByRole('row', { name: /共享/ }).getByText('有效', { exact: true })).toBeVisible()
    })

    await step('reset', '重置订阅链接后旧链接失效', ['copy', 'batch-auth'], async () => {
      await page.getByRole('button', { name: '订阅链接更多操作' }).click()
      await page.getByRole('group', { name: '行操作' }).getByRole('button', { name: '重置链接', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '重置订阅链接' })
      await dialog.getByRole('button', { name: '重置链接' }).click()
      await expect(dialog).toBeHidden()
      await page.getByRole('button', { name: '复制统一订阅链接' }).click()
      state.rotated = await page.evaluate(() => navigator.clipboard.readText())
      if (!/\/s\/[A-Za-z0-9]{16}$/u.test(state.rotated) || state.rotated === state.link) throw new Error('重置后的链接不是新的 16 位令牌')
      const oldLink = await fetchSubscription(page, state.link)
      const newLink = await fetchSubscription(page, state.rotated)
      if (oldLink.status !== 404 || newLink.status !== 200 || !newLink.hasBeta) throw new Error('重置后新旧链接的下发结果不符合预期')
    })

    await step('revoke-expire', '撤销授权后写入已过期区间', ['reset'], async () => {
      await runRowAction(page, '专属', '撤销', '撤销授权')
      await expect(page.getByRole('row', { name: /专属/ })).toHaveCount(0)
      // 专属绑定撤销后，剩下的同名授权不再带「共享」
      await runRowAction(page, templateName, '撤销', '撤销授权')
      await expect(page.getByRole('row', { name: new RegExp(templateName) })).toHaveCount(0)
      const cleared = await subscriptionSummary(page, state.userId)
      if (cleared.status !== 'none' || cleared.effectiveBindingCount !== 0 || cleared.lastExpiredAt !== null) {
        throw new Error(`撤销后摘要不是无授权 ${cleared.status}/${cleared.effectiveBindingCount}`)
      }
      // 更新弹窗把开始时间定为当前，早于开始的到期会被拒绝；已过期区间要显式带上更早的开始时间
      const listed = await readJson(page, `/api/admin/users/${state.userId}/template-bindings`) as { revision: number }
      const now = Date.now()
      const written = await page.evaluate(async ({ path, revision, startsAt, expiresAt }) => {
        const response = await fetch(path, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'assign',
            expectedRevision: revision,
            requestId: crypto.randomUUID(),
            startsAt,
            expiry: { type: 'absolute', expiresAt },
          }),
        })
        return response.status
      }, {
        path: `/api/admin/users/${state.userId}/template-bindings/${state.templateId}`,
        revision: listed.revision,
        startsAt: now - 10_000,
        expiresAt: now - 1_000,
      })
      if (written < 200 || written >= 300) throw new Error(`写入已过期授权失败 ${written}`)
      await page.reload()
      await expect(page.getByRole('heading', { name: '已绑定模板' })).toBeVisible()
      await expect(page.getByRole('row', { name: new RegExp(templateName) }).getByText('已过期')).toBeVisible()
      const summary = await subscriptionSummary(page, state.userId)
      if (summary.status !== 'expired' || summary.effectiveBindingCount !== 0 || !summary.lastExpiredAt) {
        throw new Error(`过期摘要不符合预期 ${summary.status}/${summary.effectiveBindingCount}`)
      }
      return '撤销后为无授权；写入已结束的起止时间后，状态为已过期并带最后过期时间'
    })

    await step('redemption', '生成兑换码并按兑换时刻计算时长', ['revoke-expire'], async () => {
      await page.goto('/delivery/redemptions')
      await page.getByRole('button', { name: '生成兑换码' }).click()
      const dialog = page.getByRole('dialog', { name: '生成兑换码' })
      await dialog.getByLabel('批次名称').fill('Phase4 兑换')
      await dialog.locator('#batch-template').click()
      await dialog.getByRole('option', { name: templateName, exact: true }).click()
      await expect(dialog.getByText(/从兑换时起算/)).toBeVisible()
      await dialog.getByLabel('可兑截止时间').fill('2027-12-31T23:59')
      await dialog.getByRole('button', { name: '生成', exact: true }).click()
      const issued = page.getByRole('dialog', { name: '兑换码已生成' })
      const alert = page.getByRole('dialog', { name: '生成兑换码' }).getByRole('alert')
      await expect(issued.locator('code').or(alert)).toBeVisible()
      if (await alert.isVisible()) {
        const message = (await alert.innerText()).replace(/\s+/g, ' ').slice(0, 80)
        throw new Error(`生成兑换码失败 ${message}`)
      }
      state.redemptionCode = (await issued.locator('code').innerText()).trim()
      if (!/^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){2}$/u.test(state.redemptionCode)) throw new Error('兑换码不是 4-4-4')
      await issued.getByRole('button', { name: '完成' }).click()
      await issued.getByRole('button', { name: '确认关闭' }).click()
      await expect(issued).toBeHidden()
      await logout(page)
      await login(page, memberName, memberPassword)
      await page.goto('/me/redemption')
      await page.getByLabel('兑换码').fill(state.redemptionCode)
      await page.getByRole('button', { name: '预览权益' }).click()
      await expect(page.getByText('7 天')).toBeVisible()
      const before = Date.now()
      await page.getByRole('button', { name: '确认兑换' }).click()
      await expect(page.getByText('兑换成功')).toBeVisible()
      await logout(page)
      await login(page, 'admin', adminPassword)
      const summary = await subscriptionSummary(page, state.userId)
      const expiry = Date.parse(summary.latestExpiresAt ?? '')
      const delta = expiry - before
      if (summary.status !== 'active' || summary.effectiveBindingCount < 1 || summary.permanent) {
        throw new Error('兑换后没有恢复有效授权')
      }
      if (!(delta > 6 * 86_400_000 && delta < 8 * 86_400_000)) throw new Error('兑换后的到期时间不是从兑换时刻起的 7 天')
      return '兑换时长从兑换时刻起算 7 天，没有叠在已过期的旧截止时间上'
    })

    await step('recycle', '批量移入回收站并恢复', ['invite', 'redemption'], async () => {
      await page.goto('/users')
      const row = page.getByRole('row', { name: new RegExp(recycleName) })
      await row.getByRole('checkbox', { name: `选择用户 ${recycleName}` }).check()
      await page.getByRole('button', { name: '删除用户' }).click()
      const confirm = page.getByRole('dialog', { name: '删除用户' })
      await expect(confirm).toContainText('回收站')
      await confirm.getByRole('button', { name: '删除用户' }).click()
      await expect(page.getByRole('row', { name: new RegExp(recycleName) })).toHaveCount(0)
      await page.goto('/users/recycle-bin')
      const trashed = page.getByRole('row', { name: new RegExp(recycleName) })
      await expect(trashed).toBeVisible()
      await trashed.getByLabel(`${recycleName} 的操作`).click()
      await trashed.getByRole('menuitem', { name: '恢复' }).click()
      await expect(page.getByRole('row', { name: new RegExp(recycleName) })).toHaveCount(0)
      await page.goto('/users')
      await expect(page.getByRole('row', { name: new RegExp(recycleName) })).toBeVisible()
    })

    await step('share-unknown', '未知分享令牌整页导航', ['login'], async () => {
      const response = await page.goto('/s/unknowntoken0001')
      const body = await page.locator('body').innerText()
      const status = response?.status() ?? 0
      if (status === 404 && body.includes('SUBSCRIPTION_NOT_FOUND')) {
        return 'known:Worker 对未知令牌返回 JSON 404，这是基底已知问题，本线不改分享错误处理'
      }
      throw new Error(`未知令牌页面状态 ${status}，与基底记录不一致`)
    })

    await step('shell', '五档视口、外壳、键盘、焦点、对比度、溢出和触控', ['login', 'redemption'], async () => {
      await page.goto('/dashboard')
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(page.locator('aside.sidebar .brand-mark')).toBeVisible()
      await expect(page.locator('aside.sidebar').getByText('SubPanel', { exact: true })).toBeVisible()
      const toggle = page.getByRole('button', { name: '收起侧栏' })
      await toggle.focus()
      const focusRing = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as HTMLElement)
        return style.outlineStyle !== 'none' || (style.boxShadow !== 'none' && style.boxShadow !== '')
      })
      if (!focusRing) throw new Error('侧栏开关聚焦时没有可见焦点')
      await toggle.click()
      await expect(page.locator('.app-layout')).toHaveClass(/sidebar-collapsed/)
      await expect(page.locator('aside.sidebar .brand-mark')).toBeVisible()
      await page.screenshot({ path: `${outDir}/viewports/shell-collapsed-1440.png` })
      await page.getByRole('button', { name: '展开侧栏' }).click()
      await page.locator('aside.sidebar .admin-account summary').click()
      await page.getByRole('group', { name: '布局' }).getByRole('button', { name: '顶部导航' }).click()
      await expect(page.locator('.admin-desktop-topbar .brand-mark')).toBeVisible()
      await expect(page.locator('aside.sidebar')).toHaveCount(0)
      await page.screenshot({ path: `${outDir}/viewports/shell-topbar-1440.png` })
      await page.locator('.admin-desktop-topbar .admin-account summary').click()
      await page.getByRole('group', { name: '布局' }).getByRole('button', { name: '侧边栏' }).click()
      await expect(page.locator('aside.sidebar')).toBeVisible()

      await openSubscription(page, memberName)
      await page.getByRole('button', { name: '绑定模板', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '绑定模板' })
      await expect(dialog).toBeVisible()
      const focusedInside = await dialog.evaluate((element) => element.contains(document.activeElement))
      if (!focusedInside) throw new Error('绑定弹窗打开后焦点不在弹窗内')
      await page.keyboard.press('Tab')
      const stillInside = await dialog.evaluate((element) => element.contains(document.activeElement))
      if (!stillInside) throw new Error('Tab 离开了绑定弹窗')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      const notes: string[] = []
      for (const width of viewports) {
        const height = width === 390 ? 844 : 900
        await page.setViewportSize({ width, height })
        await page.goto('/dashboard')
        await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
        const metrics = await page.evaluate((currentWidth) => {
          const overflow = document.documentElement.scrollWidth - window.innerWidth
          const dock = document.querySelector('.admin-mobile-dock')
          const selector = currentWidth < 768 ? '.admin-mobile-dock a, .admin-mobile-dock button' : 'a, button'
          const targets = Array.from(document.querySelectorAll(selector))
            .filter((element) => (element as HTMLElement).getClientRects().length > 0)
            .map((element) => {
              const box = element.getBoundingClientRect()
              return Math.min(box.width, box.height)
            })
          return {
            overflow,
            dock: Boolean(dock && getComputedStyle(dock).display !== 'none' && dock.getClientRects().length > 0),
            minTarget: targets.length ? Math.round(Math.min(...targets)) : 0,
          }
        }, width)
        if (metrics.overflow > 1) throw new Error(`${width}px 横向溢出 ${metrics.overflow}px`)
        if (width < 768 && !metrics.dock) throw new Error(`${width}px 没有移动底栏`)
        if (width >= 768 && metrics.dock) throw new Error(`${width}px 仍显示移动底栏`)
        if (width < 768 && metrics.minTarget < 24) throw new Error(`${width}px 触控目标只有 ${metrics.minTarget}px`)
        const contrast = await contrastOf(page, '.workspace-topbar, .admin-desktop-topbar, h1')
        if (contrast < 4.5) throw new Error(`${width}px 标题对比度 ${contrast.toFixed(2)}`)
        await page.screenshot({ path: `${outDir}/viewports/dashboard-${width}.png` })
        notes.push(`${width}px 溢出 0，对比度 ${contrast.toFixed(2)}，触控 ${metrics.minTarget || '桌面'}px`)
      }
      await page.setViewportSize({ width: 1440, height: 900 })
      return notes.join('；')
    })
  } finally {
    writeFileSync(`${outDir}/business-results.json`, `${JSON.stringify(results, null, 2)}\n`)
    await testInfo.attach('business-results', { path: `${outDir}/business-results.json`, contentType: 'application/json' })
  }

  const failed = results.filter((item) => item.status === 'fail' || item.status === 'blocked')
  expect(failed.map((item) => `${item.id}: ${item.detail}`)).toEqual([])
})

// 点选后原复选框会卸载并换成「移除节点」，check() 会一直等待原来的控件
async function selectSnapshotNode(scope: Locator, name: string) {
  await scope.getByRole('checkbox', { name: `选择节点 ${name}` }).evaluate((element: HTMLInputElement) => element.click())
  await expect(scope.getByRole('checkbox', { name: `移除节点 ${name}` })).toBeChecked()
}

async function contrastOf(page: Page, selector: string) {
  return page.evaluate((target) => {
    const element = document.querySelector(target) as HTMLElement | null
    if (!element) return 0
    const style = getComputedStyle(element)
    const parse = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (!match) return null
      const parts = match[1].split(',').map((item) => Number.parseFloat(item.trim()))
      if (parts.length < 3 || (parts.length >= 4 && parts[3] === 0)) return null
      return parts.slice(0, 3)
    }
    const channel = (value: number) => {
      const scaled = value / 255
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
    }
    const luminance = (rgb: number[]) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
    const foreground = parse(style.color)
    let node: HTMLElement | null = element
    let background: number[] | null = null
    while (node && !background) {
      const candidate = parse(getComputedStyle(node).backgroundColor)
      if (candidate) background = candidate
      node = node.parentElement
    }
    if (!foreground || !background) return 0
    const [bright, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
    return (bright + 0.05) / (dark + 0.05)
  }, selector)
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/(dashboard|home)$/)
}

async function logout(page: Page) {
  const summary = page.locator('.admin-account summary:visible, .user-center summary:visible').first()
  await summary.click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login$/)
}

async function createInvite(page: Page) {
  await page.goto('/invites')
  await page.getByRole('button', { name: '创建邀请码' }).click()
  const editor = page.getByRole('dialog', { name: '创建邀请码' })
  await editor.getByRole('button', { name: '生成邀请码' }).click()
  const created = page.getByRole('dialog', { name: '邀请码已生成' })
  const code = (await created.locator('.sys-invite-code').first().innerText()).trim()
  if (code.length < 8) throw new Error('邀请码没有生成')
  await created.getByRole('button', { name: '完成' }).click()
  await expect(created).toBeHidden()
  return code
}

async function register(page: Page, username: string, email: string, password: string, inviteCode: string) {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('邀请码', { exact: true }).fill(inviteCode)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '注册' }).click()
}

async function openSubscription(page: Page, username: string) {
  await page.goto('/users')
  const row = page.getByRole('row', { name: new RegExp(username) })
  await row.getByLabel(`${username} 的操作`).click()
  await row.getByRole('menuitem', { name: '订阅授权' }).click()
  await expect(page).toHaveURL(/tab=subscription/)
  await expect(page.getByRole('heading', { name: '已绑定模板' })).toBeVisible()
}

async function bindTemplate(page: Page, name: string, dialogName: string) {
  await page.getByRole('button', { name: '绑定模板', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: dialogName })
  await dialog.locator('#binding-template').click()
  await dialog.getByRole('option', { name, exact: true }).click()
  await dialog.getByRole('button', { name: '预览影响' }).click()
  await expect(dialog.getByLabel('授权影响')).toBeVisible()
  await dialog.getByRole('button', { name: '确认绑定' }).click()
  await expect(dialog).toBeHidden()
}

async function runRowAction(page: Page, rowName: string, action: string, confirm: string) {
  const row = page.getByRole('row', { name: new RegExp(rowName) })
  await row.getByRole('button', { name: /更多操作/ }).click()
  await page.getByRole('group', { name: '行操作' }).getByRole('button', { name: action, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: confirm })
  await dialog.getByRole('button', { name: confirm }).click()
  await expect(dialog).toBeHidden()
}

async function readJson(page: Page, path: string) {
  const result = await page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'same-origin' })
    if (!response.ok) return { ok: false as const, status: response.status }
    return { ok: true as const, status: response.status, body: await response.json() }
  }, path)
  if (!result.ok) throw new Error(`${path} 返回 ${result.status}`)
  return result.body
}

async function subscriptionSummary(page: Page, userId: string) {
  const body = await readJson(page, `/api/admin/users/${encodeURIComponent(userId)}/subscription/summary`) as {
    status?: string
    effectiveBindingCount?: number
    permanent?: boolean
    lastExpiredAt?: string | null
    latestExpiresAt?: string | null
  }
  return {
    status: body.status ?? '',
    effectiveBindingCount: body.effectiveBindingCount ?? -1,
    permanent: Boolean(body.permanent),
    lastExpiredAt: body.lastExpiredAt ?? null,
    latestExpiresAt: body.latestExpiresAt ?? null,
  }
}

async function fetchSubscription(page: Page, link: string) {
  let pathname = ''
  try { pathname = new URL(link).pathname } catch { throw new Error('订阅链接无法解析') }
  const response = await page.request.get(`${pathname}/mihomo`)
  const text = response.ok() ? await response.text() : ''
  return { status: response.status(), hasAlpha: text.includes('Alpha'), hasBeta: text.includes('Beta') }
}
