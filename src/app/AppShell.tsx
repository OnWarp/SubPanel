import { ChevronDown, ChevronsLeft, ChevronsRight, LayoutGrid, LogOut, Megaphone, Rss, ShieldCheck, SlidersHorizontal, UserRound } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAccountProfile } from '../features/accounts/profile'
import { PageFrame } from '../ui/PageFrame'
import { SectionTabs } from '../ui/SectionTabs'
import { ThemeMenu } from '../theme/ThemeMenu'
import { useSession } from './session'
import { MobileBarContext, useMobileBarPreference } from './mobile-bar'
import { useMobileViewport } from './layout'
import { MobileBarOptions } from './MobileBarOptions'
import { adminDomainForPath, adminDomains, adminMobileDock, userSidebar, navigationActive } from './navigation'
import { useAdminLayout, sidebarCollapsedKey, type AdminLayout } from './admin-layout'

const userDock = userSidebar
const adminLayoutOptions = [
  { value: 'sidebar', label: '侧边栏' },
  { value: 'topbar', label: '顶部导航' },
] as const

function AdminNavigation({ activeDomain, layout, collapsed }: {
  activeDomain: ReturnType<typeof adminDomainForPath>
  layout: AdminLayout
  collapsed?: boolean
}) {
  return (
    <nav className={layout === 'topbar' ? 'admin-top-navigation' : 'sidebar-nav admin-sidebar-nav'} aria-label="主导航">
      {adminDomains.map(domain => {
        const { to, label, shortLabel, icon: Icon } = domain
        const active = domain === activeDomain
        return (
          <Link key={to} to={to} title={collapsed ? label : undefined} className={active ? 'active' : undefined} aria-current={active ? (activeDomain?.section ? 'location' : 'page') : undefined}
            aria-label={layout === 'sidebar' ? label : undefined}>
            {layout === 'sidebar' ? <><Icon aria-hidden="true" size={18} /><span>{label}</span></> : shortLabel ?? label}
          </Link>
        )
      })}
    </nav>
  )
}

function UserCenter({ signOut }: { signOut: () => Promise<void> }) {
  const { user } = useSession()
  const { profile } = useAccountProfile()
  const [error, setError] = useState('')
  return <div className="user-center"><details onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}><summary title="用户中心">
    {profile ? <img src={profile.avatar.url} alt="" width={32} height={32} /> : <UserRound size={24} aria-hidden="true" />}
    <span>{profile?.user.email ?? user?.email ?? user?.username}</span><ChevronDown size={16} aria-hidden="true" />
    </summary><nav aria-label="账号菜单">
      <Link to="/me"><span className="account-menu-icon" aria-hidden="true"><UserRound size={16} /></span>个人中心</Link>
      <Link to="/subscriptions"><span className="account-menu-icon" aria-hidden="true"><Rss size={16} /></span>我的订阅</Link>
      <Link to="/account"><span className="account-menu-icon" aria-hidden="true"><ShieldCheck size={16} /></span>安全与通知设置</Link>
      <ThemeMenu id="user-account-theme" label="外观" />
      <button type="button" onClick={() => { signOut().catch(() => setError('退出登录失败，请重试')) }}><span className="account-menu-icon" aria-hidden="true"><LogOut size={16} /></span>退出登录</button>
    </nav>
    </details>{error ? <p role="alert">{error}</p> : null}</div>
}

function AdminAccount({ signOut, onError, placement, layout, onLayoutChange, showMobileBarOptions }: {
  signOut: () => Promise<void>
  onError: (message: string) => void
  placement: AdminLayout | 'mobile'
  layout?: AdminLayout
  onLayoutChange?: (layout: AdminLayout) => void
  showMobileBarOptions?: boolean
}) {
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
          <span className="admin-account-info"><strong>{user?.username}</strong></span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <nav aria-label="管理员账号菜单">
          {placement === 'mobile' ? (
            <>
              <Link to="/delivery/tickets"><span className="account-menu-icon" aria-hidden="true"><Megaphone size={16} /></span>运营管理</Link>
              <Link to="/system/registration"><span className="account-menu-icon" aria-hidden="true"><SlidersHorizontal size={16} /></span>系统设置</Link>
            </>
          ) : null}
          <Link to="/account"><span className="account-menu-icon" aria-hidden="true"><ShieldCheck size={16} /></span>账户安全</Link>
          {layout && onLayoutChange && (
            <div className="admin-layout-options" role="group" aria-label="布局">
              <span className="account-menu-label"><span className="account-menu-icon" aria-hidden="true"><LayoutGrid size={16} /></span>布局</span>
              <div className="account-menu-choices">
                {adminLayoutOptions.map(({ value, label }) => (
                  <button key={value} type="button" aria-pressed={layout === value} onClick={event => {
                    const details = event.currentTarget.closest('details')
                    if (details) {
                      details.open = false
                      if (layout === value) details.querySelector('summary')?.focus()
                    }
                    onLayoutChange(value)
                  }}>{label}</button>
                ))}
              </div>
            </div>
          )}
          {showMobileBarOptions && <MobileBarOptions />}
          <ThemeMenu id={placement === 'sidebar' ? 'admin-theme-menu' : placement === 'mobile' ? 'admin-theme-menu-topbar' : 'admin-theme-menu-desktop'} label="外观" />
          <button type="button" onClick={() => { signOut().catch(() => onError('退出登录失败，请重试')) }}><span className="account-menu-icon" aria-hidden="true"><LogOut size={16} /></span>退出登录</button>
        </nav>
      </details>
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const admin = useAdminLayout()
  const mobileBar = useMobileBarPreference(admin ? {
    style: admin.preferences.mobile.bar,
    changeStyle: admin.changeMobileBar,
  } : undefined)
  const isMobile = useMobileViewport()
  const shell = useRef<HTMLDivElement>(null)
  const restoreLayoutFocus = useRef(false)
  const adminLayout = admin?.preferences.pc.navigation ?? 'sidebar'
  useLayoutEffect(() => {
    if (!restoreLayoutFocus.current) return
    restoreLayoutFocus.current = false
    const summaries = shell.current?.querySelectorAll<HTMLElement>('.admin-account summary')
    if (summaries) Array.from(summaries).find(summary => summary.getClientRects().length > 0)?.focus({ preventScroll: true })
  }, [adminLayout])

  const changeAdminLayout = (next: AdminLayout) => {
    if (!admin || next === adminLayout) return
    restoreLayoutFocus.current = true
    admin.changeNavigation(next)
  }
  const [signOutError, setSignOutError] = useState('')
  const [userSidebarCollapsed, setUserSidebarCollapsed] = useState(() => {
    if (admin) return false
    try { return localStorage.getItem(sidebarCollapsedKey) === '1' } catch { return false }
  })
  const sidebarCollapsed = admin?.preferences.pc.sidebarCollapsed ?? userSidebarCollapsed
  const toggleSidebar = admin?.toggleSidebar ?? (() => {
    setUserSidebarCollapsed((current) => {
      const next = !current
      try { localStorage.setItem(sidebarCollapsedKey, next ? '1' : '0') } catch { /* storage unavailable */ }
      return next
    })
  })
  const isAdmin = user?.role === 'admin'
  const hasAdminTopbar = isAdmin && adminLayout === 'topbar'
  const adminDomain = isAdmin ? adminDomainForPath(location.pathname) : undefined
  const visibleUserSidebar = userSidebar

  const signOut = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  const mobileDock = isAdmin ? (
    <nav className="admin-mobile-dock" aria-label="主导航">
      {adminMobileDock.map((domain) => {
        const { to, label, icon: Icon } = domain
        const active = domain === adminDomain
        return (
          <Link
            key={to}
            to={to}
            className={active ? 'admin-mobile-dock-item active' : 'admin-mobile-dock-item'}
            aria-current={active ? (adminDomain?.section ? 'location' : 'page') : undefined}
            aria-label={label}
          >
            <Icon aria-hidden="true" size={23} />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  ) : (
    <nav className="dock nav-dock" aria-label="快捷导航">
      {userDock.map(({ to, label, icon: Icon }) => (
        <Link key={to} to={to} className={`dock-item nav-dock-item${navigationActive(location.pathname, to) ? ' active' : ''}`} aria-current={navigationActive(location.pathname, to) ? 'page' : undefined}>
          <Icon aria-hidden="true" size={23} /><span>{label}</span>
        </Link>
      ))}
    </nav>
  )

  return (
    <div ref={shell} data-mobile-bar={mobileBar.style} className={`app-layout${isAdmin ? ' admin-layout' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}${hasAdminTopbar ? ' admin-topbar-layout' : ''}`}>
      {!hasAdminTopbar && <aside className="sidebar">
        <div className="sidebar-brand">
          <img className="brand-mark" src="/logo.png" alt="" />
          <div><strong>SubPanel</strong></div>
        </div>
        {isAdmin ? (
          <AdminNavigation activeDomain={adminDomain} layout="sidebar" collapsed={sidebarCollapsed} />
        ) : (
          <nav className="sidebar-nav nav-sidebar" aria-label="主导航">
            {visibleUserSidebar.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} title={label} className={navigationActive(location.pathname, to) ? 'active' : undefined} aria-current={navigationActive(location.pathname, to) ? 'page' : undefined}>
                <Icon aria-hidden="true" size={17} /><span>{label}</span>
              </Link>
            ))}
          </nav>
        )}
        {isAdmin ? <AdminAccount placement="sidebar" layout={isMobile ? undefined : adminLayout} onLayoutChange={changeAdminLayout} signOut={signOut} onError={setSignOutError} /> : <UserCenter key={location.pathname} signOut={signOut} />}
      </aside>}
      {hasAdminTopbar && (
        <header className="admin-desktop-topbar">
          <div className="admin-topbar-brand"><img className="brand-mark" src="/logo.png" alt="" /><strong>SubPanel</strong></div>
          <AdminNavigation activeDomain={adminDomain} layout="topbar" />
          <AdminAccount placement="topbar" layout={isMobile ? undefined : adminLayout} onLayoutChange={changeAdminLayout} signOut={signOut} onError={setSignOutError} />
        </header>
      )}
      <MobileBarContext value={mobileBar}>
        <PageFrame
          path={location.pathname}
          leadingTools={!hasAdminTopbar && <button className="icon-button sidebar-toggle" type="button" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} onClick={toggleSidebar}>{sidebarCollapsed ? <ChevronsRight aria-hidden="true" size={16} /> : <ChevronsLeft aria-hidden="true" size={16} />}</button>}
          tools={!isAdmin && <ThemeMenu />}
          account={isAdmin && <div className="topbar-account"><AdminAccount placement="mobile" showMobileBarOptions={isMobile} signOut={signOut} onError={setSignOutError} /></div>}
          tabs={adminDomain?.section && <SectionTabs {...adminDomain.section} />}
        >
          {signOutError ? <p role="alert">{signOutError}</p> : null}
          {children}
        </PageFrame>
        {mobileDock}
      </MobileBarContext>
    </div>
  )
}
