import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/theme/ThemeProvider', () => ({
  useTheme: () => ({ mode: 'light', preference: 'system', setPreference: () => undefined }),
}))
import { SessionProvider } from '../../../src/app/session'
import { userSidebar } from '../../../src/app/navigation'
import { AccountPage } from '../../../src/features/accounts/AccountPage'
import { LoginPage } from '../../../src/features/accounts/LoginPage'
import { RegisterPage } from '../../../src/features/accounts/RegisterPage'
import { MySubscriptionsPage } from '../../../src/features/delivery/MySubscriptionsPage'
import { formatTrafficGb, homeTrafficLine } from '../../../src/features/user/home-traffic'
import { HomeDashboard, HomePage } from '../../../src/features/user/HomePage'
import { MinePage, MineSettingsPage } from '../../../src/features/user/MinePage'
import { UserNodesFilters, UserNodesFooter, UserNodesTable, type UserNode } from '../../../src/features/user/MyNodesPage'

function page(node: ReactNode) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SessionProvider, null, node)))
}

function sectionPage(section: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/me/${section}`] }, createElement(SessionProvider, null, createElement(Routes, null, createElement(Route, { path: '/me/:section', element: createElement(MineSettingsPage) })))))
}

const node: UserNode = {
  id: 'node_1',
  name: '香港 01',
  protocol: 'vmess',
  groups: [{ id: 'grp_1', name: '默认分组' }],
  subscriptions: [{ id: 'sub_1', name: '主订阅' }],
}

describe('user page presentation', () => {
  it('keeps the four user entries and does not restore a fifth dock item', () => {
    expect(userSidebar.map((item) => item.label)).toEqual(['首页', '订阅', '节点', '我的'])
    expect(userSidebar.map((item) => item.to)).toEqual(['/home', '/subscriptions', '/nodes', '/me'])
  })

  it('keeps the home status cards in order without quota or subscription actions', () => {
    const html = page(createElement(HomePage))
    expect(html).toContain('upd-home')
    expect(html).toContain('打开订阅')
    expect(html).toContain('正在加载订阅')
    expect(html).not.toContain('复制订阅链接')
    expect(html).not.toContain('重置订阅')
    expect(html).not.toContain('流量配额')
    expect(html).not.toContain('注销')

    const cards = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HomeDashboard, {
      reminder: null,
      subscriptionLabel: '有效',
      subscriptionTone: 'success',
      subscriptionSub: '2 个分组 · 8 个节点',
      groupValue: '2 / 8',
      groupSub: '可用分组 / 节点总数',
      onOpenNodes: () => undefined,
    })))
    const labels = [...cards.matchAll(/class="sp-stat-label"[^>]*>([^<]+)/g)].map((match) => match[1])
    expect(labels).toEqual(['订阅', '分组 / 节点'])
    expect(cards).toContain('2 个分组 · 8 个节点')
    expect(cards).not.toContain('流量')
    expect(cards).not.toContain('配额')
    expect(cards).not.toContain('已用')
  })

  it('shows used and remaining traffic in the existing status line only when the api sends both', () => {
    expect(formatTrafficGb(12.5)).toBe('12.5')
    expect(formatTrafficGb(0.1 + 0.2)).toBe('0.3')
    expect(homeTrafficLine(undefined)).toBeNull()
    expect(homeTrafficLine({})).toBeNull()
    expect(homeTrafficLine({ usedGb: 12.5 })).toBeNull()
    expect(homeTrafficLine({ usedGb: -1, remainingGb: 1 })).toBeNull()
    expect(homeTrafficLine({ usedGb: 0, remainingGb: 100 })).toBe('已用 0 GB · 剩余 100 GB')
    expect(homeTrafficLine({ usedGb: 12.5, remainingGb: 87.5 })).toBe('已用 12.5 GB · 剩余 87.5 GB')
    expect(homeTrafficLine({ usedGb: 3, remainingGb: null })).toBe('已用 3 GB · 剩余不限')

    const shown = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HomeDashboard, {
      reminder: null,
      subscriptionLabel: '有效',
      subscriptionTone: 'success',
      subscriptionSub: '标准计划',
      groupValue: '1 / 2',
      groupSub: '可用分组 / 节点总数',
      validity: '有效期剩余 12 天',
      trafficLine: homeTrafficLine({ usedGb: 42.5, remainingGb: 157.5 }),
      onOpenNodes: () => undefined,
    })))
    expect([...shown.matchAll(/class="sp-stat-label"[^>]*>([^<]+)/g)].map((match) => match[1])).toEqual(['订阅', '分组 / 节点'])
    expect(shown.match(/object-card/g)).toHaveLength(2)
    expect(shown).toContain('有效期剩余 12 天 · 已用 42.5 GB · 剩余 157.5 GB')
    expect(shown).not.toContain('流量配额')

    const hidden = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HomeDashboard, {
      reminder: null,
      subscriptionLabel: '有效',
      subscriptionTone: 'success',
      subscriptionSub: '标准计划',
      groupValue: '1 / 2',
      groupSub: '可用分组 / 节点总数',
      validity: '有效期剩余 12 天',
      trafficLine: homeTrafficLine({}),
      onOpenNodes: () => undefined,
    })))
    expect(hidden).toContain('有效期剩余 12 天')
    expect(hidden).not.toContain('已用')
    expect(hidden).not.toContain('剩余不限')
  })

  it('renders node filters, two-line rows, a status dot and the count footer', () => {
    const filters = renderToStaticMarkup(createElement(UserNodesFilters, {
      query: '香港',
      subscriptionId: 'sub_1',
      groupId: 'all',
      subscriptionOptions: [{ id: 'sub_1', name: '主订阅' }],
      groupOptions: [{ id: 'grp_1', name: '默认分组' }],
      onQuery: () => undefined,
      onSubscription: () => undefined,
      onGroup: () => undefined,
    }))
    expect(filters).toContain('aria-label="搜索节点名称"')
    expect(filters).toContain('value="香港"')
    expect(filters).toContain('aria-label="按订阅筛选"')
    expect(filters).toContain('aria-label="按分组筛选"')
    expect(filters).toContain('主订阅')
    expect(filters).toContain('全部')
    expect(filters).not.toContain('sp-segmented')
    expect(filters).not.toContain('sp-chip')

    const table = renderToStaticMarkup(createElement(UserNodesTable, { nodes: [node] }))
    expect(table).toContain('upd-twoline')
    expect(table).toContain('香港 01')
    expect(table).toContain('node_1')
    expect(table).toContain('vmess')
    expect(table).toContain('upd-status-ok')
    expect(table).toContain('可用')
    expect(table).toContain('默认分组')
    expect(table).toContain('主订阅')
    expect(table).not.toContain('注销')
    expect(table).not.toContain('•••')

    const footer = renderToStaticMarkup(createElement(UserNodesFooter, { total: 21, page: 1, pageCount: 2, onPage: () => undefined }))
    expect(footer).toContain('共 21 个节点')
    expect(footer).toContain('1 / 2 页')
    expect(footer).toContain('aria-label="上一页"')
    expect(footer).toContain('disabled=""')
    expect(footer).toContain('下一页')
  })

  it('keeps every subscription action and the centered auth fields', () => {
    const subscriptions = page(createElement(MySubscriptionsPage))
    expect(subscriptions).toContain('我的订阅')
    expect(subscriptions).toContain('正在加载订阅')
    expect(subscriptions).not.toContain('查看我的权益')
    expect(subscriptions).not.toContain('aria-label="选择订阅"')
    const source = readFileSync(new URL('../../../src/features/delivery/MySubscriptionsPage.tsx', import.meta.url), 'utf8')
    for (const action of ['分享', 'CopyButton', '重置订阅链接', 'SubscriptionImports', '到期时间']) expect(source).toContain(action)
    expect(source).not.toContain('选择订阅')
    expect(source).not.toContain('订阅计划')
    expect(source).not.toContain('注销')

    const login = page(createElement(LoginPage))
    expect(login).toContain('upd-auth')
    expect(login).toContain('id="login-username"')
    expect(login).toContain('id="login-password"')
    expect(login).toContain('登录')
    expect(login).not.toContain('注销')

    const open = page(createElement(RegisterPage, { initialMode: 'open' }))
    expect(open).toContain('upd-auth')
    for (const id of ['register-username', 'register-email', 'register-code', 'register-invite-code', 'register-password', 'register-confirm-password']) expect(open).toContain(`id="${id}"`)
    expect(open).toContain('发送验证码')
    expect(open).toContain('邀请码（选填）')

    const invite = page(createElement(RegisterPage, { initialMode: 'invite' }))
    expect(invite).toMatch(/<input[^>]*id="register-invite-code"[^>]*\brequired=""/)
    expect(invite).toContain('请向管理员获取邀请码')
    expect(invite).not.toContain('id="register-code"')
    expect(invite).not.toContain('发送验证码')

    const closed = page(createElement(RegisterPage, { initialMode: 'closed' }))
    expect(closed).toContain('当前未开放注册，请联系管理员')
    expect(closed).not.toContain('id="register-username"')
  })

  it('keeps account security copy and does not add self-service deletion', () => {
    const html = page(createElement(MinePage))
    expect(html).toContain('upd-mine')
    expect(html).toContain('个人中心')
    expect(html).toContain('正在加载订阅')
    expect(html).toContain('账户信息')
    expect(html).toContain('通知设置')
    expect(html).toContain('href="/me/security"')
    expect(html).toContain('href="/me/support"')
    expect(html).not.toContain('权益与计划')
    expect(html).not.toContain('注销')
    expect(html).not.toContain('删除账户')
    const notifications = sectionPage('notifications')
    expect(notifications).toContain('到期提醒')
    expect(notifications).toContain('仅在此浏览器生效，到期前 7 天在首页提醒')
    const security = sectionPage('security')
    expect(security).toContain('退出全部设备')
    expect(security).not.toContain('注销')
    expect(security).not.toContain('删除账户')
    const openSecurity = page(createElement(AccountPage, { embedded: true, initialPasswordOpen: true }))
    const passwordDialog = openSecurity.match(/<dialog\b[^>]*>[\s\S]*?<\/dialog>/)?.[0]
    expect(passwordDialog).toContain('<p>用户名不可修改，新密码须为 12 至 128 个字符</p>')
    const support = sectionPage('support')
    expect(support).toContain('aria-label="帮助与支持"')
    expect(support).toContain('href="/notices"')
    expect(support).toContain('href="/kb"')
    expect(support).toContain('href="/tickets"')
    expect(support).toContain('href="/apps"')
  })
})
