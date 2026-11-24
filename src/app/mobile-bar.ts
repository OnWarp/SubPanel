import { createContext, useState } from 'react'

export const mobileBarKey = 'subpanel:mobile-bar'
export type MobileBarStyle = 'floating' | 'inset'

export const MobileBarContext = createContext<ReturnType<typeof useMobileBarPreference> | null>(null)

export function useMobileBarPreference(scoped?: { style: MobileBarStyle; changeStyle: (style: MobileBarStyle) => void }) {
  const [style, setStyle] = useState<MobileBarStyle>(() => {
    if (scoped) return 'floating'
    try { return localStorage.getItem(mobileBarKey) === 'inset' ? 'inset' : 'floating' }
    catch { return 'floating' }
  })

  const changeStyle = (next: MobileBarStyle) => {
    try { localStorage.setItem(mobileBarKey, next) } catch { /* storage unavailable */ }
    setStyle(next)
  }

  return scoped ?? { style, changeStyle }
}
