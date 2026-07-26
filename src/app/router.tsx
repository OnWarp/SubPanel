import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AccountPage } from '../features/accounts/AccountPage'
import { InvitePage } from '../features/accounts/InvitePage'
import { LoginPage } from '../features/accounts/LoginPage'
import { SetupPage } from '../features/accounts/SetupPage'
import { UsersPage } from '../features/accounts/UsersPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { SourcesPage } from '../features/catalog/SourcesPage'
import { NodesPage } from '../features/catalog/NodesPage'
import { GroupsPage } from '../features/catalog/GroupsPage'
import { SubscriptionsPage } from '../features/delivery/SubscriptionsPage'
import { MySubscriptionsPage } from '../features/delivery/MySubscriptionsPage'
import { AppShell } from './AppShell'
import { useSession } from './session'

export function AppRouter() {
  const { initialized, loading, user, bootstrapError, retryBootstrap } = useSession()
  if (loading) return <main className="loading-screen" role="status">正在加载</main>
  if (bootstrapError) {
    return (
      <main className="phase-shell">
        <section className="auth-panel" aria-labelledby="bootstrap-error-title">
          <div className="auth-heading"><h1 id="bootstrap-error-title">服务暂时不可用</h1><p role="alert">{bootstrapError}</p></div>
          <button className="button primary" type="button" onClick={() => retryBootstrap()}>重试</button>
        </section>
      </main>
    )
  }

  const home = user?.role === 'admin' ? '/dashboard' : '/subscriptions'
  const signedOut = initialized ? '/login' : '/setup'
  const shell = (content: ReactNode) => user ? <AppShell>{content}</AppShell> : <Navigate to={signedOut} replace />

  return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/setup" element={initialized ? <Navigate to="/login" replace /> : <SetupPage />} />
      <Route path="/login" element={!initialized ? <Navigate to="/setup" replace /> : user ? <Navigate to={home} replace /> : <LoginPage />} />
      <Route path="/dashboard" element={user?.role === 'admin' ? shell(<DashboardPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/catalog/sources" element={user?.role === 'admin' ? shell(<SourcesPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/catalog/nodes" element={user?.role === 'admin' ? shell(<NodesPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/catalog/groups" element={user?.role === 'admin' ? shell(<GroupsPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/delivery/subscriptions" element={user?.role === 'admin' ? shell(<SubscriptionsPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/users" element={user?.role === 'admin' ? shell(<UsersPage />) : <Navigate to={user ? '/subscriptions' : signedOut} replace />} />
      <Route path="/subscriptions" element={user?.role === 'user' ? shell(<MySubscriptionsPage />) : <Navigate to={user ? home : signedOut} replace />} />
      <Route path="/account" element={shell(<AccountPage />)} />
      <Route path="*" element={<Navigate to={user ? home : signedOut} replace />} />
    </Routes>
  )
}
