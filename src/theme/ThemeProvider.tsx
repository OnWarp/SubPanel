import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ThemeMode = 'light' | 'dark'

declare global {
  interface Window {
    subpanelTheme: {
      key: string
      guestKey: string
      media: MediaQueryList
      read: (key?: string) => ThemePreference
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

function subscribeToSystemTheme(listener: () => void) {
  const { media } = window.subpanelTheme
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function getSystemTheme() {
  return window.subpanelTheme.resolve('system')
}

export function ThemeProvider({ children, scoped, storageKey = window.subpanelTheme.key }: {
  children: ReactNode
  storageKey?: string
  scoped?: Pick<ThemeState, 'preference' | 'setPreference'>
}) {
  const [legacyPreference, setLegacyPreference] = useState<ThemePreference>(() =>
    scoped ? 'system' : window.subpanelTheme.read(storageKey),
  )
  const preference = scoped?.preference ?? legacyPreference
  const systemTheme = useSyncExternalStore(subscribeToSystemTheme, getSystemTheme)
  const mode = preference === 'system' ? systemTheme : preference
  const usesLegacyStorage = !scoped

  useLayoutEffect(() => {
    window.subpanelTheme.apply(mode)
  }, [mode])

  const setLegacy = useCallback((next: ThemePreference) => {
    try { localStorage.setItem(storageKey, next) } catch { /* storage unavailable */ }
    setLegacyPreference(next)
  }, [storageKey])
  const setPreference = scoped?.setPreference ?? setLegacy

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return
      setLegacyPreference(window.subpanelTheme.read(storageKey))
    }
    if (usesLegacyStorage) window.addEventListener('storage', handleStorage)
    const frame = requestAnimationFrame(() => {
      document.documentElement.dataset.themeReady = 'true'
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('storage', handleStorage)
    }
  }, [storageKey, usesLegacyStorage])

  const value = useMemo(() => ({ preference, mode, setPreference }), [mode, preference, setPreference])
  return <ThemeContext value={value}>{children}</ThemeContext>
}

// eslint-disable-next-line react/only-export-components -- The hook and provider share one private context.
export function useTheme(): ThemeState {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
