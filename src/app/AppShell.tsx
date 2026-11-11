import { Ellipsis, FolderKanban, Gauge, LogOut, Network, Rss, Send, ShieldCheck, UserRound, Users, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ThemeMenu } from '../theme/ThemeMenu'
import { MOBILE_MEDIA_QUERY } from './layout'
import { useSession } from './session'

type NavItem = { to: string; label: string; icon: LucideIcon }
type NavSection = { label: string; items: NavItem[] }

const adminSections: NavSection[] = [
  { label: '监控', items: [
    { to: '/dashboard', label: '概览', icon: Gauge },
    { to: '/catalog/nodes', label: '节点', icon: Network },
  ] },
  { label: '资源', items: [
    { to: '/catalog/sources', label: '来源', icon: Rss },
    { to: '/catalog/groups', label: '分组', icon: FolderKanban },
  ] },
  { label: '交付与权限', items: [
    { to: '/delivery/subscriptions', label: '订阅', icon: Send },
    { to: '/users', label: '用户与邀请', icon: Users },
  ] },
  { label: '账户', items: [{ to: '/account', label: '账户安全', icon: ShieldCheck }] },
]

const userSections: NavSection[] = [
  { label: '订阅', items: [{ to: '/subscriptions', label: '我的订阅', icon: Rss }] },
  { label: '账户', items: [{ to: '/account', label: '账户安全', icon: ShieldCheck }] },
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
  const sections = user?.role === 'admin' ? adminSections : userSections
  const navItems = sections.flatMap((section) => section.items)
  const dockItems = navItems.slice(0, 3)
  const sheetItems = navItems.slice(3)

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
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <div><strong>SubPanel</strong><span>Control plane</span></div>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          {sections.map((section) => <section className="nav-section" key={section.label}>
            <p className="nav-label">{section.label}</p>
            {section.items.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} className={location.pathname === to ? 'active' : undefined} aria-current={location.pathname === to ? 'page' : undefined}>
                <Icon aria-hidden="true" size={17} /><span>{label}</span>
              </Link>
            ))}
          </section>)}
        </nav>
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
            {sheetItems.map(({ to, label, icon: Icon }) => (
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
