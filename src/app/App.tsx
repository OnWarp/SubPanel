import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppRouter } from './router'
import { SessionProvider, useSession } from './session'
import { ToastProvider } from '../ui/Toast'
import { ThemeProvider } from '../theme/ThemeProvider'
import { AdminLayoutProvider } from './admin-layout'

function SessionAppearance() {
  const { user } = useSession()
  if (user?.role === 'admin') {
    return <AdminLayoutProvider key={user.id} userId={user.id}><AppRouter /></AdminLayoutProvider>
  }
  const storageKey = user ? window.subpanelTheme.key : window.subpanelTheme.guestKey
  return <ThemeProvider key={storageKey} storageKey={storageKey}><AppRouter /></ThemeProvider>
}

const router = createBrowserRouter([{
  path: '*',
  element: <ToastProvider><SessionProvider><SessionAppearance /></SessionProvider></ToastProvider>,
}])

export function App() {
  return <RouterProvider router={router} />
}
