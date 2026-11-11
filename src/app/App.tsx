import { BrowserRouter } from 'react-router-dom'
import { AppRouter } from './router'
import { SessionProvider } from './session'
import { ToastProvider } from '../ui/Toast'

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <AppRouter />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  )
}
