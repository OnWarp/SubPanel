import { AppWindow, BookOpen, Download } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiClientError } from '../../app/api'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'

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
      <PageHeader title="APP 下载" description="按平台查看可下载的 APP" />
      {loading ? <LoadingState label="正在加载 APP" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && response && !response.downloadsEnabled ? (
        <EmptyState icon={AppWindow} title="APP 下载暂未开放" description="管理员已关闭 APP 下载板块，开启后可在这里查看各平台的下载入口" />
      ) : null}
      {!loading && !error && response?.downloadsEnabled ? (
        <>
          <FilterBar className="appu-filters">
            <div className="appu-chip-group" role="group" aria-label="按平台筛选">
              <span className="appu-chip-label">平台</span>
              {PLATFORM_TABS.map((tab) => (
                <FilterChip key={tab.value} active={platform === tab.value} onClick={() => setPlatform(tab.value)}>{tab.label}</FilterChip>
              ))}
            </div>
          </FilterBar>
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
                      <a className="button secondary" href={entry.documentationUrl} target="_blank" rel="noopener noreferrer">
                        <BookOpen aria-hidden="true" size={16} />使用说明
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState icon={AppWindow} title="暂时没有可用的 APP" description="该平台下暂时没有可下载的 APP" />
          )}
        </>
      ) : null}
    </div>
  )
}
