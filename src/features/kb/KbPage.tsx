import { BookOpen, ChevronRight, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { peekApi, watchApi, ApiClientError } from '../../app/api'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { SearchInput } from '../../ui/SearchInput'
import { formatKbTime, type KbArticleSummary, type UserKbCategory } from './types'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function ArticleLink({ article }: { article: KbArticleSummary }) {
  return (
    <li>
      <Link className="kb-article-link" to={`/kb/${article.id}`}>
        <span className="kb-article-link-main">
          <span className="kb-article-link-title">{article.title}</span>
          <span className="kb-article-link-meta">更新于 {formatKbTime(article.updatedAt)}</span>
        </span>
        <ChevronRight aria-hidden="true" size={16} />
      </Link>
    </li>
  )
}

export function KbPage() {
  const [categories, setCategories] = useState<UserKbCategory[]>(() => peekApi<{ categories: UserKbCategory[] }>('/api/kb')?.categories ?? [])
  const [loading, setLoading] = useState(() => peekApi<{ categories: UserKbCategory[] }>('/api/kb') === undefined)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KbArticleSummary[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchNonce, setSearchNonce] = useState(0)

  const load = useCallback(async () => {
    setLoading(peekApi<{ categories: UserKbCategory[] }>('/api/kb') === undefined)
    setError('')
    try {
      await watchApi<{ categories: UserKbCategory[] }>('/api/kb', (result) => {
        setCategories(result.categories)
      })
    } catch (cause) {
      setCategories([])
      setError(errorMessage(cause, '加载知识库失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setResults(null)
      setSearchError('')
      setSearching(false)
      return
    }
    let cancelled = false
    const path = `/api/kb/search?q=${encodeURIComponent(trimmed)}`
    const cached = peekApi<{ articles: KbArticleSummary[] }>(path)
    if (cached) setResults(cached.articles)
    setSearching(!cached)
    setSearchError('')
    const timer = window.setTimeout(() => {
      void watchApi<{ articles: KbArticleSummary[] }>(path, (result) => {
          if (!cancelled) setResults(result.articles)
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setResults([])
            setSearchError(errorMessage(cause, '搜索失败'))
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, searchNonce])

  const searchingActive = query.trim() !== ''

  return (
    <div className="page-stack kb-page">
      <PageHero title="知识库" />

      <div className="kb-search">
        <SearchInput
          value={query}
          onChange={setQuery}
          label="搜索知识库"
          placeholder="搜索标题或正文"
        />
      </div>

      {loading && categories.length === 0 ? <LoadingState label="正在加载知识库" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}

      {searchingActive ? (
        <section className="data-section kb-search-results" aria-label="搜索结果">
          <h2 className="kb-section-title">搜索结果</h2>
          {searching ? <LoadingState label="正在搜索" /> : null}
          {!searching && searchError ? <ErrorState message={searchError} onRetry={() => setSearchNonce((value) => value + 1)} /> : null}
          {!searching && !searchError && results && results.length === 0 ? (
            <EmptyState icon={Search} title="没有匹配的文章" description="换一个关键词再试试" />
          ) : null}
          {!searching && !searchError && results && results.length > 0 ? (
            <ul className="kb-article-list">
              {results.map((article) => (
                <li key={article.id}>
                  <Link className="kb-article-link" to={`/kb/${article.id}`}>
                    <span className="kb-article-link-main">
                      <span className="kb-article-link-title">{article.title}</span>
                      <span className="kb-article-link-meta">{article.categoryName}</span>
                    </span>
                    <ChevronRight aria-hidden="true" size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {!searchingActive && !error && !loading && categories.length === 0 ? (
        <EmptyState icon={BookOpen} title="知识库还没有内容" description="管理员发布文章后会显示在这里" />
      ) : null}

      {!searchingActive && !error && categories.length > 0 ? (
        <div className="kb-category-stack">
          {categories.map((category) => (
            <section key={category.id} className="data-section kb-category" aria-labelledby={`kb-category-${category.id}`}>
              <h2 id={`kb-category-${category.id}`} className="kb-section-title">{category.name}</h2>
              <ul className="kb-article-list">
                {category.articles.map((article) => <ArticleLink key={article.id} article={article} />)}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}
