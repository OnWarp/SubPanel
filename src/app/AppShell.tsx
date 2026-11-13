import { Download, Ellipsis, FolderKanban, Gauge, Home, LogOut, Network, Rss, Send, Settings, Share2, ShieldCheck, UserRound, Users, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ThemeMenu } from '../theme/ThemeMenu'
import { MOBILE_MEDIA_QUERY } from './layout'
import { useSession } from './session'
import { useDownloadsEnabled } from '../features/apps/downloads-visibility'

type NavItem = { to: string; label: string; icon: LucideIcon }
type NavSection = { label: string; items: NavItem[] }

const adminSections: NavSection[] = [
  { label: '仪表盘', items: [
    { to: '/dashboard', label: '概览', icon: Gauge },
    { to: '/catalog/nodes', label: '节点', icon: Network },
    { to: '/catalog/sources', label: '来源', icon: Rss },
    { to: '/catalog/groups', label: '分组', icon: FolderKanban },
  ] },
  { label: '交付与权限', items: [
    { to: '/delivery/subscriptions', label: '订阅', icon: Send },
    { to: '/delivery/shares', label: '分享管理', icon: Share2 },
    { to: '/users', label: '用户与邀请', icon: Users },
    { to: '/catalog/apps', label: 'APP 管理', icon: Download },
  ] },
  { label: '系统管理', items: [{ to: '/account', label: '账户安全', icon: ShieldCheck }, { to: '/system', label: '系统管理', icon: Settings }] },
]

const userDock: NavItem[] = [
  { to: '/home', label: '首页', icon: Home },
  { to: '/nodes', label: '节点', icon: Network },
  { to: '/subscriptions', label: '订阅', icon: Rss },
]

const userSheetItems: NavItem[] = [
  { to: '/apps', label: 'APP 下载', icon: Download },
  { to: '/me', label: '我的', icon: UserRound },
]

const userSidebar: NavItem[] = [
  { to: '/home', label: '首页', icon: Home },
  { to: '/subscriptions', label: '订阅', icon: Rss },
  { to: '/nodes', label: '节点', icon: Network },
  { to: '/apps', label: 'APP 下载', icon: Download },
  { to: '/me', label: '我的', icon: UserRound },
]

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [mobile, setMobile] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLElement>(null)
  const touchStart = useRef(0)
  const isAdmin = user?.role === 'admin'
  const downloadsEnabled = useDownloadsEnabled()
  const visibleUserSheetItems = !isAdmin && !downloadsEnabled ? userSheetItems.filter((item) => item.to !== '/apps') : userSheetItems
  const visibleUserSidebar = !isAdmin && !downloadsEnabled ? userSidebar.filter((item) => item.to !== '/apps') : userSidebar
  const adminItems = adminSections.flatMap((section) => section.items)
  const dockPaths = ['/dashboard', '/catalog/groups', '/users']
  const dockItems = dockPaths
    .map((path) => adminItems.find((item) => item.to === path))
    .filter((item): item is NavItem => Boolean(item))
    .map((item) => (item.to === '/users' ? { ...item, label: '用户' } : item))
  const sheetItems = adminItems.filter((item) => !dockPaths.includes(item.to))

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
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img className="brand-mark" src="/logo.png" alt="" />
          <div><strong>SubPanel</strong></div>
        </div>
        {isAdmin ? (
          <nav className="sidebar-nav" aria-label="主导航">
            {adminSections.map((section) => <section className="nav-section" key={section.label}>
              <p className="nav-label">{section.label}</p>
              {section.items.map(({ to, label, icon: Icon }) => (
                <Link key={to} to={to} className={location.pathname === to ? 'active' : undefined} aria-current={location.pathname === to ? 'page' : undefined}>
                  <Icon aria-hidden="true" size={17} /><span>{label}</span>
                </Link>
              ))}
            </section>)}
          </nav>
        ) : (
          <nav className="sidebar-nav nav-sidebar" aria-label="主导航">
            {visibleUserSidebar.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end className={({ isActive }) => isActive ? 'active' : undefined}>
                <Icon aria-hidden="true" size={17} /><span>{label}</span>
              </NavLink>
            ))}
          </nav>
        )}
        <div className="sidebar-account"><UserRound aria-hidden="true" size={18} /><div><strong>{user?.username}</strong><span>{user?.role === 'admin' ? '管理员' : '用户'}</span></div><button className="sidebar-signout" type="button" aria-label="退出登录" title="退出登录" onClick={signOut}><LogOut aria-hidden="true" size={17} /></button></div>
      </aside>
      <div className="workspace">
        <header className="workspace-topbar">
          <div id="page-title-slot" className="topbar-context" />
          <ThemeMenu />
          <div id="page-actions-slot" className="topbar-page-actions" />
        </header>
        <main key={location.pathname} className="workspace-content">{children}</main>
      </div>
      {isAdmin ? (
        <nav className="dock" aria-label="快捷导航">
          {dockItems.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={`dock-item ${location.pathname === to ? 'active' : ''}`} aria-current={location.pathname === to ? 'page' : undefined}>
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
            <NavLink key={to} to={to} end className={({ isActive }) => `dock-item nav-dock-item${isActive ? ' active' : ''}`}>
              <Icon aria-hidden="true" size={18} /><span>{label}</span>
            </NavLink>
          ))}
          <button ref={moreButton} className="dock-item nav-dock-item" type="button" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
            <Ellipsis aria-hidden="true" size={18} /><span>更多</span>
          </button>
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
          {(isAdmin ? sheetItems : visibleUserSheetItems).length ? <nav className="dock-sheet-nav" aria-label="主导航">
            {(isAdmin ? sheetItems : visibleUserSheetItems).map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} className={location.pathname === to ? 'active' : undefined} aria-current={location.pathname === to ? 'page' : undefined}>
                <Icon aria-hidden="true" size={19} /><span>{label}</span>
              </Link>
            ))}
          </nav> : null}
          <div className="dock-sheet-account">
            <UserRound aria-hidden="true" size={18} />
            <div><strong>{user?.username}</strong><span>{user?.role === 'admin' ? '管理员' : '用户'}</span></div>
            <button className="icon-button" type="button" aria-label="退出登录" title="退出登录" onClick={signOut}><LogOut aria-hidden="true" size={17} /></button>
          </div>
        </section>
      </> : null}
    </div>
  )
}
