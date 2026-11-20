import { ResourceRowActions, ResourceSelectAll } from '../admin-resources/ResourceCard'
import { Checkbox, Input, FormSelect, Textarea, FileInput } from '../../ui/Controls'
import { CheckCircle2, FileUp, Plus, RefreshCw, Rss, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { Switch } from '../../ui/Switch'
import { ErrorState } from '../../ui/ErrorState'
import { PageHeader } from '../../ui/PageHeader'
import { FilterBar } from '../../ui/FilterBar'
import { LoadingState } from '../../ui/LoadingState'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge, type StatusBadgeTone } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { useToast } from '../../ui/Toast'
import { formatDate, formatLabel, matchesText, sourceStatus, sourceTypeLabel } from './catalog-utils'

type PreviewResult = {
  format: string
  nodes: Array<{ protocol: string; displayName: string; server: string; port: number }>
  warnings: Array<{ code: string; message: string; line?: number }>
}

type SourceForm = {
  name: string
  type: CatalogSource['type']
  content: string
  url: string
  headers: string
  refreshIntervalMinutes: string
  enabled: boolean
  keepOnFailure: boolean
}

type PendingBatch = 'disable' | 'delete'

type SourceStatusFilter = 'all' | 'enabled' | 'disabled' | 'error'

const STATUS_FILTERS: Array<{ value: SourceStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '正常' },
  { value: 'disabled', label: '已停用' },
  { value: 'error', label: '需处理' },
]

const emptyForm = (): SourceForm => ({
  name: '',
  type: 'manual',
  content: '',
  url: '',
  headers: '',
  refreshIntervalMinutes: '60',
  enabled: true,
  keepOnFailure: true,
})

const sourceForm = (source: CatalogSource): SourceForm => ({
  name: source.name,
  type: source.type,
  content: '',
  url: '',
  headers: '',
  refreshIntervalMinutes: String(source.refreshIntervalMinutes ?? 60),
  enabled: source.enabled,
  keepOnFailure: source.keepOnFailure ?? true,
})

const EMPTY_SOURCES: CatalogSource[] = []
const EMPTY_NODES: CatalogNode[] = []
const KEEP_ON_FAILURE_LABEL = '拉取失败时保留节点'
const MAX_FILE_BYTES = 5 * 1024 * 1024

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError || cause instanceof Error ? cause.message : fallback
}

function statusTone(source: CatalogSource): StatusBadgeTone {
  if (source.lastErrorCode) return 'danger'
  return source.enabled ? 'success' : 'muted'
}

export function SourcesPage() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(() => peekApi<CatalogResponse>('/api/admin/catalog') ?? null)
  const [loading, setLoading] = useState(() => catalog === null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<SourceStatusFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<'create' | CatalogSource | null>(null)
  const [form, setForm] = useState<SourceForm>(emptyForm)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [drawerError, setDrawerError] = useState('')
  const [batchProgress, setBatchProgress] = useState('')
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const drawerTrigger = useRef<HTMLButtonElement | null>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/catalog') === undefined)
    setError('')
    try {
      await watchApi<CatalogResponse>('/api/admin/catalog', (next) => {
        setCatalog(next)
        setSelected((current) => {
          const retained = [...current].filter((id) => next.sources.some((source) => source.id === id))
          return retained.length === current.size ? current : new Set(retained)
        })
      })
    } catch (cause) {
      setWarning('')
      setError(errorMessage(cause, '加载来源失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const sources = catalog?.sources ?? EMPTY_SOURCES
  const nodes = catalog?.nodes ?? EMPTY_NODES
  const sourceNodeCounts = useMemo(() => {
    const counts = new Map(sources.map((source) => [source.id, 0]))
    for (const node of nodes) for (const id of node.sourceIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    return counts
  }, [nodes, sources])
  const filteredSources = useMemo(() => sources.filter((source) => {
    if (!matchesText(`${source.name} ${source.remoteHost ?? ''}`, query)) return false
    if (statusFilter === 'enabled' && !source.enabled) return false
    if (statusFilter === 'disabled' && source.enabled) return false
    if (statusFilter === 'error' && !source.lastErrorCode) return false
    return true
  }), [query, sources, statusFilter])

  useEffect(() => {
    const visible = new Set(filteredSources.map((source) => source.id))
    setSelected((current) => new Set([...current].filter((id) => visible.has(id))))
  }, [filteredSources])

  const closeDrawer = () => {
    if (busy || previewBusy) return
    setDrawer(null)
    setPreview(null)
    setDrawerError('')
  }

  const openCreate = () => {
    drawerTrigger.current = createButton.current
    setForm(emptyForm())
    setPreview(null)
    setDrawerError('')
    setDrawer('create')
  }

  const openEdit = (source: CatalogSource, trigger: HTMLButtonElement | null) => {
    drawerTrigger.current = trigger ?? createButton.current
    setForm(sourceForm(source))
    setPreview(null)
    setDrawerError('')
    setDrawer(source)
  }

  const updateForm = <K extends keyof SourceForm>(key: K, value: SourceForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    if (key === 'content') setPreview(null)
  }

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setDrawerError('')
    setPreview(null)
    if (file.size > MAX_FILE_BYTES) {
      setDrawerError('文件超过 5 MiB 大小限制')
      input.value = ''
      return
    }
    try {
      const content = await file.text()
      setForm((current) => ({ ...current, content }))
    } catch {
      setDrawerError('读取文件失败')
      input.value = ''
    }
  }

  const previewSource = async () => {
    if (!form.content.trim()) {
      setDrawerError('请先填写来源内容')
      return
    }
    setPreviewBusy(true)
    setDrawerError('')
    try {
      const result = await api<PreviewResult>('/api/admin/catalog/preview', {
        method: 'POST',
        body: jsonBody({ content: form.content }),
      })
      setPreview(result)
    } catch (cause) {
      setPreview(null)
      setDrawerError(errorMessage(cause, '预览来源失败'))
    } finally {
      setPreviewBusy(false)
    }
  }

  const saveSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setDrawerError('')
    if (!form.name.trim()) {
      setDrawerError('请输入来源名称')
      return
    }
    if (drawer === 'create' && form.type !== 'remote' && !preview) {
      setDrawerError('请先预览来源内容')
      return
    }
    setBusy(true)
    try {
      if (drawer === 'create') {
        const payload = form.type === 'remote'
          ? {
              type: 'remote' as const,
              name: form.name,
              url: form.url,
              headers: form.headers.trim() ? JSON.parse(form.headers) as Record<string, string> : {},
              refreshIntervalMinutes: Number(form.refreshIntervalMinutes),
              enabled: form.enabled,
            }
          : { type: form.type, name: form.name, content: form.content, enabled: form.enabled }
        const result = await api<{ success?: boolean }>('/api/admin/catalog/sources', { method: 'POST', body: jsonBody(payload) })
        setDrawer(null)
        setPreview(null)
        await load()
        if (form.type === 'remote' && result.success !== true) setWarning('来源已保存，但首次抓取失败，已保留来源')
        else toast.notify('来源已添加')
      } else {
        const sourceId = drawer?.id
        if (!sourceId) throw new Error('来源编辑状态已失效')
        const payload: Record<string, unknown> = { name: form.name, enabled: form.enabled }
        if (form.type === 'remote') {
          if (form.url.trim()) payload.url = form.url.trim()
          if (form.headers.trim()) {
            let parsed: unknown
            try {
              parsed = JSON.parse(form.headers)
            } catch {
              throw new Error('请求 Headers 必须是有效 JSON 对象')
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('请求 Headers 必须是 JSON 对象')
            }
            payload.headers = parsed
          }
          const refreshIntervalMinutes = Number(form.refreshIntervalMinutes)
          if (!Number.isInteger(refreshIntervalMinutes) || refreshIntervalMinutes < 15 || refreshIntervalMinutes % 15 !== 0) {
            throw new Error('刷新周期必须是 15 分钟的正整数倍')
          }
          payload.refreshIntervalMinutes = refreshIntervalMinutes
          payload.keepOnFailure = form.keepOnFailure
        } else if (form.content.trim()) payload.content = form.content
        await api(`/api/admin/catalog/sources/${sourceId}`, { method: 'PUT', body: jsonBody(payload) })
        setDrawer(null)
        setPreview(null)
        await load()
        toast.notify('来源已更新')
      }
    } catch (cause) {
      setWarning('')
      setDrawerError(errorMessage(cause, '保存来源失败'))
    } finally {
      setBusy(false)
    }
  }

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const executeBatch = async (action: PendingBatch | 'enable' | 'refresh') => {
    const ids = [...selected]
    if (!ids.length) return
    setPendingBatch(null)
    setBusy(true)
    setWarning('')
    const failed = new Set<string>()
    const failures: string[] = []
    try {
      for (const [index, id] of ids.entries()) {
        setBatchProgress(`正在处理 ${index + 1}/${ids.length}`)
        try {
          if (action === 'delete') await api(`/api/admin/catalog/sources/${id}`, { method: 'DELETE' })
          else if (action === 'refresh') {
            const result = await api<{ success?: boolean }>(`/api/admin/catalog/sources/${id}/refresh`, { method: 'POST' })
            if (result.success !== true) {
              failed.add(id)
              failures.push('刷新来源失败')
            }
          } else await api(`/api/admin/catalog/sources/${id}`, { method: 'PUT', body: jsonBody({ enabled: action === 'enable' }) })
        } catch (cause) {
          failed.add(id)
          failures.push(errorMessage(cause, '请求失败'))
        }
      }
      await load()
      setSelected(failed)
      if (failures.length) toast.notifyError(`${failures.length} 项未完成：${failures[0]}`)
      else toast.notify(action === 'delete' ? '来源已删除' : '批量操作已完成')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '批量操作失败'))
    } finally {
      setBusy(false)
      setBatchProgress('')
    }
  }

  const askBatch = (action: PendingBatch) => setPendingBatch(action)
  const batchActions: BatchAction[] = [
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => executeBatch('enable') },
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => askBatch('disable') },
    { key: 'refresh', label: '刷新', icon: RefreshCw, onClick: () => executeBatch('refresh') },
    { key: 'delete', label: '删除', icon: Trash2, tone: 'danger', onClick: () => askBatch('delete') },
  ]

  const columns: Array<DataTableColumn<CatalogSource>> = [
    {
      key: 'select',
      header: '选择',
      headerContent: <ResourceSelectAll label="选择全部来源" ids={filteredSources.map((row) => row.id)} selected={selected} disabled={busy} onChange={(checked) => setSelected(checked ? new Set(filteredSources.map((source) => source.id)) : new Set())} />,
      width: 40,
      render: (source) => <Checkbox type="checkbox" aria-label={`选择来源 ${source.name}`} checked={selected.has(source.id)} disabled={busy} onChange={() => toggleSelected(source.id)} />,
    },
    {
      key: 'name',
      header: '名称',
      render: (source) => <span className="resource-card-name"><strong>{source.name}</strong><span className="cell-note">{source.remoteHost || source.id}</span></span>,
    },
    { key: 'type', header: '类型', render: (source) => sourceTypeLabel(source.type) },
    { key: 'format', header: '格式', render: (source) => formatLabel(source.detectedFormat) },
    { key: 'nodes', header: '节点', render: (source) => sourceNodeCounts.get(source.id) ?? 0 },
    { key: 'status', header: '状态', render: (source) => <StatusBadge tone={statusTone(source)} size="sm">{sourceStatus(source)}</StatusBadge> },
    { key: 'lastSync', header: '最近同步', render: (source) => formatDate(source.lastSuccessAt) },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (source) => (
        <ResourceRowActions actions={[
          { label: '编辑', disabled: busy, onClick: (trigger) => openEdit(source, trigger) },
          ...(source.type === 'remote' ? [
            { label: '刷新', disabled: busy, onClick: () => executeSingleRefresh(source.id) },
            { label: KEEP_ON_FAILURE_LABEL, checked: source.keepOnFailure ?? true, disabled: busy, onClick: () => toggleKeepOnFailure(source) },
          ] : []),
          { label: '删除', danger: true, disabled: busy, onClick: () => { setSelected(new Set([source.id])); askBatch('delete') } },
        ]} />
      ),
    },
  ]

  return (
    <div className="page-stack resource-pages sources-page">
      <section className="sources-section" aria-labelledby="sources-title">
        <PageHeader id="sources-title" title="来源" />
        <FilterBar className="sources-toolbar">
          <SearchInput label="搜索来源" placeholder="搜索名称或主机" value={query} onChange={setQuery} />
          <label className="filter-field"><span className="sources-filter-label">状态</span><FormSelect aria-label="来源状态" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as SourceStatusFilter)}>{STATUS_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormSelect></label>
          <button ref={createButton} className="button primary sources-create" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加来源</button>
          {query || statusFilter !== 'all' ? <button className="button ghost" type="button" onClick={() => { setQuery(''); setStatusFilter('all') }}>重置筛选</button> : null}
        </FilterBar>
        {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
        {warning ? <StatusMessage tone="warning">{warning}</StatusMessage> : null}
        <BatchToolbar selectedCount={selected.size} totalCount={filteredSources.length} onSelectAll={() => setSelected(new Set(filteredSources.map((source) => source.id)))} onClear={() => setSelected(new Set())} actions={batchActions} busy={busy} progress={batchProgress} />
        {loading && !catalog ? (
          <LoadingState label="正在加载来源" />
        ) : sources.length === 0 ? (
          <EmptyState icon={Rss} title="暂无来源" />
        ) : (
          <DataTable className="sources-table" columns={columns} rows={filteredSources} rowKey={(source) => source.id} empty="暂无匹配来源" />
        )}
        <footer className="sources-footer">
          <span>共 {filteredSources.length} 个来源</span>
          {filteredSources.length !== sources.length ? <span>全部 {sources.length} 个来源</span> : null}
        </footer>
      </section>

      <EditDrawer open={drawer !== null} title={drawer === 'create' ? '添加来源' : '编辑来源'} busy={busy || previewBusy} onClose={closeDrawer} returnFocusRef={drawerTrigger}>
        {drawer && <form className="form-stack" onSubmit={saveSource}>
          <label className="field"><span>来源名称</span><Input aria-label="来源名称" value={form.name} maxLength={128} onChange={(event) => updateForm('name', event.currentTarget.value)} required /></label>
          {drawer === 'create' ? <label className="field"><span>来源类型</span><FormSelect aria-label="来源类型" value={form.type} onChange={(event) => { updateForm('type', event.currentTarget.value as CatalogSource['type']); setPreview(null) }}><option value="manual">手工</option><option value="file">文件</option><option value="remote">远程</option></FormSelect></label> : <p className="drawer-note">类型：{sourceTypeLabel(form.type)} · 编辑时只更新可安全修改的字段</p>}
          {form.type === 'remote' ? <>
            <label className="field"><span>远程 URL</span><Input aria-label="远程 URL" value={form.url} onChange={(event) => updateForm('url', event.currentTarget.value)} placeholder={drawer === 'create' ? 'https://example.com/source' : '留空保持当前 URL'} required={drawer === 'create'} /></label>
            <details className="sources-advanced" onInvalidCapture={(event) => { event.currentTarget.open = true }}>
              <summary>高级设置</summary>
              <label className="field"><span>请求 Headers（JSON）</span><Textarea aria-label="请求 Headers" value={form.headers} onChange={(event) => updateForm('headers', event.currentTarget.value)} placeholder={drawer === 'create' ? '{"User-Agent":"SubPanel"}' : '留空保持当前 Headers；填写 {} 可清空'} rows={3} /></label>
              <label className="field"><span>刷新周期（分钟）</span><Input aria-label="刷新周期" type="number" min={15} step={15} value={form.refreshIntervalMinutes} onChange={(event) => updateForm('refreshIntervalMinutes', event.currentTarget.value)} required /></label>
              {drawer !== 'create' && <Switch label={KEEP_ON_FAILURE_LABEL} checked={form.keepOnFailure} onChange={(checked) => updateForm('keepOnFailure', checked)} disabled={busy} />}
            </details>
          </> : <>
            {form.type === 'file' ? <label className="field"><span>来源文件</span><FileInput aria-label="来源文件" type="file" accept=".txt,.conf,.json,.yaml,.yml,text/plain,application/json,application/yaml,text/yaml" onChange={(event) => { loadFile(event).catch(() => setDrawerError('读取文件失败')) }} /></label> : null}
            <label className="field"><span>来源内容</span><Textarea aria-label="来源内容" value={form.content} onChange={(event) => updateForm('content', event.currentTarget.value)} rows={8} placeholder="粘贴订阅或节点内容" required={drawer === 'create'} /></label>
            <div className="drawer-inline-actions"><button className="button secondary" type="button" onClick={previewSource} disabled={previewBusy || busy}><FileUp aria-hidden="true" size={16} />{previewBusy ? '检测中' : '预览'}</button><span className="drawer-note">保存前会先验证可解析节点</span></div>
          </>}
          {drawer !== 'create' && <details className="sources-advanced">
            <summary>同步详情</summary>
            <p className="drawer-note">格式：{formatLabel(drawer.detectedFormat)} · 最近同步：{formatDate(drawer.lastSuccessAt)}</p>
          </details>}
          <Switch label="启用来源" checked={form.enabled} onChange={(checked) => updateForm('enabled', checked)} />
          {preview ? <section className="source-preview" aria-label="来源预览"><strong>检测到 {preview.nodes.length} 个节点</strong><span>格式：{formatLabel(preview.format)}</span>{preview.warnings.length ? <ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}{warning.line ? `（第 ${warning.line} 行）` : ''}</li>)}</ul> : null}</section> : null}
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions"><button className="button secondary" type="button" onClick={closeDrawer} disabled={busy || previewBusy}>取消</button><button className="button primary" type="submit" disabled={busy || previewBusy}>{busy ? '保存中' : drawer === 'create' ? '保存来源' : '保存修改'}</button></div>
        </form>}
      </EditDrawer>

      <ConfirmDialog open={pendingBatch !== null} title={pendingBatch === 'delete' ? '删除来源' : '停用来源'} description={pendingBatch === 'delete' ? `将删除选中的 ${selected.size} 个来源，并清理不再关联的节点` : `将停用选中的 ${selected.size} 个来源`} confirmLabel={pendingBatch === 'delete' ? '确认删除' : '确认停用'} danger busy={busy} onClose={() => setPendingBatch(null)} onConfirm={() => executeBatch(pendingBatch ?? 'delete')} />
    </div>
  )

  async function toggleKeepOnFailure(source: CatalogSource) {
    if (busy) return
    setBusy(true)
    setWarning('')
    try {
      await api(`/api/admin/catalog/sources/${source.id}`, {
        method: 'PUT',
        body: jsonBody({ keepOnFailure: !(source.keepOnFailure ?? true) }),
      })
      await load()
      toast.notify('来源已更新')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '保存来源失败'))
    } finally {
      setBusy(false)
    }
  }

  async function executeSingleRefresh(id: string) {
    if (busy) return
    setBusy(true)
    setWarning('')
    try {
      const result = await api<{ success: boolean }>('/api/admin/catalog/sources/' + id + '/refresh', { method: 'POST' })
      await load()
      if (result.success) toast.notify('来源已刷新')
      else setWarning('刷新来源失败')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '刷新来源失败'))
    } finally {
      setBusy(false)
    }
  }
}
