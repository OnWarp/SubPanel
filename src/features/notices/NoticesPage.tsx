import { Pagination } from '../../ui/Pagination'
import { SearchInput } from '../../ui/SearchInput'
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
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
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

  const filtered = notices.filter((notice) => `${notice.title} ${notice.body}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10))
  const currentPage = Math.min(page, pageCount)

  return (
    <div className="page-stack ntc-page">
      <PageHeader title="公告" />
      <SearchInput className="ntc-search" label="搜索公告" placeholder="搜索公告标题或内容" value={query} onChange={(value) => { setQuery(value); setPage(1) }} />
      {loading ? <LoadingState label="正在加载公告" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && filtered.length === 0 ? (
        <EmptyState icon={Megaphone} title={query.trim() ? '没有匹配的公告' : '暂无公告'} />
      ) : null}
      {!loading && !error && filtered.length > 0 ? (
        <div className="ntc-list">
          {filtered.slice((currentPage - 1) * 10, currentPage * 10).map((notice) => (
            <article key={notice.id} className="data-section ntc-card" aria-labelledby={`ntc-title-${notice.id}`}>
              <header className="ntc-card-head">
                <h2 id={`ntc-title-${notice.id}`}>{notice.title}</h2>
                <time dateTime={notice.publishedAt}>{formatNoticeTime(notice.publishedAt)}</time>
              </header>
              <p className="ntc-body ntc-summary">{notice.body}</p>
              <details className="ntc-full"><summary>阅读全文</summary><p className="ntc-body">{notice.body}</p></details>
            </article>
          ))}
          <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
        </div>
      ) : null}
    </div>
  )
}
