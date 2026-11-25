import { expect, test } from '@playwright/test'

test('fills the desktop workspace away from the selected navigation edge', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('correct horse battery staple')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  const workspace = page.locator('.workspace')
  const main = page.locator('.workspace-content')
  const topbar = page.locator('.admin-desktop-topbar')
  const routes = [
    { path: '/dashboard', name: 'dashboard', card: '.content-page[data-width="list"]', ready: page.getByRole('region', { name: '概览统计与待办' }) },
    { path: '/users', name: 'users', card: '.content-page[data-width="list"]', ready: page.getByRole('row', { name: /admin/i }) },
    { path: '/system/registration', name: 'settings', card: '.content-page[data-width="list"]', ready: page.getByRole('heading', { name: '邮箱域名白名单' }) },
  ]

  for (const layout of ['sidebar', 'topbar'] as const) {
    if (layout === 'topbar') {
      await page.locator('.sidebar .admin-account summary').click()
      await page.getByRole('button', { name: '顶部导航', exact: true }).click()
      await expect(topbar).toBeVisible()
    }

    for (const { path, name, card, ready } of routes) {
      await page.goto(path)
      const surface = main.locator(card)
      await expect(surface).toBeVisible()
      await expect(ready).toBeVisible()
      await expect(page.locator('.workspace-topbar')).toHaveCSS('border-bottom-width', '0px')

      const workspaceBox = (await workspace.boundingBox())!
      const contentBox = (await main.boundingBox())!
      const cardBox = (await surface.boundingBox())!
      expect(workspaceBox.x + workspaceBox.width).toBe(1440)
      expect(workspaceBox.y + workspaceBox.height).toBe(900)
      const dimensions = await main.evaluate(element => {
        const style = getComputedStyle(element)
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          paddingLeft: parseFloat(style.paddingLeft),
          paddingRight: parseFloat(style.paddingRight),
        }
      })
      expect(cardBox.x).toBeCloseTo(contentBox.x + dimensions.paddingLeft, 0)
      expect(cardBox.width).toBeCloseTo(dimensions.clientWidth - dimensions.paddingLeft - dimensions.paddingRight, 0)
      if (name === 'users') await expect(surface.getByRole('navigation', { name: '用户管理子页' })).toBeVisible()
      if (name === 'settings') await expect(surface.getByRole('navigation', { name: '系统设置导航' })).toBeVisible()
      expect(dimensions.scrollWidth).toBe(dimensions.clientWidth)

      if (layout === 'topbar') {
        const topbarBox = (await topbar.boundingBox())!
        expect(workspaceBox.x).toBe(0)
        expect(workspaceBox.y).toBeGreaterThan(topbarBox.y + topbarBox.height)
        await expect(topbar).toHaveCSS('border-bottom-width', '0px')
        expect(await topbar.evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBe(0)
        expect(await topbar.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      } else {
        const sidebarBox = (await page.locator('.sidebar').boundingBox())!
        expect(workspaceBox.y).toBe(0)
        expect(workspaceBox.x).toBeGreaterThan(sidebarBox.x + sidebarBox.width)
      }

      await page.screenshot({ path: testInfo.outputPath(`${layout}-${name}.png`) })
      await testInfo.attach(`${layout}-${name}`, {
        path: testInfo.outputPath(`${layout}-${name}.png`),
        contentType: 'image/png',
      })
    }

    await page.setViewportSize({ width: 1440, height: 240 })
    await expect(main).toHaveCSS('overflow-y', 'auto')
    await main.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => main.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  await topbar.locator('.admin-account summary').click()
  await page.getByRole('button', { name: '侧边栏', exact: true }).click()
  await expect(topbar).toBeHidden()

})
