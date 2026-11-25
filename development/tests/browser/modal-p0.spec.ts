import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const screenshots = 'development/screenshots/sub-modal-test-fix'

async function mockPage(page: Page, role: 'user' | 'admin', fixtures: Record<string, unknown>) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/bootstrap') {
      return route.fulfill({ json: { initialized: true, user: { id: 'fixture', username: 'fixture', role, enabled: true } } })
    }
    return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
  })
}

for (const width of [1440, 390]) {
  test.describe(`${width}px modal regression`, () => {
    test.use({ viewport: { width, height: 760 }, hasTouch: width === 390, reducedMotion: 'reduce' })

    test('ticket Dialog traps focus, scrolls its body and restores the trigger', async ({ page }) => {
      await mockPage(page, 'user', { '/api/tickets': { tickets: [] } })
      await page.goto('/tickets')
      const trigger = page.getByRole('button', { name: '新建工单', exact: true }).first()
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '新建工单' })
      const heading = dialog.getByRole('heading')
      const close = dialog.getByRole('button', { name: '关闭', exact: true })
      const submit = dialog.getByRole('button', { name: '提交工单' })
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      await expect(dialog.getByLabel('标题')).toBeFocused()
      await expect(dialog).toHaveCSS('width', `${Math.min(width - 32, 520)}px`)
      await expect(dialog.locator('.sp-dialog-panel')).toHaveCSS('border-radius', width === 390 ? '16px' : '12px')
      await expect(page.locator('.workspace-content')).toHaveCSS('overflow-y', 'hidden')
      await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden')
      expect(await trigger.evaluate(element => {
        element.focus()
        return element === document.activeElement
      })).toBe(false)

      await close.focus()
      await page.keyboard.press('Shift+Tab')
      await expect(submit).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await expect(close).toHaveCSS('outline-style', 'solid')

      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: `${screenshots}/ticket-dialog-${width}.png` })

      // The mobile dialog updates its geometry in the VisualViewport resize handler.
      const shortHeight = 335
      await page.setViewportSize({ width, height: shortHeight })
      if (width === 390) {
        await expect(dialog).toHaveCSS('--dialog-viewport-height', `${shortHeight}px`)
      }

      const body = dialog.locator('.sp-dialog-body')
      const footer = dialog.locator('.sp-dialog-footer')
      await expect(body).toHaveCSS('overflow-y', 'auto')
      await expect(heading).toBeInViewport({ ratio: 1 })
      await expect(footer).toBeInViewport({ ratio: 1 })
      const headingPosition = await heading.boundingBox()
      const footerPosition = await footer.boundingBox()
      const scrollDistance = await body.evaluate(element => {
        const before = element.scrollTop
        element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
        return element.scrollTop - before
      })
      expect(scrollDistance).toBeGreaterThan(0)
      expect(await heading.boundingBox()).toEqual(headingPosition)
      expect(await footer.boundingBox()).toEqual(footerPosition)
      await expect(submit).toBeInViewport()
      await page.screenshot({ path: `${screenshots}/ticket-dialog-scrolled-${width}.png` })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(page.locator('.workspace-content')).toHaveCSS('overflow-y', 'auto')

      await trigger.click()
      await page.mouse.click(3, 3)
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
      await trigger.click()
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(dialog).toBeHidden()
    })

    test('source Dialog scrolls and protects unsaved input', async ({ page }) => {
      await mockPage(page, 'admin', { '/api/admin/catalog': { sources: [], nodes: [], groups: [] } })
      await page.goto('/catalog/sources')
      const trigger = page.getByRole('button', { name: '添加来源' })
      await trigger.click()
      const drawer = page.getByRole('dialog', { name: '添加来源' })
      await expect(drawer).toHaveAttribute('data-size', 'l')
      await expect(drawer.getByLabel('来源名称')).toBeFocused()
      const box = await drawer.boundingBox()
      expect(box!.x + box!.width / 2).toBeCloseTo(width / 2, 0)
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: `${screenshots}/source-dialog-${width}.png` })
      await drawer.getByLabel('来源名称').fill('未保存来源')
      await page.mouse.click(3, 3)
      await expect(drawer).toBeVisible()

      await page.setViewportSize({ width, height: 310 })
      const body = drawer.locator('.sp-dialog-body')
      await body.hover()
      await page.mouse.wheel(0, 250)
      await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await page.keyboard.press('Escape')
      await drawer.getByRole('button', { name: '放弃更改' }).click()
      await expect(drawer).toBeHidden()
      await expect(trigger).toBeFocused()
      await trigger.click()
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(drawer).toBeHidden()
      await expect(trigger).toBeFocused()
    })

    test('redemption confirmation keeps its backdrop policy and focuses the safe action', async ({ page }) => {
      const batch = {
        id: 'fixture', name: '测试批次', status: 'active', templateName: '测试模板',
        templateVersion: 1, quantity: 3, usedCount: 0, remaining: 3, redeemDeadline: Date.UTC(2027, 0, 1),
      }
      await mockPage(page, 'admin', {
        '/api/admin/redemption-batches/fixture': { batch },
        '/api/admin/redemption-batches/fixture/codes': { items: [], total: 0 },
      })
      await page.goto('/delivery/redemptions?batch=fixture&view=codes')
      const trigger = page.getByRole('button', { name: '停用批次' })
      await trigger.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
      await expect(dialog).toHaveCSS('width', `${Math.min(width - 32, 400)}px`)
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: `${screenshots}/redemption-confirm-${width}.png` })
      await page.mouse.click(3, 3)
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
    })
  })
}

test('desktop user dialogs guard dirty content and one-time results', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 })
  const user = { id: 'member', username: 'member', role: 'user', enabled: true }
  await mockPage(page, 'admin', { '/api/admin/users': { users: [user], total: 1 } })
  const temporaryPassword = randomUUID()
  await page.route('**/api/admin/users/member/reset-password', route => route.fulfill({ json: { user, temporaryPassword } }))
  await page.goto('/users')
  const menu = page.getByLabel('member 的操作')
  await menu.click()
  await page.getByRole('menuitem', { name: '改邮箱' }).click()
  const edit = page.getByRole('dialog', { name: '编辑用户' })
  await edit.getByLabel('邮箱').fill('member@example.test')
  await page.mouse.click(3, 3)
  await expect(edit.getByRole('button', { name: '继续编辑' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(edit.getByRole('button', { name: '继续编辑' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(edit.getByLabel('邮箱')).toBeFocused()
  await edit.getByRole('button', { name: '取消' }).click()
  await edit.getByRole('button', { name: '放弃更改' }).click()
  await expect(edit).toBeHidden()
  await expect(menu).toBeFocused()

  await menu.click()
  await page.getByRole('menuitem', { name: '重置密码' }).click()
  const reset = page.getByRole('dialog', { name: '重置用户密码' })
  const input = randomUUID()
  await reset.getByLabel('新密码', { exact: true }).fill(input)
  await reset.getByLabel('确认新密码').fill(input)
  await reset.getByRole('button', { name: '确认重置' }).click()
  await expect(reset.getByLabel('临时密码', { exact: true })).toBeVisible()
  await page.mouse.click(3, 3)
  await expect(reset).toBeVisible()
  await reset.getByRole('button', { name: '完成' }).click()
  await expect(reset).toBeHidden()
  await expect(page.locator('input[aria-label="临时密码"]')).toHaveCount(0)
  await expect(menu).toBeFocused()
})
