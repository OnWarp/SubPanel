import { Megaphone } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiClientError } from '../../app/api'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { formatNoticeTime, type Notice } from './types'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function NoticesPage() {
  const [notices, setNotices] = useState<Notice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api<{ notices: Notice[] }>('/api/notices')
      setNotices(result.notices)
    } catch (cause) {
      setNotices([])
      setError(errorMessage(cause, '加载公告失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  return (
    <div className="page-stack ntc-page">
      <PageHeader title="公告" />
      {loading ? <LoadingState label="正在加载公告" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && notices.length === 0 ? (
        <EmptyState icon={Megaphone} title="暂无公告" description="管理员发布的公告会显示在这里" />
      ) : null}
      {!loading && !error && notices.length > 0 ? (
        <div className="ntc-list">
          {notices.map((notice) => (
            <article key={notice.id} className="data-section ntc-card" aria-labelledby={`ntc-title-${notice.id}`}>
              <header className="ntc-card-head">
                <h2 id={`ntc-title-${notice.id}`}>{notice.title}</h2>
                <time dateTime={notice.publishedAt}>{formatNoticeTime(notice.publishedAt)}</time>
              </header>
              <p className="ntc-body">{notice.body}</p>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  )
}
