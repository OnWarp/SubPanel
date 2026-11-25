import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { UserSummary } from '../../../src/app/api'
import { UserManagementPage } from '../../../src/features/accounts/UserManagementPage'
import { UsersDirectory } from '../../../src/features/accounts/UsersPage'
import { ToastProvider } from '../../../src/ui/Toast'

vi.mock('../../../src/ui/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
}))

const sample: UserSummary[] = [
  { id: 'usr_1', username: 'alone', role: 'admin', enabled: true, email: null, subscriptionCount: 0 },
  { id: 'usr_2', username: 'wuyang', role: 'user', enabled: false, email: 'wuyang@example.com', subscriptionCount: 2 },
]

function directory(overrides: Partial<Parameters<typeof UsersDirectory>[0]> = {}) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsersDirectory, {
    phase: 'ready',
    loadError: '',
    onRetry: () => undefined,
    view: 'active',
    users: sample,
    total: sample.length,
    page: 1,
    pageCount: 1,
    statusFilter: 'all',
    query: '',
    selectedIds: new Set<string>(),
    mutating: false,
    onStatusFilter: () => undefined,
    onQuery: () => undefined,
    onPage: () => undefined,
    onToggle: () => undefined,
    onToggleAll: () => undefined,
    onRowAction: () => undefined,
    onBatch: () => undefined,
    ...overrides,
  })))
}

function menus(html: string) {
  return [...html.matchAll(/<details class="usr-menu"[\s\S]*?<\/details>/g)].map((match) => match[0])
}

function shell(path: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(ToastProvider, null, createElement(UserManagementPage) as ReactNode)))
}

describe('users directory', () => {
  it('renders the reference columns, identity lines, status and subscription counts', () => {
    const html = directory()
    expect(html).toContain('data-label="选择"')
    expect(html).toContain('>用户</th>')
    expect(html).toContain('>角色</th>')
    expect(html).toContain('>状态</th>')
    expect(html).toContain('>订阅</th>')
    expect(html).toContain('>操作</th>')
    expect(html).toContain('alone')
    expect(html).toContain('usr_1')
    expect(html).not.toContain('alone@')
    expect(html).toContain('href="/users/usr_2"')
    expect(html).toContain('wuyang')
    expect(html).toContain('wuyang@example.com')
    expect(html).toContain('管理员')
    expect(html).toContain('用户')
    expect(html).toContain('usr-status-success')
    expect(html).toContain('正常')
    expect(html).toContain('usr-status-muted')
    expect(html).toContain('已停用')
    expect(html).toContain('0 个')
    expect(html).toContain('2 个')
    expect(html).toContain('共 2 位用户')
    expect(html).toContain('1 / 1 页')
    expect(html).toMatch(/aria-label="上一页"[^>]*disabled=""/)
    expect(html).toMatch(/aria-label="下一页"[^>]*disabled=""/)
    expect(html).toContain('aria-label="搜索用户"')
    expect(html).not.toContain('批量操作')
  })

  it('shows each account status in the native status filter', () => {
    expect(directory()).toMatch(/aria-label="用户状态"[\s\S]*?<span class="sp-select-value">全部状态<\/span>/)
    expect(directory({ statusFilter: 'enabled' })).toMatch(/aria-label="用户状态"[\s\S]*?<span class="sp-select-value">正常<\/span>/)
    expect(directory({ statusFilter: 'disabled' })).toMatch(/aria-label="用户状态"[\s\S]*?<span class="sp-select-value">已停用<\/span>/)
  })

  it('keeps every active row action in the overflow menu', () => {
    const [admin, user] = menus(directory())
    expect(admin).toContain('aria-label="alone 的操作"')
    expect(admin).toContain('修改邮箱')
    expect(admin).toContain('停用账号')
    expect(admin).toContain('管理员不能在这里启用或停用')
    expect(admin).toContain('订阅授权')
    expect(admin).toContain('删除用户')
    expect(admin).not.toContain('重置密码')
    expect(admin).not.toContain('设为管理员')
    expect(user).toContain('aria-label="wuyang 的操作"')
    expect(user).toContain('修改邮箱')
    expect(user).toContain('重置密码')
    expect(user).toContain('设管理员')
    expect(user).toContain('启用账号')
    expect(user).toContain('订阅授权')
    expect(user).toContain('删除用户')
  })

  it('checks the selected row and reveals enable, disable and recycle batch actions', () => {
    const html = directory({ selectedIds: new Set(['usr_2']) })
    expect(html).toMatch(/aria-label="选择用户 wuyang"[^>]*checked=""/)
    expect(html).not.toMatch(/aria-label="选择用户 alone"[^>]*checked=""/)
    expect(html).toContain('aria-label="批量操作"')
    expect(html).toContain('已选择 1 项')
    expect(html).toContain('>启用用户<')
    expect(html).toContain('>停用用户<')
    expect(html).toContain('>删除用户<')
    expect(html).toContain('aria-label="选择全部用户"')
  })

  it('keeps restore and permanent delete on the recycle bin', () => {
    const html = directory({
      view: 'trash',
      users: [{ ...sample[1], deletedAt: '2026-11-01T00:00:00.000Z', subscriptionCount: 1 }],
      total: 1,
    })
    const [menu] = menus(html)
    expect(menu).toContain('恢复')
    expect(menu).toContain('永久删除')
    expect(html).toContain('已删除')
    expect(html).toContain('usr-status-danger')
    expect(html).toContain('1 个')
    expect(html).toContain('>删除时间</th>')
    expect(html).toContain('共 1 位用户')
    expect(html).not.toContain('选择用户')
  })
})

describe('user management shell', () => {
  it('puts the title and invite action around the users list in one section', () => {
    const html = shell('/users')
    expect(html).toContain('class="data-section"')
    expect(html).toContain('用户管理')
    expect(html).toContain('邀请用户')
    expect(html).toContain('正在加载用户')
    expect(html).toContain('全部状态')
    expect(html).toContain('编辑用户')
    expect(html).toContain('edit-user-email')
    expect(html).not.toContain('注册邀请码')
  })

  it('keeps invite management inside the same section', () => {
    const html = shell('/invites')
    expect(html).toContain('class="data-section"')
    expect(html).toContain('邀请用户')
    expect(html).toContain('注册邀请码')
    expect(html).toContain('无需邮箱验证码')
    expect(html).toContain('正在加载邀请码')
    expect(html).not.toContain('edit-user-form')
  })
})
