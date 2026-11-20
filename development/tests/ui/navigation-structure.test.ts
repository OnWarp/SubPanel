import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { OperationsActions, OperationsFooter } from '../../../src/features/admin/OperationsCard'
import { AppRouter } from '../../../src/app/router'
import { navigationActive, userSidebar } from '../../../src/app/navigation'
import { ToastProvider } from '../../../src/ui/Toast'

const session = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('../../../src/app/session', () => ({
  useSession: () => ({ initialized: true, loading: false, user: { id: 'usr_1', username: 'test', role: session.role }, logout: async () => undefined }),
}))
vi.mock('../../../src/theme/ThemeProvider', () => ({
  useTheme: () => ({ mode: 'light', preference: 'system', setPreference: () => undefined }),
}))
vi.mock('../../../src/ui/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: ReactNode }) => createElement('header', null, createElement('h1', null, title), actions),
}))
vi.mock('react-router-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, Navigate: ({ to }: { to: string }) => createElement('span', { 'data-redirect': to }) }
})
function render(path: string, role = 'admin') {
  session.role = role
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(ToastProvider, null, createElement(AppRouter))))
}
function nav(html: string, label: string) {
  return html.match(new RegExp(`<nav[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</nav>`))?.[1] ?? ''
}
function links(html: string) { return [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]) }
function mobileDock(html: string) {
  return html.match(/<nav[^>]*class="admin-mobile-dock"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? ''
}
const desktopLabels = ['概览', '节点管理', '订阅管理', '用户管理', '运营管理', '系统设置']
const mobileDockLabels = ['概览', '节点管理', '订阅管理', '用户管理']
const mobileDockRoutes = ['/dashboard', '/catalog/nodes', '/delivery/subscriptions', '/users']

describe('navigation ownership and route compatibility', () => {
  const desktopDomains = ['/dashboard', '/catalog/nodes', '/delivery/subscriptions', '/users', '/delivery/tickets', '/system/registration']
  it('renders six ungrouped desktop destinations and a single-row mobile dock', () => {
    const html = render('/invites')
    const sidebar = nav(html, '主导航')
    expect(links(sidebar)).toEqual(desktopDomains)
    expect(sidebar).not.toContain('nav-label')
    expect(sidebar.match(/aria-label="([^"]+)"/g)).toEqual(desktopLabels.map(label => `aria-label="${label}"`))
    const dock = mobileDock(html)
    expect(links(dock)).toEqual(mobileDockRoutes)
    expect([...dock.matchAll(/<span>([^<]*)<\/span>/g)].map(match => match[1])).toEqual(mobileDockLabels)
    expect(dock).not.toContain('运营管理')
    expect(dock).not.toContain('系统设置')
    expect(dock).not.toContain('更多')
    expect(dock).not.toContain('<button')
    expect(dock).toMatch(/<a(?=[^>]*href="\/users")(?=[^>]*aria-current="page")(?=[^>]*class="admin-mobile-dock-item active")/)
    expect(html).not.toContain('更多导航')
    const css = readFileSync(new URL('../../../src/styles/app.css', import.meta.url), 'utf8')
    expect(css).toContain('.dock, .dock-sheet, .dock-backdrop, .admin-mobile-dock { display: none; }')
    expect(css).toMatch(/\.admin-mobile-dock \{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/)
    expect(css).not.toMatch(/\.admin-mobile-dock \{[^}]*grid-template-columns:\s*repeat\(3/)
    expect(css).not.toMatch(/\.admin-mobile-dock-item span \{[^}]*text-overflow:\s*ellipsis/)
    expect(nav(render('/dashboard'), '节点管理导航')).toBe('')
  })

  it.each([
    ['节点管理导航', '/catalog/nodes', ['/catalog/nodes', '/catalog/sources', '/catalog/groups']],
    ['订阅管理导航', '/delivery/subscriptions', ['/delivery/subscriptions', '/delivery/shares', '/plans']],
    ['用户管理子页', '/users', ['/users', '/invites', '/users/recycle-bin']],
    ['运营管理导航', '/delivery/tickets', ['/delivery/tickets', '/operations/notices', '/kb/manage', '/catalog/apps']],
    ['系统设置导航', '/system/registration', ['/system/registration', '/system/mail', '/system/distribution', '/system/status', '/audit-logs']],
  ] as const)('keeps %s visible across its routes and highlights the current page and domain', (label, owner, routes) => {
    for (const path of routes) {
      const html = render(path)
      const sidebar = nav(html, '主导航')
      const tabs = nav(html, label)
      expect(links(tabs)).toEqual(routes)
      expect(sidebar.match(/aria-current="page"/g)).toHaveLength(1)
      expect(tabs.match(/aria-current="page"/g)).toHaveLength(1)
      expect(sidebar).toMatch(new RegExp(`<a(?=[^>]*href="${owner}")(?=[^>]*aria-current="page")`))
      expect(tabs).toMatch(new RegExp(`<a(?=[^>]*href="${path}")(?=[^>]*aria-current="page")`))
      const dock = mobileDock(html)
      if (mobileDockRoutes.includes(owner)) {
        expect(dock.match(/aria-current="page"/g)).toHaveLength(1)
        expect(dock).toMatch(new RegExp(`<a(?=[^>]*href="${owner}")(?=[^>]*aria-current="page")`))
      } else {
        expect(dock).not.toContain('aria-current')
      }
    }
  })

  it('highlights the ticket tab on a ticket detail page', () => {
    const html = render('/delivery/tickets/tkt_1')
    for (const label of ['主导航', '运营管理导航']) {
      expect(nav(html, label)).toMatch(/<a(?=[^>]*href="\/delivery\/tickets")(?=[^>]*aria-current="page")/)
    }
    expect(mobileDock(html)).not.toContain('aria-current')
    expect(mobileDock(html)).not.toContain('/delivery/tickets')
  })
  it('keeps user and settings tab queries on navigation', () => {
    expect(links(nav(render('/invites/?keep=1'), '用户管理子页'))).toEqual(
      ['/users?keep=1', '/invites?keep=1', '/users/recycle-bin?keep=1'],
    )
    expect(links(nav(render('/system/mail?keep=1'), '系统设置导航'))).toContain('/system/status?keep=1')
  })
  it.each([
    ['/dashboard', '概览'], ['/catalog/nodes', '节点'], ['/catalog/sources', '来源'], ['/catalog/groups', '分组'],
    ['/delivery/subscriptions', '订阅'], ['/delivery/shares', '分享管理'], ['/plans', '订阅计划'],
    ['/delivery/tickets', '工单'], ['/delivery/tickets/tkt_1', '工单'], ['/kb/manage', '知识库'],
    ['/catalog/apps', '客户端下载'], ['/operations/notices', '公告'], ['/audit-logs', '审计日志'], ['/account', '账户安全'],
  ])('keeps administrator route %s reachable', (path, marker) => {
    const html = render(path)
    expect(html).toContain('workspace-content')
    expect(html).toContain(marker)
  })
  it.each([
    ['registration', '正在加载注册设置'], ['mail', '邮件模板与群发'],
    ['distribution', '域名与平台展示'], ['status', '服务健康与定时任务'],
  ])('renders only the %s settings subpage on direct entry', (section, marker) => {
    const html = render(`/system/${section}`)
    expect(html).toContain(marker)
    expect(html).not.toContain('sys-app-downloads-title')
  })
  it.each([
    ['/system', '/system/registration'],
    ['/system?section=admin-mail&keep=1', '/system/mail?keep=1'],
    ['/system?tab=domain&subscription=sub_1', '/system/distribution?subscription=sub_1'],
    ['/system#share', '/system/distribution'],
    ['/system?section=app-downloads&keep=1', '/catalog/apps?keep=1'],
    ['/system/notices?keep=1', '/operations/notices?keep=1'],
    ['/system/app-downloads', '/catalog/apps'],
    ['/system?section=notices', '/operations/notices'],
    ['/system/share?keep=1', '/system/distribution?keep=1'],
  ])('maps legacy location %s to %s and preserves other query parameters', (path, target) => {
    expect(render(path)).toContain(`data-redirect="${target}"`)
  })
  it('renders the overview heading and seven placeholders in one loading grid', () => {
    const html = render('/dashboard')
    expect(html).toContain('<header><h1>概览</h1></header>')
    const grid = html.match(/<section class="adm-stat-grid"[^>]*aria-busy="true"[^>]*>(.*?)<\/section>/)?.[1]
    expect(grid?.match(/class="sp-stat-card sp-stat-body"/g)).toHaveLength(7)
  })
  it.each([
    ['/plans', '订阅计划'],
    ['/delivery/tickets', '工单'],
    ['/operations/notices', '公告'],
    ['/kb/manage', '知识库管理'],
    ['/catalog/apps', '客户端下载'],
    ['/audit-logs', '审计日志'],
  ])('renders the shared section heading on %s', (path, title) => {
    expect(render(path)).toContain(`<div class="section-heading data-header"><div class="data-header-main"><h2>${title}</h2>`)
  })
  it('keeps the filter controls and total in the audit card', () => {
    const html = render('/audit-logs')
    for (const field of ['操作', '管理员 ID', '开始时间', '结束时间']) {
      expect(html).toContain(`<label>${field}<input`)
    }
    expect(html).toContain('共 0 条')
    expect(html).toContain('1 / 1 页')
  })
  it('renders the count and bounded previous and next controls', () => {
    const html = renderToStaticMarkup(createElement(OperationsFooter, {
      total: 41,
      pagination: { page: 3, pageCount: 3, onPageChange: vi.fn() },
    }))
    expect(html).toContain('共 41 条')
    expect(html).toContain('3 / 3 页')
    expect(html).toMatch(/aria-label="上一页"(?! disabled)/)
    expect(html).toContain('aria-label="下一页" disabled=""')
  })
  it('gives each row action popover its own labelled trigger', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(OperationsActions, { label: '管理甲' }, createElement('button', null, '编辑')),
      createElement(OperationsActions, { label: '管理乙' }, createElement('button', null, '删除')),
    ))
    const targets = [...html.matchAll(/popovertarget="([^"]+)"/gi)].map((match) => match[1])
    expect(new Set(targets).size).toBe(2)
    expect(html).toContain('aria-label="管理甲">•••')
    expect(html).toContain('aria-label="管理乙">•••')
    for (const target of targets) expect(html).toContain(`id="${target}" popover="auto"`)
  })
  it('places the download switch and item editor together', () => {
    const html = render('/catalog/apps')
    expect(html).toContain('sys-app-downloads-title')
    expect(html).toContain('添加 APP')
    expect(render('/operations/notices')).toContain('公告')
  })
  it('keeps security, appearance and logout in the administrator avatar menu', () => {
    const html = render('/users')
    const menu = nav(html, '管理员账号菜单')
    expect(menu).toContain('href="/account"')
    expect(menu).toContain('aria-label="外观"')
    expect(menu).toContain('退出登录')
    expect(html).toContain('跟随系统')
    expect(html).toContain('浅色')
    expect(html).toContain('深色')
  })
  it('keeps the administrator account menu reachable on narrow screens', () => {
    const html = render('/users')
    expect(html).toContain('class="topbar-account"')
    expect(html.match(/aria-label="管理员账号菜单"/g)?.length).toBe(2)
  })
  it('puts operations and system settings on the narrow account menu ahead of the existing items', () => {
    const html = render('/users')
    const menus = [...html.matchAll(/<nav[^>]*aria-label="管理员账号菜单"[^>]*>([\s\S]*?)<\/nav>/g)].map(match => match[1])
    expect(menus).toHaveLength(2)
    expect(menus[0]).not.toContain('运营管理')
    expect(menus[0]).not.toContain('系统设置')
    expect(menus[0]).toContain('href="/account"')
    const topbar = menus[1] ?? ''
    const labels = ['运营管理', '系统设置', '账户安全', '外观', '退出登录']
    let cursor = -1
    for (const label of labels) {
      const at = topbar.indexOf(label)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
    expect(topbar).toContain('href="/delivery/tickets"')
    expect(topbar).toContain('href="/system/registration"')
    expect(topbar).toContain('href="/account"')
    expect(topbar).toContain('退出登录')
  })
  it.each(['/home', '/subscriptions', '/nodes', '/me', '/apps', '/notices', '/kb', '/kb/article_1', '/tickets', '/tickets/tkt_1', '/account', '/entitlement', '/entitlements'])('keeps user route %s reachable with identical desktop and mobile navigation', path => {
    const html = render(path, 'user')
    if (path === '/entitlement' || path === '/entitlements') {
      expect(html).not.toContain('workspace-content')
      expect(readFileSync(new URL('../../../src/app/router.tsx', import.meta.url), 'utf8')).toContain(`path="${path}" element={user?.role === 'user' ? <Navigate to="/subscriptions" replace />`)
      return
    }
    expect(html).toContain('workspace-content')
    const expected = userSidebar.map(item => item.to)
    expect(links(nav(html, '主导航'))).toEqual(expected)
    expect(links(nav(html, '快捷导航'))).toEqual(expected)
    expect(userSidebar.map(item => item.label)).toEqual(['首页', '订阅', '节点', '我的'])
    if (!['/home', '/subscriptions', '/nodes'].includes(path)) {
      expect(nav(html, '主导航')).toMatch(/<a(?=[^>]*href="\/me")(?=[^>]*aria-current="page")/)
    }
  })
  it('places support links in Mine, downloads on subscriptions and the home CTA on subscriptions', () => {
    expect(links(nav(render('/me', 'user'), '帮助与支持'))).toEqual(['/notices', '/kb', '/tickets', '/apps'])
    const home = render('/home', 'user')
    expect(home).toContain('打开订阅')
    expect(home).not.toContain('复制订阅链接')
    expect(home).not.toContain('重置订阅')
    expect(render('/me', 'user')).not.toContain('重置订阅')
    expect(render('/subscriptions', 'user')).toContain('下载客户端')
  })
  it.each(['/users', '/invites', '/users/recycle-bin', '/system', '/system/distribution', '/catalog/apps', '/operations/notices', '/audit-logs', '/delivery/tickets/tkt_1'])('retains administrator protection on %s', path => {
    expect(render(path, 'user')).not.toContain('workspace-content')
  })
  it.each([
    ['/invites', '/users'], ['/users/recycle-bin', '/users'], ['/system/mail', '/system'],
    ['/delivery/tickets/tkt_1', '/delivery/tickets'], ['/kb/manage', '/kb/manage'],
    ['/kb/article_1', '/me'], ['/tickets/tkt_1', '/me'], ['/account', '/me'],
  ])('highlights %s under %s', (path, owner) => expect(navigationActive(path, owner)).toBe(true))
})
