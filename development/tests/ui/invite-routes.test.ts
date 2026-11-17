import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AppRouter } from '../../../src/app/router'
import { ToastProvider } from '../../../src/ui/Toast'

// PageHeader portals into browser DOM slots; render its title inline for SSR.
vi.mock('../../../src/ui/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
}))

vi.mock('../../../src/app/session', () => ({
  useSession: () => ({ initialized: true, loading: false, user: { id: 'usr_1', username: 'admin', role: 'admin' }, logout: async () => undefined }),
}))
vi.mock('../../../src/theme/ThemeProvider', () => ({
  useTheme: () => ({ mode: 'light', preference: 'system', setPreference: () => undefined }),
}))

function renderRoute(path: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(ToastProvider, null, createElement(AppRouter))))
}

describe('administrator user-management subpage routes', () => {
  it('renders users without invitation management and retains the email editor', () => {
    const html = renderRoute('/users')
    expect(html).toContain('正在加载用户')
    expect(html).toContain('编辑用户')
    expect(html).toContain('edit-user-email')
    expect(html).not.toContain('注册邀请码')
    expect(html).not.toContain('邀请用户名')
    expect(html).toContain('href="/users"')
    expect(html).toContain('href="/invites"')
  })
  it('renders the invite subpage at its legacy route with no user editor', () => {
    const html = renderRoute('/invites')
    expect(html).toContain('注册邀请码')
    expect(html).toContain('无需邮箱验证码')
    expect(html).toContain('正在加载邀请码')
    expect(html).not.toContain('edit-user-form')
    expect(html).not.toContain('邀请用户名')
    expect(html).toMatch(/<a(?=[^>]*href="\/invites")(?=[^>]*aria-current="page")[^>]*>/)
  })
})
