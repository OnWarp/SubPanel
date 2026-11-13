import { AppWindow, Download } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiClientError } from '../../app/api'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { SegmentedControl } from '../../ui/SegmentedControl'

type PlatformName = 'windows' | 'macos' | 'android' | 'ios' | 'linux'

type UserPlatform = {
  id: string
  platform: PlatformName
  downloadUrl: string
  documentationUrl: string | null
  sortOrder: number
}

type UserApp = {
  id: string
  name: string
  description: string
  sortOrder: number
  platforms: UserPlatform[]
}

type AppsResponse = {
  downloadsEnabled: boolean
  apps: UserApp[]
}

const PLATFORM_TABS: Array<{ value: PlatformName; label: string }> = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
  { value: 'linux', label: 'Linux' },
]

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function AppsPage() {
  const [response, setResponse] = useState<AppsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [platform, setPlatform] = useState<PlatformName>('windows')

  const load = useCallback(async () => {
    setError('')
    try {
      const next = await api<AppsResponse>('/api/apps')
      setResponse(next)
      return next
    } catch (cause) {
      setError(errorMessage(cause, '加载 APP 列表失败'))
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const entries = useMemo(() => {
    const visible: Array<{ app: UserApp; entry: UserPlatform }> = []
    for (const app of response?.apps ?? []) {
      const entry = app.platforms.find((item) => item.platform === platform)
      if (entry) visible.push({ app, entry })
    }
    return visible
  }, [response, platform])

  return (
    <div className="page-stack appu-page">
      <PageHeader title="APP 下载" />
      {loading ? <LoadingState label="正在加载 APP" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && response && !response.downloadsEnabled ? (
        <EmptyState icon={AppWindow} title="APP 下载暂未开放" />
      ) : null}
      {!loading && !error && response?.downloadsEnabled ? (
        <>
          <div className="appu-filters">
            <SegmentedControl label="平台" value={platform} options={PLATFORM_TABS} onChange={setPlatform} />
          </div>
          {entries.length ? (
            <div className="appu-grid">
              {entries.map(({ app, entry }) => (
                <article className="appu-card" key={app.id}>
                  <div className="appu-card-head">
                    <span className="appu-mark"><AppWindow aria-hidden="true" size={24} /></span>
                    <div className="appu-card-id">
                      <strong className="appu-name">{app.name}</strong>
                    </div>
                  </div>
                  {app.description ? <p className="appu-copy">{app.description}</p> : null}
                  <div className="appu-actions">
                    <a className="button primary" href={entry.downloadUrl} target="_blank" rel="noopener noreferrer">
                      <Download aria-hidden="true" size={16} />下载
                    </a>
                    {entry.documentationUrl ? (
                      <a className="appu-doc-link" href={entry.documentationUrl} target="_blank" rel="noopener noreferrer">
                        使用说明
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState icon={AppWindow} title="暂无可用的 APP" />
          )}
        </>
      ) : null}
    </div>
  )
}
