import { ChevronDown, ChevronsLeft, ChevronsRight, Ellipsis, LogOut, UserRound } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAccountProfile } from '../features/accounts/profile'
import { ThemeMenu } from '../theme/ThemeMenu'
import { MOBILE_MEDIA_QUERY } from './layout'
import { useSession } from './session'
import { adminSections, userSidebar, navigationActive, type NavItem } from './navigation'

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

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const [mobile, setMobile] = useState(false)
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
  const moreButton = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLElement>(null)
  const touchStart = useRef(0)
  const isAdmin = user?.role === 'admin'
  const visibleUserSidebar = userSidebar
  const adminItems = adminSections.flatMap((section) => section.items)
  const dockPaths = ['/dashboard', '/catalog/groups', '/users']
  const dockItems = dockPaths
    .map((path) => adminItems.find((item) => item.to === path))
    .filter((item): item is NavItem => Boolean(item))
    .map((item) => item)
  const sheetItems = adminItems

  useEffect(() => setSheetOpen(false), [location.pathname])

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const sync = () => setMobile(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!mobile) setSheetOpen(false)
  }, [mobile])

  useEffect(() => {
    if (!sheetOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [sheetOpen])

  useEffect(() => {
    if (!sheetOpen) return
    sheet.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSheetOpen(false)
        moreButton.current?.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [sheetOpen])

  const signOut = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  const startSwipe = (event: TouchEvent<HTMLElement>) => {
    touchStart.current = event.touches[0]?.clientY ?? 0
  }

  const finishSwipe = (event: TouchEvent<HTMLElement>) => {
    const end = event.changedTouches[0]?.clientY ?? touchStart.current
    if (end - touchStart.current > 56 && (sheet.current?.scrollTop ?? 0) <= 0) setSheetOpen(false)
  }

  return (
    <div className={`app-layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img className="brand-mark" src="/logo.png" alt="" />
          <div><strong>SubPanel</strong></div>
        </div>
        {isAdmin ? (
          <nav className="sidebar-nav" aria-label="主导航">
            {adminSections.map((section) => <section className="nav-section" key={section.label}>
              {section.label ? <p className="nav-label">{section.label}</p> : null}
              {section.items.map(({ to, label, icon: Icon }) => (
                <Link key={to} to={to} title={label} className={navigationActive(location.pathname, to) ? 'active' : undefined} aria-current={navigationActive(location.pathname, to) ? 'page' : undefined}>
                  <Icon aria-hidden="true" size={17} /><span>{label}</span>
                </Link>
              ))}
            </section>)}
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
        {isAdmin ? <div className="user-center" key={location.pathname}><details onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}><summary title="管理员账号菜单"><UserRound size={24} aria-hidden="true" /><span>{user?.username}</span><ChevronDown size={16} /></summary><nav aria-label="管理员账号菜单"><Link to="/account">账户安全</Link><ThemeMenu id="admin-theme-menu" label="外观" /><button type="button" onClick={() => { signOut().catch(() => setSignOutError('退出登录失败，请重试')) }}>退出登录</button></nav></details></div> : <UserCenter key={location.pathname} signOut={signOut} />}
      </aside>
      <div className="workspace">
        <header className="workspace-topbar">
          <button className="icon-button sidebar-toggle" type="button" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} onClick={toggleSidebar}>{sidebarCollapsed ? <ChevronsRight aria-hidden="true" size={16} /> : <ChevronsLeft aria-hidden="true" size={16} />}</button>
          <div id="page-title-slot" className="topbar-context" />
          {!isAdmin ? <ThemeMenu /> : null}
          <div id="page-actions-slot" className="topbar-page-actions" />
        </header>
        <main key={location.pathname} className="workspace-content">{signOutError ? <p role="alert">{signOutError}</p> : null}{children}</main>
      </div>
      {isAdmin ? (
        <nav className="dock" aria-label="快捷导航">
          {dockItems.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={`dock-item ${navigationActive(location.pathname, to) ? 'active' : ''}`} aria-current={navigationActive(location.pathname, to) ? 'page' : undefined}>
              <Icon aria-hidden="true" size={18} /><span>{label}</span>
            </Link>
          ))}
          <button ref={moreButton} className="dock-item" type="button" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
            <Ellipsis aria-hidden="true" size={18} /><span>更多</span>
          </button>
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
      {sheetOpen ? <>
        <button className="dock-backdrop" type="button" aria-label="关闭更多导航" onClick={() => setSheetOpen(false)} />
        <section
          ref={sheet}
          className="dock-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="更多导航"
          tabIndex={-1}
          onTouchStart={startSwipe}
          onTouchEnd={finishSwipe}
        >
          <span className="dock-sheet-handle" aria-hidden="true" />
          {sheetItems.length ? <nav className="dock-sheet-nav" aria-label="主导航">
            {adminSections.map(section => <section className="nav-section" key={section.label}>{section.label ? <p className="nav-label">{section.label}</p> : null}{section.items.map(({ to, label, icon: Icon }) => <Link key={to} to={to} className={navigationActive(location.pathname, to) ? 'active' : undefined}><Icon size={19} aria-hidden="true" /><span>{label}</span></Link>)}</section>)}
            <Link to="/account">账户安全</Link><ThemeMenu id="mobile-theme-menu" label="外观" />
          </nav> : null}
          <div className="dock-sheet-account">
            <UserRound aria-hidden="true" size={18} />
            <div><strong>{user?.username}</strong><span>{user?.role === 'admin' ? '管理员' : '用户'}</span></div>
            <button className="icon-button" type="button" aria-label="退出登录" title="退出登录" onClick={() => { signOut().catch(() => setSignOutError('退出登录失败，请重试')) }}><LogOut aria-hidden="true" size={17} /></button>
          </div>
        </section>
      </> : null}
    </div>
  )
}
