import { AdminRedemptionsPage } from '../features/redemption/AdminRedemptionsPage'
import { AuditLogsPage } from '../features/admin/AuditLogsPage'
import { UserDetailPage } from '../features/accounts/UserDetailPage'
import type { ReactNode } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AccountPage } from '../features/accounts/AccountPage'
import { InvitePage } from '../features/accounts/InvitePage'
import { LoginPage } from '../features/accounts/LoginPage'
import { RegisterPage } from '../features/accounts/RegisterPage'
import { SetupPage } from '../features/accounts/SetupPage'
import { UserManagementPage } from '../features/accounts/UserManagementPage'
import { AdminNoticesPage } from '../features/system/AdminNoticesPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { AppsPage as UserAppsPage } from '../features/apps/AppsPage'
import { AppsPage } from '../features/catalog/AppsPage'
import { SourcesPage } from '../features/catalog/SourcesPage'
import { NodesPage } from '../features/catalog/NodesPage'
import { GroupsPage } from '../features/catalog/GroupsPage'
import { ConversionPage } from '../features/system/TemplatesSection'
import { EntitlementTemplatesPage } from '../features/delivery/EntitlementTemplatesPanel'
import { AdminSharesPage } from '../features/delivery/AdminSharesPage'
import { NoticesPage } from '../features/notices/NoticesPage'
import { AdminKbPage } from '../features/kb/AdminKbPage'
import { KbArticlePage } from '../features/kb/KbArticlePage'
import { KbPage } from '../features/kb/KbPage'
import { AdminTicketDetailPage } from '../features/tickets/AdminTicketDetailPage'
import { AdminTicketsPage } from '../features/tickets/AdminTicketsPage'
import { TicketDetailPage } from '../features/tickets/TicketDetailPage'
import { TicketsPage } from '../features/tickets/TicketsPage'
import { SystemPage } from '../features/system/SystemPage'
import { MySubscriptionsPage } from '../features/delivery/MySubscriptionsPage'
import { SharePage } from '../features/shares/SharePage'
import { readShareReturn } from '../features/shares/share-link'
import { HomePage } from '../features/user/HomePage'
import { MinePage, MineSettingsPage } from '../features/user/MinePage'
import { MyNodesPage } from '../features/user/MyNodesPage'
import { AppShell } from './AppShell'
import { useSession } from './session'

function RootRedirect() {
  const { initialized, user } = useSession()
  const shareReturn = readShareReturn()
  if (shareReturn) return <Navigate to={shareReturn} replace />
  const home = user?.role === 'admin' ? '/dashboard' : '/home'
  const signedOut = initialized ? '/login' : '/setup'
  return <Navigate to={user ? home : signedOut} replace />
}

export function AppRouter() {
  const location = useLocation()
  const { initialized, loading, user, bootstrapError, retryBootstrap } = useSession()
  const onPublicShare = /^\/s\/[^/]+$/u.test(location.pathname)
  if (!onPublicShare && loading) return <main className="loading-screen" role="status">正在加载</main>
  if (!onPublicShare && bootstrapError) {
    return (
      <main className="phase-shell">
        <section className="auth-panel" aria-labelledby="bootstrap-error-title">
          <div className="auth-heading"><h1 id="bootstrap-error-title">服务暂时不可用</h1><p role="alert">{bootstrapError}</p></div>
          <button className="button primary" type="button" onClick={() => retryBootstrap()}>重试</button>
        </section>
      </main>
    )
  }

  const home = user?.role === 'admin' ? '/dashboard' : '/home'
  const signedOut = initialized ? '/login' : '/setup'
  const returnedShare = readShareReturn()
  const shell = (content: ReactNode) => user ? <AppShell>{content}</AppShell> : <Navigate to={signedOut} replace />

  return (
    <Routes>
      <Route path="/s/:token" element={<SharePage />} />
      <Route path="/" element={<RootRedirect />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/setup" element={initialized ? <Navigate to="/login" replace /> : <SetupPage />} />
      <Route path="/register" element={!initialized ? <Navigate to="/setup" replace /> : user ? <Navigate to={home} replace /> : <RegisterPage />} />
      <Route path="/login" element={!initialized ? <Navigate to="/setup" replace /> : user ? <Navigate to={returnedShare ?? home} replace /> : <LoginPage />} />
      <Route path="/audit-logs" element={user?.role === 'admin' ? shell(<AuditLogsPage />) : <Navigate to={signedOut} replace />} />
      <Route path="/dashboard" element={user?.role === 'admin' ? shell(<DashboardPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/catalog/sources" element={user?.role === 'admin' ? shell(<SourcesPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/catalog/apps" element={user?.role === 'admin' ? shell(<AppsPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/catalog/nodes" element={user?.role === 'admin' ? shell(<NodesPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/catalog/groups" element={user?.role === 'admin' ? shell(<GroupsPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/delivery/conversions" element={user?.role === 'admin' ? shell(<ConversionPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/delivery/subscriptions/*" element={user?.role === 'admin' ? <Navigate to="/users" replace /> : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/delivery/templates" element={user?.role === 'admin' ? shell(<EntitlementTemplatesPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/delivery/redemptions" element={user?.role === 'admin' ? shell(<AdminRedemptionsPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/delivery/shares" element={user?.role === 'admin' ? shell(<AdminSharesPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/plans" element={user?.role === 'admin' ? <Navigate to="/delivery/templates" replace /> : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/delivery/tickets" element={user?.role === 'admin' ? shell(<AdminTicketsPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/delivery/tickets/:id" element={user?.role === 'admin' ? shell(<AdminTicketDetailPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/kb/manage" element={user?.role === 'admin' ? shell(<AdminKbPage />) : <Navigate to={user ? '/dashboard' : signedOut} replace />} />
      <Route path="/users" element={user?.role === 'admin' ? shell(<UserManagementPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/users/:id" element={user?.role === 'admin' ? shell(<UserDetailPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/users/recycle-bin" element={user?.role === 'admin' ? shell(<UserManagementPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/invites" element={user?.role === 'admin' ? shell(<UserManagementPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/apps" element={user ? shell(<UserAppsPage />) : <Navigate to={signedOut} replace />} />
      <Route path="/home" element={user?.role === 'user' ? shell(<HomePage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/entitlement" element={user?.role === 'user' ? <Navigate to="/subscriptions" replace /> : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/me" element={user?.role === 'user' ? shell(<Outlet />) : <Navigate to={user ? home : signedOut} replace />}>
        <Route index element={<MinePage />} />
        <Route path=":section" element={<MineSettingsPage />} />
      </Route>
      <Route path="/subscriptions" element={user?.role === 'user' ? shell(<MySubscriptionsPage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/entitlements" element={user?.role === 'user' ? <Navigate to="/subscriptions" replace /> : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/nodes" element={user?.role === 'user' ? shell(<MyNodesPage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/notices" element={user?.role === 'user' ? shell(<NoticesPage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/kb" element={user?.role === 'user' ? shell(<KbPage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/kb/:id" element={user?.role === 'user' ? shell(<KbArticlePage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/tickets" element={user?.role === 'user' ? shell(<TicketsPage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/tickets/:id" element={user?.role === 'user' ? shell(<TicketDetailPage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/system" element={user?.role === 'admin' ? shell(<SystemPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/system/:section" element={user?.role === 'admin' ? shell(<SystemPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/operations/notices" element={user?.role === 'admin' ? shell(<AdminNoticesPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/account" element={user?.role === 'user' ? <Navigate to="/me" replace /> : shell(<AccountPage />)} />
      <Route path="*" element={<Navigate to={user ? home : signedOut} replace />} />
    </Routes>
  )
}
