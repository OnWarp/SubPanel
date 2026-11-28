import { expect, test, type Page } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } })

const adminPassword = 'correct horse battery staple'

async function loginAdmin(page: Page) {
  await page.goto('/')
  const setup = page.getByRole('heading', { name: '初始化管理员' })
  const loginForm = page.getByRole('button', { name: '登录', exact: true })
  await expect(setup.or(loginForm)).toBeVisible()
  if (await setup.isVisible()) {
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill(adminPassword)
    await page.getByLabel('初始化密钥').fill(process.env.BOOTSTRAP_SECRET!)
    await page.getByRole('button', { name: '创建管理员' }).click()
    await expect(page).toHaveURL(/\/login$/)
  }
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(adminPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('plan and redeem admin actions fit a phone width', async ({ page }) => {
  await loginAdmin(page)
  await page.goto('/delivery/templates')
  await expect(page).toHaveURL(/\/plans$/)
  await expect(page.getByRole('heading', { name: '套餐管理', exact: true })).toBeVisible()
  const create = page.getByRole('button', { name: '新建套餐', exact: true })
  await expect(create).toBeVisible()
  await fits(page)
  await create.click()
  const editor = page.getByRole('dialog', { name: '新建套餐' })
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('button', { name: '保存套餐' })).toBeVisible()
  await fits(page)
  await page.keyboard.press('Escape')

  await page.goto('/redeem-codes')
  await expect(page).toHaveURL(/\/delivery\/redemptions$/)
  await expect(page.getByRole('heading', { name: '兑换码', exact: true })).toBeVisible()
  const generate = page.getByRole('button', { name: '生成兑换码', exact: true })
  await expect(generate).toBeVisible()
  await fits(page)
  await generate.click()
  const dialog = page.getByRole('dialog', { name: '生成兑换码' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '生成兑换码' })).toBeVisible()
  await fits(page)
})
