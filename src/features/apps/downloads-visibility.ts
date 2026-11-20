import { useEffect, useState } from 'react'
import { peekApi, watchApi } from '../../app/api'

type AppsVisibilityResponse = {
  downloadsEnabled: boolean
  apps: unknown[]
}

export function useDownloadsEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => peekApi<AppsVisibilityResponse>('/api/apps')?.downloadsEnabled ?? true)

  useEffect(() => {
    const controller = new AbortController()
    void watchApi<AppsVisibilityResponse>('/api/apps', (response) => {
      setEnabled(response.downloadsEnabled)
    }, { signal: controller.signal }).catch(() => undefined)
    return () => controller.abort()
  }, [])

  return enabled
}
