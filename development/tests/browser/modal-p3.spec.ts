import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const screenshots = process.env.SUBPANEL_P3_SCREENSHOTS ?? 'development/screenshots/sub-modal-p3'

async function openAppEditor(page: Page, scrolled = false) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const fixtures: Record<string, unknown> = {
      '/api/bootstrap': { initialized: true, user: { id: 'fixture', username: 'fixture', role: 'admin', enabled: true } },
      '/api/admin/system/app-downloads': { enabled: true },
      '/api/admin/apps': { apps: [], schemaVersion: 1, revision: 1, updatedAt: null },
    }
    return route.fulfill({ status: path in fixtures ? 200 : 404, json: fixtures[path] ?? {} })
  })
  await page.goto('/catalog/apps')
  const trigger = page.getByRole('button', { name: '添加 APP' })
  if (scrolled) {
    await trigger.evaluate(button => {
      const workspace = button.closest('.workspace-content')!
      const spacer = document.createElement('div')
      spacer.style.height = '1500px'
      workspace.append(spacer)
      workspace.scrollTop = 240
      button.focus({ preventScroll: true })
      button.click()
    })
  } else {
    await trigger.click()
  }
  return { trigger, dialog: page.getByRole('dialog', { name: '添加 APP' }) }
}

type Viewport = { width: number; height: number; left?: number; top?: number }

async function expectGeometry(dialog: Locator, viewport: Viewport, mobile: boolean) {
  const { width, height, left = 0, top = 0 } = viewport
  await expect.poll(async () => {
    const bounds = await dialog.boundingBox()
    return bounds && {
      centeredX: Math.abs(bounds.x + bounds.width / 2 - left - width / 2) < 1,
      centeredY: Math.abs(bounds.y + bounds.height / 2 - top - height / 2) < 1,
      fits: bounds.height <= height * (mobile ? .9 : .88) + 1,
      width: Math.round(bounds.width),
    }
  }).toEqual({ centeredX: true, centeredY: true, fits: true, width: mobile ? width - 32 : 720 })
  const body = dialog.locator('.sp-dialog-body')
  expect(await body.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await expect(dialog.getByRole('button', { name: '保存 APP' })).toBeInViewport({ ratio: 1 })
}

function contrast(first: string, second: string) {
  const luminance = (color: string) => {
    const channels = color.match(/\d+/g)!.map(Number).map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  }
  const [dark, light] = [luminance(first), luminance(second)].sort((a, b) => a - b)
  return (light + .05) / (dark + .05)
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme, reducedMotion: 'reduce' })

    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      test(`${width}px form layout and theme tokens`, async ({ page }) => {
        const height = 844
        await page.setViewportSize({ width, height })
        if (width === 1024) {
          await page.addInitScript(() => {
            localStorage.setItem('subpanel:layout:admin:fixture', JSON.stringify({ pc: { navigation: 'topbar' } }))
          })
        }
        const { dialog } = await openAppEditor(page)
        if (width === 1024) await expect(page.locator('.admin-desktop-topbar')).toBeVisible()
        if (width === 1440) await expect(page.locator('.sidebar')).toBeVisible()
        const mobile = width <= 768
        await expectGeometry(dialog, { width, height }, mobile)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const panel = dialog.locator('.sp-dialog-panel')
        await expect(panel).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(25, 26, 27)')
        await expect(panel).toHaveCSS('animation-name', 'none')
        await expect(dialog).toHaveCSS('color', theme === 'light' ? 'rgb(29, 29, 31)' : 'rgb(247, 248, 248)')
        await expect(panel).toHaveCSS('border-radius', mobile ? '16px' : '12px')
        expect(await dialog.evaluate(el => getComputedStyle(el, '::backdrop').backgroundColor)).toBe('rgba(12, 12, 14, 0.4)')
        const nameField = dialog.getByLabel('名称', { exact: true })
        await expect(nameField).toHaveCSS('outline-color', theme === 'light' ? 'rgb(0, 113, 227)' : 'rgb(113, 112, 255)')
        await expect(nameField).toHaveCSS('outline-style', 'solid')
        const surface = await panel.evaluate(el => getComputedStyle(el).backgroundColor)
        expect(contrast(await dialog.evaluate(el => getComputedStyle(el).color), surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(await dialog.locator('.app-note').first().evaluate(el => getComputedStyle(el).color), surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(await nameField.evaluate(el => getComputedStyle(el).outlineColor), surface)).toBeGreaterThanOrEqual(3)
        const name = (await nameField.boundingBox())!
        const order = (await dialog.getByLabel('排序', { exact: true }).first().boundingBox())!
        if (mobile) {
          expect(order.y).toBeGreaterThanOrEqual(name.y + name.height)
          expect(name.height).toBeGreaterThanOrEqual(44)
        } else {
          expect(order.y).toBeCloseTo(name.y, 0)
          expect(order.x).toBeGreaterThan(name.x)
        }
        if ([320, 390, 1024, 1440].includes(width)) {
          await mkdir(screenshots, { recursive: true })
          await page.screenshot({ path: `${screenshots}/app-editor-${width}-${theme}.png` })
        }
      })
    }

    test('keyboard occlusion and panning preserve field, footer and background scroll', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      // Keep the layout viewport intact while delivering the visual viewport events a keyboard emits.
      await page.addInitScript(() => {
        Object.defineProperty(window, 'visualViewport', { value: new EventTarget() })
        Object.assign(window.visualViewport!, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 })
      })
      const { dialog, trigger } = await openAppEditor(page, true)
      const workspace = page.locator('.workspace-content')
      await expect.poll(() => workspace.evaluate(el => el.scrollTop)).toBe(240)
      const original = await dialog.boundingBox()
      const body = dialog.locator('.sp-dialog-body')
      const field = dialog.getByLabel('文档链接（可选）')
      await field.focus()
      await page.evaluate(() => {
        Object.assign(window.visualViewport!, { height: 280 })
        window.visualViewport!.dispatchEvent(new Event('resize'))
      })
      await expectGeometry(dialog, { width: 390, height: 280 }, true)
      await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
      await expect(field).toBeFocused()
      await expect(field).toBeInViewport({ ratio: 1 })
      const footer = dialog.locator('.sp-dialog-footer')
      const heading = dialog.locator('.sp-dialog-heading')
      const footerBefore = await footer.boundingBox()
      const headingBefore = await heading.boundingBox()
      await body.evaluate(el => el.scrollTo(0, 0))
      expect(await footer.boundingBox()).toEqual(footerBefore)
      expect(await heading.boundingBox()).toEqual(headingBefore)

      await page.evaluate(() => {
        Object.assign(window.visualViewport!, { offsetTop: 96 })
        window.visualViewport!.dispatchEvent(new Event('scroll'))
      })
      await expectGeometry(dialog, { width: 390, height: 280, top: 96 }, true)
      await expect(field).toBeInViewport({ ratio: 1 })
      await page.evaluate(() => {
        Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 })
        window.visualViewport!.dispatchEvent(new Event('resize'))
      })
      await expectGeometry(dialog, { width: 390, height: 844 }, true)
      expect(await dialog.boundingBox()).toEqual(original)
      await workspace.evaluate(el => { el.scrollTop = 400 })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect.poll(() => workspace.evaluate(el => el.scrollTop)).toBe(240)
      await expect(trigger).toBeFocused()
    })

    test('rotation and asymmetric safe areas preserve the draft', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      const { dialog } = await openAppEditor(page)
      const name = dialog.getByLabel('名称', { exact: true })
      await name.fill('移动端草稿')
      await dialog.getByRole('button', { name: '添加平台' }).click()
      await expect(dialog.getByLabel('下载链接')).toHaveCount(2)
      await page.setViewportSize({ width: 844, height: 390 })
      await expectGeometry(dialog, { width: 844, height: 390 }, true)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 10, right: 24, bottom: 20, left: 40 } })
      await expectGeometry(dialog, { width: 780, height: 360, left: 40, top: 10 }, true)
      const footer = dialog.locator('.sp-dialog-footer')
      await expect(footer).toHaveCSS('padding-left', '40px')
      await expect(footer).toHaveCSS('padding-right', '24px')
      await expect(footer).toHaveCSS('padding-bottom', '20px')
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: {} })
      await page.setViewportSize({ width: 390, height: 844 })
      await expectGeometry(dialog, { width: 390, height: 844 }, true)
      await expect(name).toHaveValue('移动端草稿')
      await expect(dialog.getByLabel('下载链接')).toHaveCount(2)
    })
  })
}
