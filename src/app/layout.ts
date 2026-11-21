import { useSyncExternalStore } from 'react'

export const MOBILE_MEDIA_QUERY = '(width < 768px)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia(MOBILE_MEDIA_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function isMobileViewport() {
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches
}

export function useMobileViewport() {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false)
}
