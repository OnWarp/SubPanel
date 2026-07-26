import { BrowserRouter } from 'react-router-dom'
import { AppRouter } from './router'
import { SessionProvider } from './session'

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRouter />
      </SessionProvider>
    </BrowserRouter>
  )
}
