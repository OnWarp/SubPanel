import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { ThemeProvider } from './theme/ThemeProvider'
import './styles/tokens.css'
import './styles/app.css'
import './styles/components.css'
<<<<<<< HEAD
import './styles/pages-admin.css'
import './styles/pages-catalog.css'
=======
import './styles/pages-delivery.css'
>>>>>>> task/ui-p4-delivery-grok

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
