import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { ThemeProvider } from './theme/ThemeProvider'
import './styles/tokens.css'
import './styles/app.css'
import './styles/components.css'
import './styles/pages-nav.css'
import './styles/pages-expiry.css'
import './styles/pages-shares.css'
import './styles/pages-apps.css'
import './styles/pages-adminshares.css'
import './styles/pages-users.css'
import './styles/pages-admin.css'
import './styles/pages-catalog.css'
import './styles/pages-delivery.css'
import './styles/pages-system.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
