import { UserPlus } from 'lucide-react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { PageHeader } from '../../ui/PageHeader'
import { InvitesPage } from './InvitesPage'
import { UsersPage } from './UsersPage'

const TABS = [
  ['/users', '用户'],
  ['/invites', '邀请'],
  ['/users/recycle-bin', '回收站'],
] as const

export function UserManagementPage() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const invite = pathname === '/invites'
  const trash = pathname === '/users/recycle-bin'
  return (
    <div className="page-stack">
      <PageHeader title="用户管理" />
      <section className="usr-card" aria-labelledby="users-card-title">
        <header className="usr-card-head">
          <h2 id="users-card-title">用户管理</h2>
          <button className="button primary" type="button" onClick={() => navigate(`/invites${search}`)}>
            <UserPlus aria-hidden="true" size={16} />
            邀请用户
          </button>
        </header>
        <nav className="usr-tabs" aria-label="用户管理子页">
          {TABS.map(([to, label]) => (
            <NavLink key={to} to={`${to}${search}`} end className={({ isActive }) => `usr-tab${isActive ? ' active' : ''}`}>{label}</NavLink>
          ))}
        </nav>
        {invite ? <InvitesPage /> : <UsersPage key={pathname} view={trash ? 'trash' : 'active'} />}
      </section>
    </div>
  )
}
