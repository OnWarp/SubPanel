import { UserPlus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PageHeader } from '../../ui/PageHeader'
import { InvitesPage } from './InvitesPage'
import { UsersPage } from './UsersPage'

export function UserManagementPage() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const invite = pathname === '/invites'
  const trash = pathname === '/users/recycle-bin'
  return (
    <div className="page-stack">
      <PageHeader title="用户管理" />
      <section className="data-section" aria-labelledby="users-card-title">
        <header className="section-heading">
          <h2 id="users-card-title">用户管理</h2>
          <button className="button primary" type="button" onClick={() => navigate(`/invites${search}`)}>
            <UserPlus aria-hidden="true" size={16} />
            邀请用户
          </button>
        </header>
        {invite ? <InvitesPage /> : <UsersPage key={pathname} view={trash ? 'trash' : 'active'} />}
      </section>
    </div>
  )
}
