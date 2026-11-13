import { useEffect, useState } from 'react'
import { api } from '../../app/api'

type AppsVisibilityResponse = {
  downloadsEnabled: boolean
  apps: unknown[]
}

let cached: Promise<boolean> | null = null

/** Reads the user-side downloads switch once per page load (shared by the shell, home page and apps page). */
export function fetchDownloadsEnabled(): Promise<boolean> {
  if (!cached) {
    cached = api<AppsVisibilityResponse>('/api/apps')
      .then((response) => response.downloadsEnabled)
      .catch(() => true)
  }
  return cached
}

/** Defaults to visible while the switch state is unknown or unreadable. */
export function useDownloadsEnabled(): boolean {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    let active = true
    fetchDownloadsEnabled()
      .then((value) => {
        if (active) setEnabled(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return enabled
}
