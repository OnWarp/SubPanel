import { CheckCircle2, FileUp, Pencil, Plus, RefreshCw, Search, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataHeader } from '../../ui/DataHeader'
import { PageHeader } from '../../ui/PageHeader'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { StatusMessage } from '../../ui/StatusMessage'
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

export function SourcesPage() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled' | 'error'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<'create' | CatalogSource | null>(null)
  const [form, setForm] = useState<SourceForm>(emptyForm)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [drawerError, setDrawerError] = useState('')
  const [batchProgress, setBatchProgress] = useState('')
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await api<CatalogResponse>('/api/admin/catalog')
      setCatalog(next)
      setSelected((current) => new Set([...current].filter((id) => next.sources.some((source) => source.id === id))))
    } catch (cause) {
      setMessage('')
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
        if (form.type === 'remote' && result.success !== true) {
          setMessage('')
          setWarning('来源已保存，但首次抓取失败，已保留来源')
        } else {
          setWarning('')
          setMessage('来源已添加')
        }
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
        setWarning('')
        setMessage('来源已更新')
      }
      setDrawer(null)
      setPreview(null)
      await load()
    } catch (cause) {
      setMessage('')
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
    setError('')
    setMessage('')
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
      if (failures.length) setError(`${failures.length} 项未完成：${failures[0]}`)
      else setMessage(action === 'delete' ? '来源已删除' : '批量操作已完成')
    } catch (cause) {
      setError(errorMessage(cause, '批量操作失败'))
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

  return (
    <div className="page-stack">
      <PageHeader title="来源" description={`${sources.length} 个来源`} actions={<button ref={createButton} className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加来源</button>} />

      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><button className="button secondary" type="button" onClick={() => load()}>重试</button></div> : null}
      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
      {warning ? <StatusMessage tone="warning">{warning}</StatusMessage> : null}
      <section className="data-section" aria-labelledby="sources-title">
        <DataHeader id="sources-title" title="来源列表" filters={<div className="data-header-filters" aria-label="来源筛选"><label className="search-field"><Search aria-hidden="true" size={15} /><span className="sr-only">搜索来源</span><input aria-label="搜索来源" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索名称或主机" /></label><label className="filter-field"><span>状态</span><select aria-label="来源状态" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as typeof statusFilter)}><option value="all">全部</option><option value="enabled">正常</option><option value="disabled">已停用</option><option value="error">需处理</option></select></label></div>} actions={<BatchToolbar selectedCount={selected.size} totalCount={filteredSources.length} onSelectAll={() => setSelected(new Set(filteredSources.map((source) => source.id)))} onClear={() => setSelected(new Set())} actions={batchActions} busy={busy} progress={batchProgress} />} />
        <div className="table-scroll">
          <table className="sources-table">
            <thead><tr><th className="check-cell"><input type="checkbox" aria-label="选择全部来源" checked={filteredSources.length > 0 && selected.size === filteredSources.length} disabled={busy} onChange={(event) => setSelected(event.currentTarget.checked ? new Set(filteredSources.map((source) => source.id)) : new Set())} /></th><th>名称</th><th>类型</th><th>格式</th><th>节点</th><th>状态</th><th>最近成功</th><th>最近尝试</th><th className="align-right">操作</th></tr></thead>
            <tbody>
              {loading && !catalog ? <tr><td colSpan={9} className="empty-row">正在加载来源</td></tr> : null}
              {!loading && filteredSources.length === 0 ? <tr><td colSpan={9} className="empty-row">暂无匹配来源</td></tr> : null}
              {filteredSources.map((source) => {
                const status = sourceStatus(source)
                return <tr key={source.id}>
                  <td className="check-cell"><input type="checkbox" aria-label={`选择来源 ${source.name}`} checked={selected.has(source.id)} disabled={busy} onChange={() => toggleSelected(source.id)} /></td>
                  <td><strong>{source.name}</strong>{source.remoteHost ? <span className="cell-note">{source.remoteHost}</span> : null}</td>
                  <td>{sourceTypeLabel(source.type)}</td>
                  <td>{formatLabel(source.detectedFormat)}</td>
                  <td>{sourceNodeCounts.get(source.id) ?? 0}</td>
                  <td><span className={`status ${status === '正常' ? 'success' : status === '需处理' ? 'warning' : 'muted'}`}><i />{status}</span></td>
                  <td>{formatDate(source.lastSuccessAt)}</td>
                  <td>{formatDate(source.lastAttemptAt)}</td>
                  <td className="align-right"><span className="row-actions"><button className="icon-button" type="button" aria-label="编辑" title="编辑" disabled={busy} onClick={() => openEdit(source)}><Pencil aria-hidden="true" size={16} /></button>{source.type === 'remote' ? <button className="icon-button" type="button" aria-label="刷新" title="刷新" disabled={busy} onClick={() => executeSingleRefresh(source.id)}><RefreshCw aria-hidden="true" size={16} /></button> : null}<button className="icon-button danger" type="button" aria-label="删除" title="删除" disabled={busy} onClick={() => { setSelected(new Set([source.id])); askBatch('delete') }}><Trash2 aria-hidden="true" size={16} /></button></span></td>
                </tr>
              })}
            </tbody>
          </table>
        </div>
      </section>

      <EditDrawer open={drawer !== null} title={drawer === 'create' ? '添加来源' : '编辑来源'} busy={busy || previewBusy} onClose={closeDrawer} returnFocusRef={createButton}>
        <form className="form-stack" onSubmit={saveSource}>
          <label className="field"><span>来源名称</span><input aria-label="来源名称" value={form.name} maxLength={128} onChange={(event) => updateForm('name', event.currentTarget.value)} required /></label>
          {drawer === 'create' ? <label className="field"><span>来源类型</span><select aria-label="来源类型" value={form.type} onChange={(event) => { updateForm('type', event.currentTarget.value as CatalogSource['type']); setPreview(null) }}><option value="manual">手工</option><option value="file">文件</option><option value="remote">远程</option></select></label> : <p className="drawer-note">类型：{sourceTypeLabel(form.type)}。编辑时只更新可安全修改的字段。</p>}
          {form.type === 'remote' ? <>
            <label className="field"><span>远程 URL</span><input aria-label="远程 URL" value={form.url} onChange={(event) => updateForm('url', event.currentTarget.value)} placeholder={drawer === 'create' ? 'https://example.com/source' : '留空保持当前 URL'} required={drawer === 'create'} /></label>
            <label className="field"><span>请求 Headers（JSON）</span><textarea aria-label="请求 Headers" value={form.headers} onChange={(event) => updateForm('headers', event.currentTarget.value)} placeholder={drawer === 'create' ? '{"User-Agent":"SubPanel"}' : '留空保持当前 Headers；填写 {} 可清空'} rows={3} /></label>
            <label className="field"><span>刷新周期（分钟）</span><input aria-label="刷新周期" type="number" min={15} step={15} value={form.refreshIntervalMinutes} onChange={(event) => updateForm('refreshIntervalMinutes', event.currentTarget.value)} required /></label>
          </> : <>
            {form.type === 'file' ? <label className="field"><span>来源文件</span><input aria-label="来源文件" type="file" accept=".txt,.conf,.json,.yaml,.yml,text/plain,application/json,application/yaml,text/yaml" onChange={(event) => { loadFile(event).catch(() => setDrawerError('读取文件失败')) }} /></label> : null}
            <label className="field"><span>来源内容</span><textarea aria-label="来源内容" value={form.content} onChange={(event) => updateForm('content', event.currentTarget.value)} rows={8} placeholder="粘贴订阅或节点内容" required={drawer === 'create'} /></label>
            <div className="drawer-inline-actions"><button className="button secondary" type="button" onClick={previewSource} disabled={previewBusy || busy}><FileUp aria-hidden="true" size={16} />{previewBusy ? '检测中' : '预览'}</button><span className="drawer-note">保存前会先验证可解析节点。</span></div>
          </>}
          <label className="toggle-field"><input type="checkbox" checked={form.enabled} onChange={(event) => updateForm('enabled', event.currentTarget.checked)} /><span>启用来源</span></label>
          {preview ? <section className="source-preview" aria-label="来源预览"><strong>检测到 {preview.nodes.length} 个节点</strong><span>格式：{formatLabel(preview.format)}</span>{preview.warnings.length ? <ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}{warning.line ? `（第 ${warning.line} 行）` : ''}</li>)}</ul> : null}</section> : null}
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions"><button className="button secondary" type="button" onClick={closeDrawer} disabled={busy || previewBusy}>取消</button><button className="button primary" type="submit" disabled={busy || previewBusy}>{busy ? '保存中' : drawer === 'create' ? '保存来源' : '保存修改'}</button></div>
        </form>
      </EditDrawer>

      <ConfirmDialog open={pendingBatch !== null} title={pendingBatch === 'delete' ? '删除来源' : '停用来源'} description={pendingBatch === 'delete' ? `将删除选中的 ${selected.size} 个来源，并清理不再关联的节点。` : `将停用选中的 ${selected.size} 个来源。`} confirmLabel={pendingBatch === 'delete' ? '确认删除' : '确认停用'} danger busy={busy} onClose={() => setPendingBatch(null)} onConfirm={() => executeBatch(pendingBatch ?? 'delete')} />
    </div>
  )

  async function executeSingleRefresh(id: string) {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    setWarning('')
    try {
      const result = await api<{ success: boolean }>('/api/admin/catalog/sources/' + id + '/refresh', { method: 'POST' })
      await load()
      if (result.success) setMessage('来源已刷新')
      else setWarning('刷新失败，已保留上次成功版本')
    } catch (cause) {
      setError(errorMessage(cause, '刷新来源失败'))
    } finally {
      setBusy(false)
    }
  }
}
