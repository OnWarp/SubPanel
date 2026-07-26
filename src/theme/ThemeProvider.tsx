import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ThemeMode = 'light' | 'dark'

declare global {
  interface Window {
    subpanelTheme: {
      key: string
      media: MediaQueryList
      read: () => ThemePreference
      resolve: (preference: ThemePreference) => ThemeMode
      apply: (preference?: ThemePreference) => ThemeMode
    }
  }
}

type ThemeState = {
  preference: ThemePreference
  mode: ThemeMode
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeState | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => window.subpanelTheme.read())
  const [mode, setMode] = useState<ThemeMode>(() => window.subpanelTheme.apply(preference))

  const apply = useCallback((next: ThemePreference) => {
    setMode(window.subpanelTheme.apply(next))
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    localStorage.setItem(window.subpanelTheme.key, next)
    setPreferenceState(next)
    apply(next)
  }, [apply])

  useEffect(() => {
    const handleSystem = () => {
      if (preference === 'system') apply('system')
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== window.subpanelTheme.key) return
      const next = window.subpanelTheme.read()
      setPreferenceState(next)
      apply(next)
    }
    window.subpanelTheme.media.addEventListener('change', handleSystem)
    window.addEventListener('storage', handleStorage)
    const frame = requestAnimationFrame(() => {
      document.documentElement.dataset.themeReady = 'true'
    })
    return () => {
      cancelAnimationFrame(frame)
      window.subpanelTheme.media.removeEventListener('change', handleSystem)
      window.removeEventListener('storage', handleStorage)
    }
  }, [apply, preference])

  const value = useMemo(() => ({ preference, mode, setPreference }), [mode, preference, setPreference])
  return <ThemeContext value={value}>{children}</ThemeContext>
}

// eslint-disable-next-line react/only-export-components -- The hook and provider share one private context.
export function useTheme(): ThemeState {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
