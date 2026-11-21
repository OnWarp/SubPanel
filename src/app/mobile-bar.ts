import { createContext, useState } from 'react'

const storageKey = 'subpanel:mobile-bar'
type MobileBarStyle = 'floating' | 'inset'

export const MobileBarContext = createContext<ReturnType<typeof useMobileBarPreference> | null>(null)

export function useMobileBarPreference() {
  const [style, setStyle] = useState<MobileBarStyle>(() => {
    try { return localStorage.getItem(storageKey) === 'inset' ? 'inset' : 'floating' }
    catch { return 'floating' }
  })

  const changeStyle = (next: MobileBarStyle) => {
    try { localStorage.setItem(storageKey, next) } catch { /* storage unavailable */ }
    setStyle(next)
  }

  return { style, changeStyle }
}
