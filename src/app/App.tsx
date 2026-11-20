import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppRouter } from './router'
import { SessionProvider } from './session'
import { ToastProvider } from '../ui/Toast'

const router = createBrowserRouter([{
  path: '*',
  element: <ToastProvider><SessionProvider><AppRouter /></SessionProvider></ToastProvider>,
}])

export function App() {
  return <RouterProvider router={router} />
}
