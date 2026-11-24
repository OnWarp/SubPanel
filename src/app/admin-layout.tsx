import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ThemeProvider, type ThemePreference } from '../theme/ThemeProvider'
import { mobileBarKey, type MobileBarStyle } from './mobile-bar'

export type AdminLayout = 'sidebar' | 'topbar'

type AdminPreferences = {
  pc: { navigation: AdminLayout; sidebarCollapsed: boolean }
  mobile: { bar: MobileBarStyle }
  theme: ThemePreference
}

const defaults: AdminPreferences = {
  pc: { navigation: 'sidebar', sidebarCollapsed: false },
  mobile: { bar: 'floating' },
  theme: 'system',
}

const migrationKey = 'subpanel:layout:legacy-owner'
export const sidebarCollapsedKey = 'subpanel:sidebar-collapsed'

function readPreferences(key: string): AdminPreferences | null {
  let raw: string | null
  try { raw = localStorage.getItem(key) } catch { return null }
  if (raw === null) return null
  try {
    const value = JSON.parse(raw)
    return {
      pc: {
        navigation: value?.pc?.navigation === 'topbar' ? 'topbar' : defaults.pc.navigation,
        sidebarCollapsed: value?.pc?.sidebarCollapsed === true,
      },
      mobile: { bar: value?.mobile?.bar === 'inset' ? 'inset' : defaults.mobile.bar },
      theme: value?.theme === 'light' || value?.theme === 'dark' ? value.theme : defaults.theme,
    }
  } catch {
    return defaults
  }
}

function initializePreferences(key: string, migrateLegacy: boolean): AdminPreferences {
  const saved = readPreferences(key)
  if (saved) return saved

  let initial = defaults
  try {
    const owner = migrateLegacy ? localStorage.getItem(migrationKey) : null
    if (migrateLegacy && (owner === null || owner === key)) {
      localStorage.setItem(migrationKey, key)
      initial = {
        pc: {
          navigation: localStorage.getItem('subpanel:admin-layout') === 'topbar' ? 'topbar' : defaults.pc.navigation,
          sidebarCollapsed: localStorage.getItem(sidebarCollapsedKey) === '1',
        },
        mobile: { bar: localStorage.getItem(mobileBarKey) === 'inset' ? 'inset' : defaults.mobile.bar },
        theme: window.subpanelTheme.read(),
      }
    }
    localStorage.setItem(key, JSON.stringify(initial))
  } catch { /* storage unavailable */ }
  return initial
}

type AdminLayoutState = {
  preferences: AdminPreferences
  changeNavigation: (navigation: AdminLayout) => void
  toggleSidebar: () => void
  changeMobileBar: (bar: MobileBarStyle) => void
}

const AdminLayoutContext = createContext<AdminLayoutState | null>(null)

// eslint-disable-next-line react/only-export-components -- The hook and provider share one private context.
export function useAdminLayout() {
  return useContext(AdminLayoutContext)
}

export function AdminLayoutProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const key = `subpanel:layout:admin:${encodeURIComponent(userId)}`
  const storageWritable = useRef(true)
  const [preferences, setPreferences] = useState(() => readPreferences(key))

  useEffect(() => {
    let active = true
    const initialize = (migrateLegacy: boolean) => {
      if (active) setPreferences(initializePreferences(key, migrateLegacy))
    }
    if (navigator.locks) {
      void navigator.locks.request(migrationKey, () => initialize(true)).catch(() => initialize(false))
    } else {
      initialize(false)
    }
    const handleStorage = (event: StorageEvent) => {
      if (storageWritable.current && (event.key === key || event.key === null)) {
        setPreferences(readPreferences(key) ?? defaults)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => {
      active = false
      window.removeEventListener('storage', handleStorage)
    }
  }, [key])

  if (!preferences) {
    return <ThemeProvider storageKey={window.subpanelTheme.guestKey}><main className="loading-screen" role="status">正在加载</main></ThemeProvider>
  }

  const update = (change: (current: AdminPreferences) => AdminPreferences) => {
    const current = storageWritable.current ? readPreferences(key) ?? preferences : preferences
    const next = change(current)
    if (storageWritable.current) {
      try { localStorage.setItem(key, JSON.stringify(next)) } catch { storageWritable.current = false }
    }
    setPreferences(next)
  }

  const layout = {
    preferences,
    changeNavigation: (navigation: AdminLayout) => update(current => ({ ...current, pc: { ...current.pc, navigation } })),
    toggleSidebar: () => update(current => ({ ...current, pc: { ...current.pc, sidebarCollapsed: !current.pc.sidebarCollapsed } })),
    changeMobileBar: (bar: MobileBarStyle) => update(current => ({ ...current, mobile: { bar } })),
  }

  return (
    <AdminLayoutContext value={layout}>
      <ThemeProvider scoped={{
        preference: preferences.theme,
        setPreference: theme => update(current => ({ ...current, theme })),
      }}>{children}</ThemeProvider>
    </AdminLayoutContext>
  )
}
