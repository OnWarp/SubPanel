import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const adminPassword = 'correct horse battery staple'
const outDir = join(process.cwd(), 'development', 'screenshots', 'button-hover-mask')

async function loginAdmin(page: Page) {
  await page.goto('/')
  const setup = page.getByRole('heading', { name: '初始化管理员' })
  const loginForm = page.getByRole('button', { name: '登录', exact: true })
  await expect(setup.or(loginForm)).toBeVisible()
  if (await setup.isVisible()) {
    await page.getByLabel('管理员用户名').fill('Admin')
    await page.getByLabel('管理员密码').fill(adminPassword)
    await page.getByRole('button', { name: '创建管理员' }).click()
    await expect(page).toHaveURL(/\/login$/)
  }
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(adminPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

type Topmost = { tag: string; cls: string; bg: string; color: string; rect: { x: number; y: number; w: number; h: number } | null }

async function topmostAt(page: Page, x: number, y: number): Promise<Topmost> {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py) as HTMLElement | null
    if (!el) return { tag: 'none', cls: '', bg: '', color: '', rect: null }
    const style = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className : '',
      bg: style.backgroundColor,
      color: style.color,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    }
  }, [x, y])
}

function isOpaque(bg: string): boolean {
  const m = bg.match(/rgba?\(([^)]+)\)/)
  if (!m) return false
  const parts = m[1].split(',').map((s) => Number.parseFloat(s.trim()))
  if (parts.length === 4) return parts[3] > 0
  return true
}

test.describe('desktop hover audit', () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } })

  test('hover does not cover button text', async ({ page }) => {
    test.setTimeout(600_000)
    mkdirSync(outDir, { recursive: true })
    await loginAdmin(page)
    const routes = [
      '/dashboard', '/catalog/nodes', '/catalog/sources', '/catalog/groups',
      '/delivery/subscriptions', '/delivery/shares', '/plans', '/users',
      '/system/registration', '/system/distribution', '/audit-logs', '/tickets', '/kb/manage',
    ]
    const findings: Record<string, unknown>[] = []
    for (const route of routes) {
      await page.goto(route)
      await page.waitForTimeout(500)
      const buttons = page.locator('.button:visible, .icon-button:visible')
      const count = await buttons.count()
      let shots = 0
      for (let i = 0; i < Math.min(count, 8); i++) {
        const el = buttons.nth(i)
        const box = await el.boundingBox()
        if (!box || box.width < 4 || box.height < 4) continue
        const label = ((await el.textContent()) || '').trim().replace(/\s+/g, ' ').slice(0, 40)
          || (await el.getAttribute('aria-label')) || (await el.getAttribute('title')) || '(icon)'
        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        const beforeTop = await topmostAt(page, cx, cy)
        const beforeStyle = await el.evaluate((node) => {
          const s = getComputedStyle(node)
          const before = getComputedStyle(node, '::before')
          const after = getComputedStyle(node, '::after')
          return {
            bg: s.backgroundColor, color: s.color,
            beforeContent: before.content, beforeBg: before.backgroundColor,
            afterContent: after.content, afterBg: after.backgroundColor,
          }
        })
        await el.hover({ timeout: 5000 }).catch(() => undefined)
        await page.waitForTimeout(250)
        const duringTop = await topmostAt(page, cx, cy)
        const duringStyle = await el.evaluate((node) => {
          const s = getComputedStyle(node)
          const before = getComputedStyle(node, '::before')
          const after = getComputedStyle(node, '::after')
          return {
            bg: s.backgroundColor, color: s.color, hoverMatches: node.matches(':hover'),
            beforeContent: before.content, beforeBg: before.backgroundColor,
            afterContent: after.content, afterBg: after.backgroundColor,
          }
        })
        // A covering layer: topmost element during hover is neither the button
        // nor a descendant, has an opaque background, and overlaps the button.
        const topIsButton = duringTop.tag === 'BUTTON' || duringTop.tag === 'A'
        const overlaps = duringTop.rect !== null
          && duringTop.rect.x < box.x + box.width - 2 && duringTop.rect.x + duringTop.rect.w > box.x + 2
          && duringTop.rect.y < box.y + box.height - 2 && duringTop.rect.y + duringTop.rect.h > box.y + 2
        const covered = !topIsButton && isOpaque(duringTop.bg) && overlaps
        // Screenshot text buttons only (icon-only chevrons say nothing).
        const hasText = ((await el.textContent()) || '').trim().length >= 2
        if (hasText && shots < 2) {
          shots += 1
          const safe = `${route.replace(/\//g, '_')}_${i}`.replace(/^_+/, '')
          const shot = async (name: string) => {
            const fresh = await el.boundingBox()
            if (!fresh) return
            const vp = page.viewportSize() ?? { width: 1280, height: 800 }
            const clip = {
              x: Math.max(0, fresh.x - 10),
              y: Math.max(0, fresh.y - 10),
              width: Math.min(fresh.width + 20, vp.width - Math.max(0, fresh.x - 10)),
              height: Math.min(fresh.height + 20, vp.height - Math.max(0, fresh.y - 10)),
            }
            if (clip.width <= 0 || clip.height <= 0) return
            await page.screenshot({ path: join(outDir, `${safe}-${name}.png`), clip }).catch(() => undefined)
          }
          await page.mouse.move(5, 5)
          await page.waitForTimeout(200)
          await shot('before')
          await el.hover({ timeout: 5000 }).catch(() => undefined)
          await page.waitForTimeout(250)
          await shot('hover')
        }
        findings.push({
          route, index: i, label, cls: await el.getAttribute('class'),
          beforeTop, beforeStyle, duringTop, duringStyle, covered,
        })
        await page.mouse.move(5, 5)
        await page.waitForTimeout(120)
      }
      writeFileSync(join(outDir, 'desktop-audit.json'), JSON.stringify(findings, null, 2))
    }
    const covered = findings.filter((f) => f.covered)
    expect(covered, `buttons covered by a layer on hover: ${JSON.stringify(covered, null, 2)}`).toEqual([])
  })
})

test.describe('mobile tap residue', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } })

  test('tap on dock link leaves no sticky hover', async ({ page }) => {
    mkdirSync(outDir, { recursive: true })
    await loginAdmin(page)
    await page.goto('/dashboard')
    await page.waitForTimeout(600)
    const dock = page.getByRole('navigation', { name: '主导航', exact: true })
    const dockLink = dock.getByRole('link', { name: '节点管理', exact: true })
    await expect(dockLink).toBeVisible()
    await dockLink.tap()
    await expect(page).toHaveURL(/\/catalog\/nodes$/)
    await page.waitForTimeout(400)
    const afterTap = await dockLink.evaluate((node) => ({
      hoverMatches: node.matches(':hover'),
      bg: getComputedStyle(node).backgroundColor,
      activeMatches: node.matches(':active'),
    }))
    await dockLink.screenshot({ path: join(outDir, 'mobile-dock-after-tap.png') })
    await page.touchscreen.tap(195, 200)
    await page.waitForTimeout(400)
    const afterElsewhere = await dockLink.evaluate((node) => ({
      hoverMatches: node.matches(':hover'),
      bg: getComputedStyle(node).backgroundColor,
    }))
    await dockLink.screenshot({ path: join(outDir, 'mobile-dock-after-elsewhere.png') })
    writeFileSync(join(outDir, 'mobile-tap.json'), JSON.stringify({ afterTap, afterElsewhere }, null, 2))
    expect(afterTap.hoverMatches, 'dock link still :hover right after tap').toBe(false)
    expect(afterElsewhere.hoverMatches, 'dock link still :hover after tapping elsewhere').toBe(false)
  })
})

test.describe('touch tap on icon button', () => {
  // Desktop viewport but a touch device: the sidebar toggle is visible here
  // and tapping it does not navigate, so sticky :hover (if any) stays observable.
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } })

  test('tap on sidebar toggle leaves no sticky hover', async ({ page }) => {
    test.setTimeout(120_000)
    mkdirSync(outDir, { recursive: true })
    await loginAdmin(page)
    await page.goto('/dashboard')
    await page.waitForTimeout(600)
    const toggle = page.locator('.icon-button.sidebar-toggle').first()
    await expect(toggle).toBeVisible()
    const box = await toggle.boundingBox()
    expect(box).not.toBeNull()
    // NOTE: asserting on the *computed background*, not matches(':hover').
    // A probe proved that on touch, the hover background stays painted after
    // a tap (computed bg stays at the hover colour) while matches(':hover')
    // still returns false, so a :hover assertion is a false negative here.
    const beforeTap = await toggle.evaluate((node) => ({
      hoverMatches: node.matches(':hover'),
      bg: getComputedStyle(node).backgroundColor,
    }))
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.waitForTimeout(400)
    const afterTap = await toggle.evaluate((node) => ({
      hoverMatches: node.matches(':hover'),
      bg: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
    }))
    await toggle.screenshot({ path: join(outDir, 'touch-toggle-after-tap.png') })
    // Tap empty space, then check again.
    await page.touchscreen.tap(640, 400)
    await page.waitForTimeout(400)
    const afterElsewhere = await toggle.evaluate((node) => ({
      hoverMatches: node.matches(':hover'),
      bg: getComputedStyle(node).backgroundColor,
    }))
    await toggle.screenshot({ path: join(outDir, 'touch-toggle-after-elsewhere.png') })
    writeFileSync(join(outDir, 'touch-toggle-tap.json'), JSON.stringify({ beforeTap, afterTap, afterElsewhere }, null, 2))
    expect(afterTap.bg, 'sidebar toggle kept the hover background after tap').toBe(beforeTap.bg)
    expect(afterElsewhere.bg, 'sidebar toggle kept the hover background after tapping elsewhere').toBe(beforeTap.bg)
  })
})
