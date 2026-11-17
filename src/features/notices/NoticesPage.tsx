import { useSearchParams } from 'react-router-dom'
import { Pagination } from '../../ui/Pagination'
import { SearchInput } from '../../ui/SearchInput'
import { Megaphone } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiClientError } from '../../app/api'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { formatNoticeTime, type Notice } from './types'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function NoticesPage() {
  const [params] = useSearchParams()
  const selectedNotice = params.get('notice')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [notices, setNotices] = useState<Notice[]>([])
  const [total, setTotal] = useState(0)
  const requestSeq = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ q: query.trim(), page: String(page), pageSize: '10' })
      const result = await api<{ notices: Notice[]; total: number }>(`/api/notices?${params}`)
      if (seq !== requestSeq.current) return
      setTotal(result.total)
      setNotices(result.notices)
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setNotices([])
      setError(errorMessage(cause, '加载公告失败'))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [query, page])

  useEffect(() => { load().catch(() => undefined) }, [load])

  useEffect(() => {
    if (selectedNotice && !loading) document.getElementById(`notice-${selectedNotice}`)?.scrollIntoView({ block: 'start' })
  }, [selectedNotice, loading, notices])

  const pageCount = Math.max(1, Math.ceil(total / 10))
  const currentPage = Math.min(page, pageCount)
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])

  return (
    <div className="page-stack ntc-page">
      <PageHero subtitle="查看最新服务公告" title="公告" />
      <SearchInput className="ntc-search" label="搜索公告" placeholder="搜索公告标题或内容" value={query} onChange={(value) => { setQuery(value); setPage(1) }} />
      {loading ? <LoadingState label="正在加载公告" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && notices.length === 0 ? (
        <EmptyState icon={Megaphone} title={query.trim() ? '没有匹配的公告' : '暂无公告'} />
      ) : null}
      {!loading && !error && notices.length > 0 ? (
        <div className="ntc-list">
          {notices.map((notice) => (
            <article id={`notice-${notice.id}`} key={notice.id} className="data-section ntc-card" aria-labelledby={`ntc-title-${notice.id}`}>
              <header className="ntc-card-head">
                <h2 id={`ntc-title-${notice.id}`}>{notice.title}</h2>
                <time dateTime={notice.publishedAt}>{formatNoticeTime(notice.publishedAt)}</time>
              </header>
              <p className="ntc-body ntc-summary">{notice.body}</p>
              <details className="ntc-full" open={String(notice.id) === selectedNotice ? true : undefined}><summary>阅读全文</summary><p className="ntc-body">{notice.body}</p></details>
            </article>
          ))}
          <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
        </div>
      ) : null}
    </div>
  )
}
