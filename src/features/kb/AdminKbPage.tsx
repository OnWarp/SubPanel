import { OperationsActions, OperationsFooter, OperationsHeading } from '../admin/OperationsCard'
import { FormSelect, Input, Textarea } from '../../ui/Controls'
import { BookOpen } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/Toast'
import { formatKbTime, type KbArticle, type KbArticleSummary, type KbCategory } from './types'

const PAGE_SIZE = 20

type PublishedFilter = 'all' | 'true' | 'false'

type CategoryForm = {
  id: number | null
  name: string
  sort: string
}

type ArticleForm = {
  id: number | null
  categoryId: string
  title: string
  content: string
  published: boolean
  sort: string
}

type PendingDelete = {
  kind: 'category' | 'article'
  id: number
  label: string
}

const EMPTY_CATEGORY_FORM: CategoryForm = { id: null, name: '', sort: '0' }
const EMPTY_ARTICLE_FORM: ArticleForm = {
  id: null,
  categoryId: '',
  title: '',
  content: '',
  published: false,
  sort: '0',
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function parseSort(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function AdminKbPage() {
  const [categories, setCategories] = useState<KbCategory[]>(() => peekApi<{ categories: KbCategory[] }>('/api/admin/kb/categories')?.categories ?? [])
  const [categoriesLoading, setCategoriesLoading] = useState(() => peekApi('/api/admin/kb/categories') === undefined)
  const [categoriesError, setCategoriesError] = useState('')
  const [categoryForm, setCategoryForm] = useState<CategoryForm>(EMPTY_CATEGORY_FORM)
  const [categoryBusy, setCategoryBusy] = useState(false)

  const [page, setPage] = useState(1)
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [publishedFilter, setPublishedFilter] = useState<PublishedFilter>('all')
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
  if (categoryFilter !== 'all') params.set('categoryId', categoryFilter)
  if (publishedFilter !== 'all') params.set('published', publishedFilter)
  const articlesPath = `/api/admin/kb/articles?${params}`
  type ArticlesResult = { articles: KbArticleSummary[]; total: number }
  const [articles, setArticles] = useState<KbArticleSummary[]>(() => peekApi<ArticlesResult>(articlesPath)?.articles ?? [])
  const [total, setTotal] = useState(() => peekApi<ArticlesResult>(articlesPath)?.total ?? 0)
  const [articlesLoading, setArticlesLoading] = useState(() => peekApi(articlesPath) === undefined)
  const [articlesError, setArticlesError] = useState('')

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [articleForm, setArticleForm] = useState<ArticleForm>(EMPTY_ARTICLE_FORM)
  const [baseline, setBaseline] = useState(articleForm)
  const [articleError, setArticleError] = useState('')
  const [formBusy, setFormBusy] = useState(false)

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const toast = useToast()

  const loadCategories = useCallback(async () => {
    setCategoriesLoading(peekApi('/api/admin/kb/categories') === undefined)
    setCategoriesError('')
    try {
      await watchApi<{ categories: KbCategory[] }>('/api/admin/kb/categories', (result) => setCategories(result.categories))
    } catch (cause) {
      setCategories([])
      setCategoriesError(errorMessage(cause, '加载分类失败'))
    } finally {
      setCategoriesLoading(false)
    }
  }, [])

  const loadArticles = useCallback(async () => {
    setArticlesLoading(peekApi(articlesPath) === undefined)
    setArticlesError('')
    try {
      await watchApi<ArticlesResult>(articlesPath, (result) => {
        setArticles(result.articles)
        setTotal(result.total)
      })
    } catch (cause) {
      setArticles([])
      setTotal(0)
      setArticlesError(errorMessage(cause, '加载文章失败'))
    } finally {
      setArticlesLoading(false)
    }
  }, [articlesPath])

  useEffect(() => { loadCategories().catch(() => undefined) }, [loadCategories])
  useEffect(() => { loadArticles().catch(() => undefined) }, [loadArticles])

  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (categoryBusy) return
    const name = categoryForm.name.trim()
    if (!name) {
      toast.notifyError('请填写分类名称')
      return
    }
    setCategoryBusy(true)
    try {
      const payload = { name, sort: parseSort(categoryForm.sort) }
      if (categoryForm.id === null) {
        await api('/api/admin/kb/categories', { method: 'POST', body: jsonBody(payload) })
        toast.notify('分类已创建')
      } else {
        await api(`/api/admin/kb/categories/${categoryForm.id}`, { method: 'PUT', body: jsonBody(payload) })
        toast.notify('分类已更新')
      }
      setCategoryForm(EMPTY_CATEGORY_FORM)
      await Promise.all([loadCategories(), loadArticles()])
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '保存分类失败'))
    } finally {
      setCategoryBusy(false)
    }
  }

  const editCategory = (category: KbCategory) => {
    setCategoryForm({ id: category.id, name: category.name, sort: String(category.sort) })
  }

  const openCreate = () => {
    const first = categories[0]
    if (!first) {
      toast.notifyError('请先创建分类')
      return
    }
    const draft = { ...EMPTY_ARTICLE_FORM, categoryId: String(first.id) }
    setBaseline(draft)
    setArticleForm(draft)
    setArticleError('')
    setDrawerOpen(true)
  }

  const openEdit = async (article: KbArticleSummary) => {
    if (formBusy) return
    setFormBusy(true)
    try {
      const result = await api<{ article: KbArticle }>(`/api/admin/kb/articles/${article.id}`)
      const draft = {
        id: result.article.id,
        categoryId: String(result.article.categoryId),
        title: result.article.title,
        content: result.article.content,
        published: result.article.published,
        sort: String(result.article.sort),
      }
      setBaseline(draft)
      setArticleForm(draft)
      setArticleError('')
      setDrawerOpen(true)
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '加载文章失败'))
    } finally {
      setFormBusy(false)
    }
  }

  const saveArticle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (formBusy) return
    const title = articleForm.title.trim()
    const content = articleForm.content.trim()
    const categoryId = Number.parseInt(articleForm.categoryId, 10)
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      setArticleError('请选择分类')
      return
    }
    if (!title || !content) {
      setArticleError('请填写标题和正文')
      return
    }
    setFormBusy(true)
    try {
      const payload = {
        categoryId,
        title,
        content,
        published: articleForm.published,
        sort: parseSort(articleForm.sort),
      }
      if (articleForm.id === null) {
        await api('/api/admin/kb/articles', { method: 'POST', body: jsonBody(payload) })
        toast.notify('文章已创建')
      } else {
        await api(`/api/admin/kb/articles/${articleForm.id}`, { method: 'PUT', body: jsonBody(payload) })
        toast.notify('文章已更新')
      }
      setDrawerOpen(false)
      setArticleForm(EMPTY_ARTICLE_FORM)
      await loadArticles()
    } catch (cause) {
      setArticleError(errorMessage(cause, '保存文章失败'))
    } finally {
      setFormBusy(false)
    }
  }

  const removePending = async () => {
    if (!pendingDelete || deleteBusy) return
    setDeleteBusy(true)
    try {
      if (pendingDelete.kind === 'category') {
        const filterWasCategory = categoryFilter === String(pendingDelete.id)
        await api(`/api/admin/kb/categories/${pendingDelete.id}`, { method: 'DELETE' })
        toast.notify('分类已删除')
        if (categoryForm.id === pendingDelete.id) setCategoryForm(EMPTY_CATEGORY_FORM)
        if (filterWasCategory) {
          setCategoryFilter('all')
          setPage(1)
        }
        await loadCategories()
        if (!filterWasCategory) await loadArticles()
      } else {
        await api(`/api/admin/kb/articles/${pendingDelete.id}`, { method: 'DELETE' })
        toast.notify('文章已删除')
        if (articles.length === 1 && page > 1) setPage(page - 1)
        else await loadArticles()
      }
      setPendingDelete(null)
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '删除失败'))
    } finally {
      setDeleteBusy(false)
    }
  }

  const changeCategoryFilter = (value: string) => {
    setCategoryFilter(value)
    setPage(1)
  }

  const changePublishedFilter = (value: PublishedFilter) => {
    setPublishedFilter(value)
    setPage(1)
  }

  const columns: Array<DataTableColumn<KbArticleSummary>> = [
    {
      key: 'title',
      header: '标题',
      render: (article) => (
        <div><button className="kb-title-button ops-main" type="button" onClick={() => { openEdit(article).catch(() => undefined) }}>
          {article.title}
        </button><span className="ops-meta">{formatKbTime(article.updatedAt)}</span></div>
      ),
    },
    { key: 'categoryName', header: '分类' },
    {
      key: 'published',
      header: '状态',
      render: (article) => article.published
        ? <StatusBadge tone="success">已发布</StatusBadge>
        : <StatusBadge tone="muted">草稿</StatusBadge>,
    },
    { key: 'sort', header: '排序' },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (article) => (
        <OperationsActions label={`管理文章 ${article.title}`}>
          <button className="button ghost" type="button" disabled={formBusy} onClick={() => { openEdit(article).catch(() => undefined) }}>编辑</button>
          <button
            className="button ghost"
            type="button"
            onClick={() => setPendingDelete({ kind: 'article', id: article.id, label: article.title })}
          >
            删除
          </button>
        </OperationsActions>
      ),
    },
  ]

  const categoryOptions = [
    { value: 'all', label: '全部分类' },
    ...categories.map((category) => ({ value: String(category.id), label: category.name })),
  ]

  const articleCategoryOptions = categories.map((category) => ({
    value: String(category.id),
    label: category.name,
  }))

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="page-stack kb-page kb-admin ops-page">
      <PageHeader title="知识库管理" />

      <section className="data-section" aria-label="知识库管理">
        <OperationsHeading action={
          <button className="button primary" type="button" onClick={openCreate} disabled={categories.length === 0}>新建文章</button>
        } />
        <FilterBar>
          <label className="filter-field">
            <span>分类</span>
            <FormSelect aria-label="按分类筛选" value={categoryFilter} onChange={(event) => changeCategoryFilter(event.currentTarget.value)}>
              {categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </FormSelect>
          </label>
          <label className="filter-field">
            <span>状态</span>
            <FormSelect aria-label="发布状态" value={publishedFilter} onChange={(event) => changePublishedFilter(event.currentTarget.value as PublishedFilter)}>
              <option value="all">全部状态</option>
              <option value="true">已发布</option>
              <option value="false">草稿</option>
            </FormSelect>
          </label>
        </FilterBar>
        {articlesLoading && articles.length === 0 ? <LoadingState label="正在加载文章" /> : null}
        {!articlesLoading && articlesError ? <ErrorState message={articlesError} onRetry={() => { loadArticles().catch(() => undefined) }} /> : null}
        {!articlesLoading && !articlesError && total === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={categories.length === 0 ? '暂无文章，请先创建分类' : categoryFilter === 'all' && publishedFilter === 'all' ? '暂无文章' : '暂无匹配文章'}
          />
        ) : null}
        {!articlesLoading && !articlesError && total > 0 ? (
          <DataTable
            columns={columns}
            rows={articles}
            rowKey={(article) => article.id}
            empty="暂无匹配文章"
          />
        ) : null}
        {!articlesLoading && !articlesError && <OperationsFooter total={total} pagination={{ page, pageCount, onPageChange: setPage }} />}
      </section>

      <section className="data-section" aria-labelledby="kb-admin-categories-title">
        <DataHeader
          id="kb-admin-categories-title"
          title="分类"
          actions={(
            <button className="button ghost" type="button" disabled={categoriesLoading} onClick={() => { loadCategories().catch(() => undefined) }}>
              刷新
            </button>
          )}
        />
        {categoriesLoading ? <LoadingState label="正在加载分类" /> : null}
        {!categoriesLoading && categoriesError ? <ErrorState message={categoriesError} onRetry={() => { loadCategories().catch(() => undefined) }} /> : null}
        {!categoriesLoading && !categoriesError ? (
          <div className="kb-admin-body">
            <DataTable rows={categories} rowKey={(category) => category.id} empty="暂无分类，先在下方创建第一个分类" columns={[
              { key: 'name', header: '分类', render: (category) => <strong className="ops-main">{category.name}<span className="ops-meta">ID {category.id}</span></strong> },
              { key: 'sort', header: '排序' },
              { key: 'actions', header: '操作', align: 'right', render: (category) => (
                <OperationsActions label={`管理分类 ${category.name}`}>
                  <button className="button ghost" type="button" disabled={categoryBusy} onClick={() => editCategory(category)}>编辑</button>
                  <button className="button ghost" type="button" disabled={categoryBusy} onClick={() => setPendingDelete({ kind: 'category', id: category.id, label: category.name })}>删除</button>
                </OperationsActions>
              ) },
            ]} />
            <OperationsFooter total={categories.length} unit="个" />

            <form className="kb-category-form" onSubmit={saveCategory} noValidate>
              <h3 className="kb-subtitle">{categoryForm.id === null ? '新建分类' : '编辑分类'}</h3>
              <div className="kb-form-grid">
                <FormField label="分类名称" htmlFor="kb-category-name">
                  <Input
                    id="kb-category-name"
                    type="text"
                    maxLength={60}
                    required
                    value={categoryForm.name}
                    disabled={categoryBusy}
                    onChange={(event) => setCategoryForm({ ...categoryForm, name: event.currentTarget.value })}
                  />
                </FormField>
                <FormField label="排序（越小越靠前）" htmlFor="kb-category-sort">
                  <Input
                    id="kb-category-sort"
                    type="number"
                    min={0}
                    max={100000}
                    step={1}
                    inputMode="numeric"
                    value={categoryForm.sort}
                    disabled={categoryBusy}
                    onChange={(event) => setCategoryForm({ ...categoryForm, sort: event.currentTarget.value })}
                  />
                </FormField>
              </div>
              <div className="kb-form-actions">
                {categoryForm.id !== null ? (
                  <button className="button ghost" type="button" disabled={categoryBusy} onClick={() => setCategoryForm(EMPTY_CATEGORY_FORM)}>
                    取消编辑
                  </button>
                ) : null}
                <button className="button primary" type="submit" disabled={categoryBusy}>
                  {categoryBusy ? '保存中' : categoryForm.id === null ? '创建分类' : '保存修改'}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </section>

      <Dialog
        open={drawerOpen}
        title={articleForm.id === null ? '新建文章' : '编辑文章'}
        size="xl"
        busy={formBusy}
        onClose={() => setDrawerOpen(false)}

        dirty={JSON.stringify(articleForm) !== JSON.stringify(baseline)}
        footer={(cancel) => <>
          <button className="button secondary" type="button" disabled={formBusy} onClick={cancel}>取消</button>
          <button className="button primary" form="kb-article-editor" type="submit" disabled={formBusy}>{formBusy ? '保存中' : articleForm.id === null ? '创建文章' : '保存修改'}</button>
        </>}
      >
        <form id="kb-article-editor" className="kb-form" onSubmit={saveArticle} noValidate>
          <FormField label="分类">
            <FormSelect aria-label="文章分类" value={articleForm.categoryId} disabled={formBusy}
              onChange={(event) => setArticleForm({ ...articleForm, categoryId: event.currentTarget.value })}>
              {articleCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </FormSelect>
          </FormField>
          <FormField label="标题" htmlFor="kb-article-title-input">
            <Input
              id="kb-article-title-input"
              type="text"
              maxLength={160}
              required
              value={articleForm.title}
              disabled={formBusy}
              onChange={(event) => setArticleForm({ ...articleForm, title: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="正文（Markdown）" htmlFor="kb-article-content">
            <Textarea
              id="kb-article-content"
              rows={14}
              maxLength={100_000}
              required
              value={articleForm.content}
              disabled={formBusy}
              onChange={(event) => setArticleForm({ ...articleForm, content: event.currentTarget.value })}
            />
          </FormField>
          <div className="kb-form-grid">
            <FormField label="排序（越小越靠前）" htmlFor="kb-article-sort">
              <Input
                id="kb-article-sort"
                type="number"
                min={0}
                max={100000}
                step={1}
                inputMode="numeric"
                value={articleForm.sort}
                disabled={formBusy}
                onChange={(event) => setArticleForm({ ...articleForm, sort: event.currentTarget.value })}
              />
            </FormField>
            <FormField label="发布给用户">
              <Switch
                checked={articleForm.published}
                onChange={(checked) => setArticleForm({ ...articleForm, published: checked })}
                disabled={formBusy}
                ariaLabel="发布给用户"
              />
            </FormField>
          </div>
          {articleError && <StatusMessage tone="error">{articleError}</StatusMessage>}
        </form>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === 'category' ? '删除分类' : '删除文章'}
        description={pendingDelete?.kind === 'category'
          ? `将删除分类「${pendingDelete.label}」；分类下仍有文章时不能删除`
          : `将删除文章「${pendingDelete?.label ?? ''}」，删除后用户端不再显示`}
        confirmLabel={pendingDelete?.kind === 'category' ? '删除分类' : '删除文章'}
        danger
        busy={deleteBusy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { removePending().catch(() => undefined) }}
      />
    </div>
  )
}
