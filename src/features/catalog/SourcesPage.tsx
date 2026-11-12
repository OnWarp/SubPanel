import { CheckCircle2, FileUp, Pencil, Plus, RefreshCw, Rss, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
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
})

const sourceForm = (source: CatalogSource): SourceForm => ({
  name: source.name,
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
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
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
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await api<CatalogResponse>('/api/admin/catalog')
      setCatalog(next)
      setSelected((current) => new Set([...current].filter((id) => next.sources.some((source) => source.id === id))))
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
    setForm(emptyForm())
    setPreview(null)
    setDrawerError('')
    setDrawer('create')
  }

  const openEdit = (source: CatalogSource) => {
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
              failures.push('刷新失败，已保留上次成功版本')
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
      width: 40,
      render: (source) => <input type="checkbox" aria-label={`选择来源 ${source.name}`} checked={selected.has(source.id)} disabled={busy} onChange={() => toggleSelected(source.id)} />,
    },
    {
      key: 'name',
      header: '名称',
      render: (source) => <><strong>{source.name}</strong>{source.remoteHost ? <span className="cell-note">{source.remoteHost}</span> : null}</>,
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
        <span className="row-actions">
          <button className="icon-button" type="button" aria-label="编辑" title="编辑" disabled={busy} onClick={() => openEdit(source)}><Pencil aria-hidden="true" size={16} /></button>
          {source.type === 'remote' ? <button className="icon-button" type="button" aria-label="刷新" title="刷新" disabled={busy} onClick={() => executeSingleRefresh(source.id)}><RefreshCw aria-hidden="true" size={16} /></button> : null}
          <button className="icon-button danger" type="button" aria-label="删除" title="删除" disabled={busy} onClick={() => { setSelected(new Set([source.id])); askBatch('delete') }}><Trash2 aria-hidden="true" size={16} /></button>
        </span>
      ),
    },
  ]

  return (
    <div className="page-stack">
      <PageHeader title="来源" description={`${sources.length} 个来源`} actions={<button ref={createButton} className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加来源</button>} />

      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
      {warning ? <StatusMessage tone="warning">{warning}</StatusMessage> : null}
      <section className="data-section cat-data-section" aria-labelledby="sources-title">
        <DataHeader
          id="sources-title"
          title="来源列表"
          filters={(
            <FilterBar className="data-header-filters cat-filter-bar">
              <SearchInput className="cat-filter-search" label="搜索来源" placeholder="搜索名称或主机" value={query} onChange={setQuery} />
              <div className="cat-chip-group" role="group" aria-label="来源状态">
                {STATUS_FILTERS.map((item) => (
                  <FilterChip key={item.value} active={statusFilter === item.value} onClick={() => setStatusFilter(item.value)}>{item.label}</FilterChip>
                ))}
              </div>
            </FilterBar>
          )}
          actions={<BatchToolbar selectedCount={selected.size} totalCount={filteredSources.length} onSelectAll={() => setSelected(new Set(filteredSources.map((source) => source.id)))} onClear={() => setSelected(new Set())} actions={batchActions} busy={busy} progress={batchProgress} />}
        />
        {loading && !catalog ? (
          <div className="cat-empty-wrap"><LoadingState label="正在加载来源" /></div>
        ) : sources.length === 0 ? (
          <div className="cat-empty-wrap"><EmptyState icon={Rss} title="暂无来源" description="添加来源后即可在这里查看节点来源状态" /></div>
        ) : (
          <>
            <div className="cat-table-tools">
              <label className="cat-select-all">
                <input type="checkbox" aria-label="选择全部来源" checked={filteredSources.length > 0 && selected.size === filteredSources.length} disabled={busy} onChange={(event) => setSelected(event.currentTarget.checked ? new Set(filteredSources.map((source) => source.id)) : new Set())} />
                <span>全选</span>
              </label>
            </div>
            <DataTable columns={columns} rows={filteredSources} rowKey={(source) => source.id} empty="暂无匹配来源" />
          </>
        )}
      </section>

      <EditDrawer open={drawer !== null} title={drawer === 'create' ? '添加来源' : '编辑来源'} busy={busy || previewBusy} onClose={closeDrawer} returnFocusRef={createButton}>
        <form className="form-stack" onSubmit={saveSource}>
          <label className="field"><span>来源名称</span><input aria-label="来源名称" value={form.name} maxLength={128} onChange={(event) => updateForm('name', event.currentTarget.value)} required /></label>
          {drawer === 'create' ? <label className="field"><span>来源类型</span><select aria-label="来源类型" value={form.type} onChange={(event) => { updateForm('type', event.currentTarget.value as CatalogSource['type']); setPreview(null) }}><option value="manual">手工</option><option value="file">文件</option><option value="remote">远程</option></select></label> : <p className="drawer-note">类型：{sourceTypeLabel(form.type)} · 编辑时只更新可安全修改的字段</p>}
          {form.type === 'remote' ? <>
            <label className="field"><span>远程 URL</span><input aria-label="远程 URL" value={form.url} onChange={(event) => updateForm('url', event.currentTarget.value)} placeholder={drawer === 'create' ? 'https://example.com/source' : '留空保持当前 URL'} required={drawer === 'create'} /></label>
            <label className="field"><span>请求 Headers（JSON）</span><textarea aria-label="请求 Headers" value={form.headers} onChange={(event) => updateForm('headers', event.currentTarget.value)} placeholder={drawer === 'create' ? '{"User-Agent":"SubPanel"}' : '留空保持当前 Headers；填写 {} 可清空'} rows={3} /></label>
            <label className="field"><span>刷新周期（分钟）</span><input aria-label="刷新周期" type="number" min={15} step={15} value={form.refreshIntervalMinutes} onChange={(event) => updateForm('refreshIntervalMinutes', event.currentTarget.value)} required /></label>
          </> : <>
            {form.type === 'file' ? <label className="field"><span>来源文件</span><input aria-label="来源文件" type="file" accept=".txt,.conf,.json,.yaml,.yml,text/plain,application/json,application/yaml,text/yaml" onChange={(event) => { loadFile(event).catch(() => setDrawerError('读取文件失败')) }} /></label> : null}
            <label className="field"><span>来源内容</span><textarea aria-label="来源内容" value={form.content} onChange={(event) => updateForm('content', event.currentTarget.value)} rows={8} placeholder="粘贴订阅或节点内容" required={drawer === 'create'} /></label>
            <div className="drawer-inline-actions"><button className="button secondary" type="button" onClick={previewSource} disabled={previewBusy || busy}><FileUp aria-hidden="true" size={16} />{previewBusy ? '检测中' : '预览'}</button><span className="drawer-note">保存前会先验证可解析节点</span></div>
          </>}
          <label className="toggle-field"><input type="checkbox" checked={form.enabled} onChange={(event) => updateForm('enabled', event.currentTarget.checked)} /><span>启用来源</span></label>
          {preview ? <section className="source-preview" aria-label="来源预览"><strong>检测到 {preview.nodes.length} 个节点</strong><span>格式：{formatLabel(preview.format)}</span>{preview.warnings.length ? <ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}{warning.line ? `（第 ${warning.line} 行）` : ''}</li>)}</ul> : null}</section> : null}
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions"><button className="button secondary" type="button" onClick={closeDrawer} disabled={busy || previewBusy}>取消</button><button className="button primary" type="submit" disabled={busy || previewBusy}>{busy ? '保存中' : drawer === 'create' ? '保存来源' : '保存修改'}</button></div>
        </form>
      </EditDrawer>

      <ConfirmDialog open={pendingBatch !== null} title={pendingBatch === 'delete' ? '删除来源' : '停用来源'} description={pendingBatch === 'delete' ? `将删除选中的 ${selected.size} 个来源，并清理不再关联的节点` : `将停用选中的 ${selected.size} 个来源`} confirmLabel={pendingBatch === 'delete' ? '确认删除' : '确认停用'} danger busy={busy} onClose={() => setPendingBatch(null)} onConfirm={() => executeBatch(pendingBatch ?? 'delete')} />
    </div>
  )

  async function executeSingleRefresh(id: string) {
    if (busy) return
    setBusy(true)
    setWarning('')
    try {
      const result = await api<{ success: boolean }>('/api/admin/catalog/sources/' + id + '/refresh', { method: 'POST' })
      await load()
      if (result.success) toast.notify('来源已刷新')
      else setWarning('刷新失败，已保留上次成功版本')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '刷新来源失败'))
    } finally {
      setBusy(false)
    }
  }
}
