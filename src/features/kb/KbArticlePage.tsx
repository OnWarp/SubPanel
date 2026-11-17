import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiClientError } from '../../app/api'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { renderMarkdown } from './markdown'
import { formatKbTime, type KbArticle } from './types'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function KbArticlePage() {
  const { id = '' } = useParams()
  const [article, setArticle] = useState<KbArticle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api<{ article: KbArticle }>(`/api/kb/articles/${id}`)
      setArticle(result.article)
    } catch (cause) {
      setArticle(null)
      setError(errorMessage(cause, '加载文章失败'))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load().catch(() => undefined) }, [load])

  return (
    <div className="page-stack kb-page kb-article-page">
      <PageHeader
        title={article?.title ?? '文章'}
        actions={<Link className="button ghost" to="/kb"><ArrowLeft aria-hidden="true" size={16} />返回知识库</Link>}
      />

      {loading && !article ? <LoadingState label="正在加载文章" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}

      {article ? (
        <article className="data-section kb-article" aria-labelledby="kb-article-title">
          <header className="kb-article-head">
            <h2 id="kb-article-title">{article.title}</h2>
            <p className="kb-article-meta">
              <span>{article.categoryName}</span>
              <span>更新于 {formatKbTime(article.updatedAt)}</span>
            </p>
          </header>
          <div className="kb-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(article.content) }} />
        </article>
      ) : null}
    </div>
  )
}
