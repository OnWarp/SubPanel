import { matchPath, useLocation } from 'react-router-dom'
import { UsersPage } from './UsersPage'
import { InvitesPage } from './InvitesPage'

export function UserManagementPage() {
  const { pathname } = useLocation()
  if (matchPath('/invites', pathname)) return <InvitesPage />
  return <UsersPage key={pathname} view={matchPath('/users/recycle-bin', pathname) ? 'trash' : 'active'} />
}
