import { FolderKanban, Gauge, LogOut, Menu, Network, Rss, Send, ShieldCheck, UserRound, Users, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ThemeMenu } from '../theme/ThemeMenu'
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

function GitHubIcon({ size }: { size: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 19 19"><use href="/icons.svg#github-icon" /></svg>
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [mobile, setMobile] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const sections = user?.role === 'admin' ? adminSections : userSections

  useEffect(() => setDrawerOpen(false), [location.pathname])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const sync = () => setMobile(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!drawerOpen) return
    closeButton.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
        menuButton.current?.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [drawerOpen])

  const signOut = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="app-layout">
      <aside className={`sidebar ${drawerOpen ? 'open' : ''}`} inert={mobile && !drawerOpen ? true : undefined}>
        <div className="sidebar-brand">
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <div><strong>SubPanel</strong><span>Control plane</span></div>
          <button ref={closeButton} className="sidebar-close" type="button" aria-label="关闭导航" onClick={() => setDrawerOpen(false)}><X aria-hidden="true" size={19} /></button>
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
      {drawerOpen ? <button className="drawer-overlay" type="button" aria-label="关闭导航遮罩" onClick={() => setDrawerOpen(false)} /> : null}
      <div className="workspace">
        <header className="workspace-topbar">
          <button ref={menuButton} className="icon-button mobile-menu" type="button" aria-label="打开导航" onClick={() => setDrawerOpen(true)}><Menu aria-hidden="true" size={19} /></button>
          <div id="page-title-slot" className="topbar-context" />
          <a className="icon-button" href="https://github.com/kadidalax/SubPanel" target="_blank" rel="noreferrer" aria-label="GitHub 仓库" title="GitHub 仓库"><GitHubIcon size={18} /></a>
          <ThemeMenu />
          <div id="page-actions-slot" className="topbar-page-actions" />
        </header>
        <main className="workspace-content">{children}</main>
        <footer className="workspace-footer">Powered by <a href="https://github.com/kadidalax/SubPanel" target="_blank" rel="noreferrer" aria-label="GitHub 仓库"><GitHubIcon size={15} /><span>SubPanel</span></a></footer>
      </div>
    </div>
  )
}
