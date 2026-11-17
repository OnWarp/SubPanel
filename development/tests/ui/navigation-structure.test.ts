import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AppRouter } from '../../../src/app/router'
import { adminSections, navigationActive, userSidebar } from '../../../src/app/navigation'
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

describe('navigation ownership and route compatibility', () => {
  it('has the agreed administrator groups with a single user-management entry', () => {
    expect(adminSections.map(group => group.label)).toEqual(['', '资源', '订阅', '用户', '运营', '系统'])
    const sidebar = nav(render('/invites'), '主导航')
    expect(links(sidebar)).toEqual(adminSections.flatMap(group => group.items.map(item => item.to)))
    expect(sidebar).not.toContain('href="/invites"')
    expect(sidebar).not.toContain('href="/account"')
    expect(sidebar).toMatch(/<a(?=[^>]*href="\/users")(?=[^>]*aria-current="page")/)
  })
  it.each(['/users', '/invites', '/users/recycle-bin'])('exposes all three user subpages on %s', path => {
    const html = render(path)
    expect(links(nav(html, '用户管理子页'))).toEqual(['/users', '/invites', '/users/recycle-bin'])
    expect(nav(html, '用户管理子页')).toMatch(new RegExp(`<a(?=[^>]*href="${path}")(?=[^>]*aria-current="page")`))
    expect(html).toContain('用户管理')
  })
  it.each([
    ['/dashboard', '概览'], ['/catalog/nodes', '节点'], ['/catalog/sources', '来源'], ['/catalog/groups', '分组'],
    ['/delivery/subscriptions', '订阅'], ['/delivery/shares', '分享管理'], ['/plans', '权益计划'],
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
    expect(links(nav(html, '系统设置导航'))).toEqual(['/system/registration', '/system/mail', '/system/distribution', '/system/status'])
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
  it.each(['/home', '/subscriptions', '/nodes', '/me', '/apps', '/notices', '/kb', '/kb/article_1', '/tickets', '/tickets/tkt_1', '/account', '/entitlement', '/entitlements'])('keeps user route %s reachable with identical desktop and mobile navigation', path => {
    const html = render(path, 'user')
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
