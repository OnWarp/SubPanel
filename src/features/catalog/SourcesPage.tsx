import { ResourceFooter, ResourceRowActions, ResourceSelectAll } from '../admin-resources/ResourceCard'
import { Checkbox, Input, FormSelect, Textarea, FileInput } from '../../ui/Controls'
import { CheckCircle2, FileUp, Plus, Trash2, XCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { Switch } from '../../ui/Switch'
import { ErrorState } from '../../ui/ErrorState'
import { PageHeader } from '../../ui/PageHeader'
import { FilterBar } from '../../ui/FilterBar'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge, type StatusBadgeTone } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Dialog } from '../../ui/Dialog'
import { useToast } from '../../ui/Toast'
import { formatDate, formatLabel, matchesText, sourceStatus, sourceTypeLabel } from './catalog-utils'

type PreviewResult = {
  format: string
  diff?: SyncPreview['diff']
  nodes: Array<{ protocol: string; displayName: string; server: string; port: number }>
  warnings: Array<{ code: string; message: string; line?: number }>
}

type SyncPreview = { id: string; format: string; diff: Record<'added' | 'updated' | 'missing' | 'duplicates' | 'skipped' | 'parseFailed', number> }
const diffLabels = [['added', '新增'], ['updated', '更新'], ['missing', '失效'], ['duplicates', '重复'],
  ['skipped', '跳过'], ['parseFailed', '解析失败']] as const

function DiffCounts({ diff }: { diff: SyncPreview['diff'] }) {
  return <dl className="catalog-sync-diff">{diffLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{diff[key]}</dd></div>)}</dl>
}

type SyncRun = { id: string; started_at: string; status: string; details: { errorCode?: string; added?: number; missing?: number; updated?: number; durationMs?: number; httpStatus?: number } }
const syncFormats = ['uri-list', 'base64-uri-list', 'mihomo', 'sing-box', 'sip008', 'loon', 'surge', 'quantumultx']

type SourceForm = {
  formatOverride: string
  name: string
  type: CatalogSource['type']
  content: string
  url: string
  headers: string
  refreshIntervalMinutes: string
  enabled: boolean
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
  formatOverride: '',
  type: 'manual',
  content: '',
  url: '',
  headers: '',
  refreshIntervalMinutes: '60',
  enabled: true,
})

const sourceForm = (source: CatalogSource): SourceForm => ({
  name: source.name,
  formatOverride: source.sync?.formatOverride ?? '',
  type: source.type,
  content: '',
  url: '',
  headers: '',
  refreshIntervalMinutes: String(source.refreshIntervalMinutes ?? 60),
  enabled: source.enabled,
})

const EMPTY_SOURCES: CatalogSource[] = []
const EMPTY_NODES: CatalogNode[] = []
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
  const [batchError, setBatchError] = useState('')
  const [warning, setWarning] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<SourceStatusFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<'create' | CatalogSource | null>(null)
  const [form, setForm] = useState<SourceForm>(emptyForm)
  const [previewContent, setPreviewContent] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const syncRequest = useRef(0)
  const syncQueue = useRef<CatalogSource[]>([])
  const [syncSource, setSyncSource] = useState<CatalogSource | null>(null)
  const [syncPreview, setSyncPreview] = useState<SyncPreview | null>(null)
  const [syncError, setSyncError] = useState('')
  const [syncRuns, setSyncRuns] = useState<SyncRun[] | null>(null)
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
    setPreviewContent('')
    setDrawerError('')
  }

  const openCreate = (event: React.MouseEvent<HTMLButtonElement>) => {
    drawerTrigger.current = event.currentTarget
    setForm(emptyForm())
    setPreview(null)
    setPreviewContent('')
    setDrawerError('')
    setDrawer('create')
  }

  const openEdit = (source: CatalogSource, trigger: HTMLButtonElement | null) => {
    drawerTrigger.current = trigger ?? createButton.current
    setForm(sourceForm(source))
    setPreview(null)
    setPreviewContent('')
    setDrawerError('')
    setDrawer(source)
    setSyncRuns(null)
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
    if (busy || previewBusy) return
    if (!form.content.trim()) {
      setDrawerError('请先填写来源内容')
      return
    }
    setPreviewBusy(true)
    setDrawerError('')
    try {
      const result = await api<PreviewResult>('/api/admin/catalog/preview', {
        method: 'POST',
        body: jsonBody({ content: form.content, sourceId: drawer === 'create' ? undefined : drawer?.id }),
      })
      setPreview(result)
      setPreviewContent(form.content)
    } catch (cause) {
      setPreview(null)
      setDrawerError(errorMessage(cause, '预览来源失败'))
    } finally {
      setPreviewBusy(false)
    }
  }

  const saveSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!drawer || busy || previewBusy) return
    setDrawerError('')
    if (!form.name.trim()) {
      setDrawerError('请输入来源名称')
      return
    }
    if (form.type !== 'remote' && (drawer === 'create' || form.content.trim()) && (!preview || previewContent !== form.content)) {
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
              formatOverride: form.formatOverride || undefined,
              enabled: form.enabled,
            }
          : { type: form.type, name: form.name, content: form.content, enabled: form.enabled }
        const result = await api<{ success?: boolean; source?: CatalogSource }>('/api/admin/catalog/sources', { method: 'POST', body: jsonBody(payload) })
        setDrawer(null)
        setPreview(null)
        await load()
        if (form.type === 'remote' && result.source) void executeSingleRefresh(result.source)
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
          if (form.formatOverride || drawer.sync?.formatOverride) payload.formatOverride = form.formatOverride || null
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

  const executeBatch = async (action: PendingBatch | 'enable') => {
    const ids = [...selected]
    if (!ids.length) return
    setPendingBatch(null)
    setBusy(true)
    setBatchError('')
    setWarning('')
    const failed = new Set<string>()
    const failures: string[] = []
    try {
      for (const [index, id] of ids.entries()) {
        setBatchProgress(`正在处理 ${index + 1}/${ids.length}`)
        try {
          if (action === 'delete') await api(`/api/admin/catalog/sources/${id}`, { method: 'DELETE' })
          else await api(`/api/admin/catalog/sources/${id}`, { method: 'PUT', body: jsonBody({ enabled: action === 'enable' }) })
        } catch (cause) {
          failed.add(id)
          failures.push(errorMessage(cause, '请求失败'))
        }
      }
      await load()
      setSelected(failed)
      if (failures.length) setBatchError(`${failures.length} 项未完成：${failures[0]}`)
      else toast.notify(action === 'delete' ? '来源已删除' : '批量操作已完成')
    } catch (cause) {
      setBatchError(errorMessage(cause, '批量操作失败'))
    } finally {
      setBusy(false)
      setBatchProgress('')
    }
  }

  const askBatch = (action: PendingBatch) => setPendingBatch(action)
  const batchActions: BatchAction[] = [
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => executeBatch('enable') },
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => askBatch('disable') },
    { key: 'delete', label: '删除', icon: Trash2, tone: 'danger', onClick: () => askBatch('delete') },
    { key: 'refresh', label: '刷新', icon: RefreshCw, onClick: () => {
      syncQueue.current = sources.filter((source) => selected.has(source.id) && source.type === 'remote')
      const first = syncQueue.current.shift()
      if (first) void executeSingleRefresh(first)
      else setBatchError('请选择远程订阅来源')
    } },
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
    { key: 'type', hideBelow: 'tablet', header: '类型', render: (source) => sourceTypeLabel(source.type) },
    { key: 'format', hideBelow: 'desktop', header: '格式', render: (source) => formatLabel(source.detectedFormat) },
    { key: 'nodes', width: '12%', header: '节点', render: (source) => sourceNodeCounts.get(source.id) ?? 0 },
    { key: 'status', width: '19%', header: '状态', render: (source) => <StatusBadge tone={statusTone(source)} size="sm">{sourceStatus(source)}</StatusBadge> },
    { key: 'lastSync', hideBelow: 'desktop', header: '最近同步', render: (source) => source.lastSuccessAt ? formatDate(source.lastSuccessAt) : null },
    {
      key: 'actions',
      width: 52,
      header: '操作',
      align: 'right',
      render: (source) => (
        <ResourceRowActions actions={[
          { label: '编辑', disabled: busy, onClick: (trigger) => openEdit(source, trigger) },
          ...(source.type === 'remote' ? [
            { label: '刷新', disabled: busy, onClick: (trigger: HTMLButtonElement | null) => { drawerTrigger.current = trigger; syncQueue.current = []; return executeSingleRefresh(source) } },
          ] : []),
          { label: '删除', danger: true, disabled: busy, onClick: () => { setSelected(new Set([source.id])); askBatch('delete') } },
        ]} />
      ),
    },
  ]

  return (
    <div className="page-stack resource-pages sources-page">
      <section className="catalog-data-section" aria-labelledby="sources-title">
        <PageHeader id="sources-title" title="来源" />
        <FilterBar className="catalog-filters sources-toolbar" searchRef={searchRef}
          onReset={query || statusFilter !== 'all' ? () => { setQuery(''); setStatusFilter('all') } : undefined}>
          <SearchInput inputRef={searchRef} label="搜索来源" placeholder="搜索名称或主机" value={query} onChange={setQuery} />
          <label className="filter-field"><span className="sources-filter-label">状态</span><FormSelect aria-label="来源状态" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as SourceStatusFilter)}>{STATUS_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormSelect></label>
          <button ref={createButton} className="button primary sources-create" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加来源</button>
        </FilterBar>
        {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
        {warning ? <StatusMessage tone="warning">{warning}</StatusMessage> : null}
        {batchError && <ErrorState message={batchError} />}
        <BatchToolbar compact selectedCount={selected.size} totalCount={filteredSources.length} onSelectAll={() => setSelected(new Set(filteredSources.map((source) => source.id)))} onClear={() => { setSelected(new Set()); searchRef.current?.focus() }} actions={batchActions} busy={busy} progress={batchProgress} />
        {!catalog && error ? null : !loading && sources.length === 0 ? (
          <EmptyState title="暂无来源"><button className="button secondary" type="button" onClick={openCreate} aria-label="创建首个来源">添加来源</button></EmptyState>
        ) : (
          <DataTable flat columns={columns} rows={filteredSources} loadingLabel={loading && !catalog ? '正在加载来源' : undefined} rowKey={(source) => source.id} empty="暂无匹配来源" />
        )}
        <ResourceFooter count={filteredSources.length} unit="个来源">
          {filteredSources.length !== sources.length && <span>全部 {sources.length} 个来源</span>}
        </ResourceFooter>
      </section>

      <Dialog open={drawer !== null} title={drawer === 'create' ? '添加来源' : '编辑来源'} size="l" busy={busy || previewBusy} onClose={closeDrawer} returnFocusRef={drawerTrigger}
        dirty={drawer !== null && JSON.stringify(form) !== JSON.stringify(drawer === 'create' ? emptyForm() : sourceForm(drawer))}
        footer={(requestClose) => <>
          <button className="button secondary" type="button" onClick={requestClose} disabled={busy || previewBusy}>取消</button>
          <button className="button primary" type="submit" form="source-editor-form" disabled={busy || previewBusy}>{busy ? '保存中' : drawer === 'create' ? '保存来源' : '保存修改'}</button>
        </>}
      >
        {drawer && <form id="source-editor-form" className="form-stack" onSubmit={saveSource}>
          <label className="field"><span>来源名称</span><Input aria-label="来源名称" value={form.name} maxLength={128} onChange={(event) => updateForm('name', event.currentTarget.value)} required /></label>
          {drawer === 'create' ? <label className="field"><span>来源类型</span><FormSelect aria-label="来源类型" value={form.type} onChange={(event) => { updateForm('type', event.currentTarget.value as CatalogSource['type']); setPreview(null) }}><option value="manual">手动文本</option><option value="file">文件导入</option><option value="remote">远程订阅</option></FormSelect></label> : <p className="drawer-note">类型：{sourceTypeLabel(form.type)}</p>}
          {form.type === 'remote' ? <>
            <label className="field"><span>远程 URL</span><Input aria-label="远程 URL" value={form.url} onChange={(event) => updateForm('url', event.currentTarget.value)} placeholder={drawer === 'create' ? 'https://example.com/source' : '留空保持当前 URL'} required={drawer === 'create'} /></label>
            <details className="sources-advanced" onInvalidCapture={(event) => { event.currentTarget.open = true }}>
              <summary>高级设置</summary>
              <label className="field"><span>导入格式</span><FormSelect value={form.formatOverride} onChange={(event) => updateForm('formatOverride', event.currentTarget.value)}><option value="">自动识别</option>{syncFormats.map((format) => <option key={format} value={format}>{formatLabel(format)}</option>)}</FormSelect></label>
              <label className="field"><span>请求 Headers（JSON）</span><Textarea aria-label="请求 Headers" value={form.headers} onChange={(event) => updateForm('headers', event.currentTarget.value)} placeholder={drawer === 'create' ? '{"User-Agent":"SubPanel"}' : '留空保持当前 Headers；填写 {} 可清空'} rows={3} /></label>
              <label className="field"><span>刷新周期（分钟）</span><Input aria-label="刷新周期" type="number" min={15} step={15} value={form.refreshIntervalMinutes} onChange={(event) => updateForm('refreshIntervalMinutes', event.currentTarget.value)} required /></label>
              <p className="drawer-note">同步失败时保留上次成功导入的节点</p>
            </details>
          </> : <>
            {form.type === 'file' ? <label className="field"><span>来源文件</span><FileInput aria-label="来源文件" type="file" accept=".txt,.conf,.json,.yaml,.yml,text/plain,application/json,application/yaml,text/yaml" onChange={(event) => { loadFile(event).catch(() => setDrawerError('读取文件失败')) }} /></label> : null}
            <label className="field"><span>来源内容</span><Textarea aria-label="来源内容" value={form.content} onChange={(event) => updateForm('content', event.currentTarget.value)} rows={8} placeholder="粘贴订阅或节点内容" required={drawer === 'create'} /></label>
            <div className="drawer-inline-actions"><button className="button secondary" type="button" onClick={previewSource} disabled={previewBusy || busy}><FileUp aria-hidden="true" size={16} />{previewBusy ? '检测中' : '预览'}</button></div>
          </>}
          {drawer !== 'create' && <details className="sources-advanced">
            <summary onClick={() => {
              if (drawer.type === 'remote') void api<{ runs: SyncRun[] }>(`/api/admin/catalog/sources/${drawer.id}/sync-runs`)
                .then(({ runs }) => setSyncRuns(runs)).catch((cause) => setDrawerError(errorMessage(cause, '加载同步记录失败')))
            }}>同步详情</summary>
            <p className="drawer-note">格式：{formatLabel(drawer.detectedFormat)} · 最近同步：{formatDate(drawer.lastSuccessAt)}</p>
            {drawer.sync?.firstFailureAt && <p>首次失败 {formatDate(drawer.sync.firstFailureAt)} · 连续失败 {drawer.sync.consecutiveFailures} 次</p>}
            <ul>{syncRuns?.map((run) => <li key={run.id}>{formatDate(run.started_at)} · {run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : '已取消'}
              {run.details.httpStatus && ` · HTTP ${run.details.httpStatus}`}{run.details.durationMs !== undefined && ` · ${run.details.durationMs} ms`}
              {run.details.errorCode && ` · ${run.details.errorCode}`}
              {run.details.added !== undefined && ` · 新增 ${run.details.added} / 更新 ${run.details.updated} / 失效 ${run.details.missing}`}
            </li>)}</ul>
          </details>}
          <Switch label="启用来源" checked={form.enabled} onChange={(checked) => updateForm('enabled', checked)} />
          {preview ? <section className="form-stack" aria-label="来源预览"><strong>检测到 {preview.nodes.length} 个节点</strong><span>格式：{formatLabel(preview.format)}</span>{preview.diff && <DiffCounts diff={preview.diff} />}{preview.warnings.length ? <ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}{warning.line ? `（第 ${warning.line} 行）` : ''}</li>)}</ul> : null}</section> : null}
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
        </form>}
      </Dialog>

      <Dialog open={syncSource !== null} title="同步差异预览" size="l" busy={busy} onClose={closeSync} returnFocusRef={drawerTrigger}
        footer={(requestClose) => <>
            <button className="button secondary" type="button" disabled={busy} onClick={requestClose}>取消</button>
            <button className="button primary" type="button" disabled={!syncPreview || busy} onClick={confirmSync}>确认同步</button>
        </>}
      >
        <div className="form-stack catalog-sync-form">
          <strong>{syncSource?.name}</strong>
          {syncError && <StatusMessage tone="error">{syncError}</StatusMessage>}
          {syncPreview ? <section className="form-stack" aria-label="同步差异">
            <span>识别格式 {formatLabel(syncPreview.format)}</span>
            <DiffCounts diff={syncPreview.diff} />
            <span>失效节点会保留 24 小时，在后续成功同步时清理</span>
          </section> : !syncError && <p role="status">正在获取差异</p>}
        </div>
      </Dialog>

      <ConfirmDialog open={pendingBatch !== null} title={pendingBatch === 'delete' ? '删除来源' : '停用来源'} description={pendingBatch === 'delete' ? `将删除选中的 ${selected.size} 个来源，并清理不再关联的节点` : `将停用选中的 ${selected.size} 个来源`} confirmLabel={pendingBatch === 'delete' ? '确认删除' : '确认停用'} danger busy={busy} onClose={() => setPendingBatch(null)} onConfirm={() => executeBatch(pendingBatch ?? 'delete')} />
    </div>
  )

  async function executeSingleRefresh(source: CatalogSource) {
    const request = ++syncRequest.current
    setSyncSource(source)
    setSyncError('')
    setSyncPreview(null)
    try {
      const result = await api<SyncPreview>(`/api/admin/catalog/sources/${source.id}/preview-diff`, { method: 'POST' })
      if (request === syncRequest.current) setSyncPreview(result)
    } catch (cause) {
      if (request === syncRequest.current) {
        setSyncError(errorMessage(cause, '刷新来源失败，请检查来源设置后重试'))
        await load()
      }
    }
  }

  function closeSync() {
    syncRequest.current++
    syncQueue.current = []
    if (syncSource && !syncError) {
      void api(`/api/admin/catalog/sources/${syncSource.id}/cancel-sync`, {
        method: 'POST', body: jsonBody({ previewId: syncPreview?.id }),
      }).catch(() => undefined)
    }
    setSyncSource(null)
  }

  async function confirmSync() {
    if (busy || !syncSource || !syncPreview) return
    setBusy(true)
    setSyncError('')
    try {
      await api(`/api/admin/catalog/sources/${syncSource.id}/confirm-sync`, {
        method: 'POST', body: jsonBody({ previewId: syncPreview.id }),
      })
      const next = syncQueue.current.shift()
      if (next) void executeSingleRefresh(next)
      else setSyncSource(null)
      await load()
      toast.notify('来源已刷新')
    } catch (cause) {
      setSyncError(errorMessage(cause, '同步失败，请重新预览'))
    } finally {
      setBusy(false)
    }
  }
}
