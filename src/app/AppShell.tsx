import { ChevronDown, ChevronsLeft, ChevronsRight, UserRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAccountProfile } from '../features/accounts/profile'
import { SectionTabs } from '../ui/SectionTabs'
import { ThemeMenu } from '../theme/ThemeMenu'
import { useSession } from './session'
import { adminDomainForPath, adminDomains, userSidebar, navigationActive } from './navigation'

const userDock = userSidebar

function UserCenter({ signOut }: { signOut: () => Promise<void> }) {
  const { user } = useSession()
  const { profile } = useAccountProfile()
  const [error, setError] = useState('')
  return <div className="user-center"><details onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}><summary title="用户中心">
    {profile ? <img src={profile.avatar.url} alt="" width={32} height={32} /> : <UserRound size={24} aria-hidden="true" />}
    <span>{profile?.user.email ?? user?.email ?? user?.username}</span><ChevronDown size={16} aria-hidden="true" />
    </summary><nav aria-label="账号菜单"><Link to="/me">个人中心</Link><Link to="/entitlement">我的权益</Link><Link to="/account">安全与通知设置</Link><button type="button" onClick={() => { signOut().catch(() => setError('退出登录失败，请重试')) }}>退出登录</button></nav>
    </details>{error ? <p role="alert">{error}</p> : null}</div>
}

function AdminAccount({ signOut, onError }: { signOut: () => Promise<void>; onError: (message: string) => void }) {
  const { user } = useSession()
  const { profile } = useAccountProfile()
  const { pathname } = useLocation()
  const avatar = profile?.avatar.url
  return (
    <div className="user-center admin-account">
      <details key={pathname} onKeyDown={event => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
        }
      }}>
        <summary title="管理员账号菜单" aria-label={`${user?.username ?? ''}，管理员账号菜单`}>
          {avatar ? <img src={avatar} alt="" width={32} height={32} /> : <UserRound className="admin-avatar" size={32} aria-hidden="true" />}
          <span className="admin-account-info"><strong>{user?.username}</strong><small>管理员</small></span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <nav aria-label="管理员账号菜单">
          <Link to="/account">账户安全</Link>
          <ThemeMenu id="admin-theme-menu" label="外观" />
          <button type="button" onClick={() => { signOut().catch(() => onError('退出登录失败，请重试')) }}>退出登录</button>
        </nav>
      </details>
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [signOutError, setSignOutError] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('subpanel:sidebar-collapsed') === '1' } catch { return false }
  })
  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current
      try { localStorage.setItem('subpanel:sidebar-collapsed', next ? '1' : '0') } catch { /* storage unavailable */ }
      return next
    })
  }
  const isAdmin = user?.role === 'admin'
  const adminDomain = isAdmin ? adminDomainForPath(location.pathname) : undefined
  const visibleUserSidebar = userSidebar

  const signOut = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className={`app-layout${isAdmin ? ' admin-layout' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img className="brand-mark" src="/logo.png" alt="" />
          <div><strong>SubPanel</strong></div>
        </div>
        {isAdmin ? (
          <nav className="sidebar-nav admin-sidebar-nav" aria-label="主导航">
            {adminDomains.map(domain => {
              const { to, label, icon: Icon } = domain
              const active = domain === adminDomain
              return (
                <Link key={to} to={to} title={sidebarCollapsed ? label : undefined} aria-label={label} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
                  <Icon aria-hidden="true" size={18} /><span>{label}</span>
                </Link>
              )
            })}
          </nav>
        ) : (
          <nav className="sidebar-nav nav-sidebar" aria-label="主导航">
            {visibleUserSidebar.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} title={label} className={navigationActive(location.pathname, to) ? 'active' : undefined} aria-current={navigationActive(location.pathname, to) ? 'page' : undefined}>
                <Icon aria-hidden="true" size={17} /><span>{label}</span>
              </Link>
            ))}
          </nav>
        )}
        {isAdmin ? <AdminAccount signOut={signOut} onError={setSignOutError} /> : <UserCenter key={location.pathname} signOut={signOut} />}
      </aside>
      <div className="workspace">
        <header className="workspace-topbar">
          <button className="icon-button sidebar-toggle" type="button" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} onClick={toggleSidebar}>{sidebarCollapsed ? <ChevronsRight aria-hidden="true" size={16} /> : <ChevronsLeft aria-hidden="true" size={16} />}</button>
          <div id="page-title-slot" className="topbar-context" />
          {!isAdmin ? <ThemeMenu /> : null}
          <div id="page-actions-slot" className="topbar-page-actions" />
        </header>
        <main key={location.pathname} className="workspace-content">
          {signOutError ? <p role="alert">{signOutError}</p> : null}
          {adminDomain?.section && <SectionTabs {...adminDomain.section} />}
          {children}
        </main>
      </div>
      {isAdmin ? (
        <nav className="admin-mobile-dock" aria-label="主导航">
          {adminDomains.map((domain) => {
            const { to, label, icon: Icon } = domain
            const active = domain === adminDomain
            return (
              <Link
                key={to}
                to={to}
                className={active ? 'admin-mobile-dock-item active' : 'admin-mobile-dock-item'}
                aria-current={active ? 'page' : undefined}
                aria-label={label}
              >
                <Icon aria-hidden="true" size={18} />
                <span>{label}</span>
              </Link>
            )
          })}
        </nav>
      ) : (
        <nav className="dock nav-dock" aria-label="快捷导航">
          {userDock.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={`dock-item nav-dock-item${navigationActive(location.pathname, to) ? ' active' : ''}`} aria-current={navigationActive(location.pathname, to) ? 'page' : undefined}>
              <Icon aria-hidden="true" size={18} /><span>{label}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  )
}
