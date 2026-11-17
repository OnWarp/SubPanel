import { NavLink, useLocation } from 'react-router-dom'
import { UsersPage } from './UsersPage'
import { InvitesPage } from './InvitesPage'

export function UserManagementPage() {
  const { pathname, search } = useLocation()
  const invite = pathname === '/invites'
  const trash = pathname === '/users/recycle-bin'
  return <div className="page-stack">
    <nav className="filter-bar" aria-label="用户管理子页">
      {[['/users', '用户'], ['/invites', '邀请'], ['/users/recycle-bin', '回收站']].map(([to, label]) => <NavLink className={({ isActive }) => `button ghost${isActive ? ' active' : ''}`} key={to} to={to + search} end>{label}</NavLink>)}
    </nav>
    {invite ? <InvitesPage /> : <UsersPage key={pathname} view={trash ? 'trash' : 'active'} />}
  </div>
}
