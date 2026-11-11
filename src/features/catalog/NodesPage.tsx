import { CheckCircle2, Pencil, ShieldCheck, ShieldOff, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { useToast } from '../../ui/Toast'
import { formatDate, matchesText } from './catalog-utils'

type NodeForm = {
  displayName: string
  enabled: boolean
  retained: boolean
}

type BatchMutation = 'disable' | 'retain'
type DirectMutation = 'enable' | 'unretain'
type NodeRow = CatalogNode & { sequence: number }
type NodeStatusFilter = 'all' | 'enabled' | 'disabled'

const NODE_STATUS_FILTERS: Array<{ value: NodeStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '正常' },
  { value: 'disabled', label: '已停用' },
]

const EMPTY_NODES: CatalogNode[] = []
const EMPTY_SOURCES: CatalogSource[] = []

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function nodeStatus(node: CatalogNode): string {
  return node.enabled ? '正常' : '已停用'
}

export function NodesPage() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [protocol, setProtocol] = useState('all')
  const [sourceId, setSourceId] = useState('all')
  const [status, setStatus] = useState<NodeStatusFilter>('all')
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<CatalogNode | null>(null)
  const [nodeForm, setNodeForm] = useState<NodeForm>({ displayName: '', enabled: true, retained: false })
  const [drawerError, setDrawerError] = useState('')
  const [pending, setPending] = useState<BatchMutation | null>(null)
  const [progress, setProgress] = useState('')
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await api<CatalogResponse>('/api/admin/catalog')
      setCatalog(next)
      setSelected((current) => new Set([...current].filter((id) => next.nodes.some((node) => node.id === id))))
    } catch (cause) {
      setError(errorMessage(cause, '加载节点失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const nodes = catalog?.nodes ?? EMPTY_NODES
  const sources = catalog?.sources ?? EMPTY_SOURCES
  const sourceNames = useMemo(() => new Map(sources.map((source) => [source.id, source.name])), [sources])
  const protocols = useMemo(() => [...new Set(nodes.map((node) => node.protocol))].sort(), [nodes])
  const filteredNodes = useMemo(() => nodes.filter((node) => {
    if (!matchesText(`${node.displayName} ${node.server} ${node.protocol}`, query)) return false
    if (protocol !== 'all' && node.protocol !== protocol) return false
    if (sourceId !== 'all' && !node.sourceIds.includes(sourceId)) return false
    if (status === 'enabled' && !node.enabled) return false
    if (status === 'disabled' && node.enabled) return false
    return true
  }), [nodes, protocol, query, sourceId, status])
  const pageCount = Math.max(1, Math.ceil(filteredNodes.length / pageSize))
  const visibleNodes = useMemo(() => filteredNodes.slice((page - 1) * pageSize, page * pageSize), [filteredNodes, page, pageSize])
  const visibleRows = useMemo<NodeRow[]>(() => visibleNodes.map((node, index) => ({ ...node, sequence: (page - 1) * pageSize + index + 1 })), [page, pageSize, visibleNodes])

  useEffect(() => { setPage(1) }, [pageSize, protocol, query, sourceId, status])
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])

  useEffect(() => {
    const visible = new Set(filteredNodes.map((node) => node.id))
    setSelected((current) => new Set([...current].filter((id) => visible.has(id))))
  }, [filteredNodes])

  const openEdit = (node: CatalogNode) => {
    setEditing(node)
    setNodeForm({ displayName: node.displayName, enabled: node.enabled, retained: node.retained })
    setDrawerError('')
  }

  const closeEdit = () => {
    if (!busy) {
      setEditing(null)
      setDrawerError('')
    }
  }

  const saveNode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing) return
    setDrawerError('')
    if (!nodeForm.displayName.trim()) {
      setDrawerError('请输入节点名称')
      return
    }
    setBusy(true)
    try {
      await api(`/api/admin/catalog/nodes/${editing.id}`, {
        method: 'PATCH',
        body: jsonBody({ displayName: nodeForm.displayName, enabled: nodeForm.enabled, retained: nodeForm.retained }),
      })
      setEditing(null)
      await load()
      toast.notify('节点已更新')
    } catch (cause) {
      setDrawerError(errorMessage(cause, '保存节点失败'))
    } finally {
      setBusy(false)
    }
  }

  const executeBatch = async (action: BatchMutation | DirectMutation) => {
    const ids = [...selected]
    if (!ids.length) return
    setPending(null)
    setBusy(true)
    const failed = new Set<string>()
    let firstFailure = ''
    try {
      for (const [index, id] of ids.entries()) {
        setProgress(`正在处理 ${index + 1}/${ids.length}`)
        try {
          const patch = action === 'enable'
            ? { enabled: true }
            : action === 'disable'
              ? { enabled: false }
              : action === 'retain'
                ? { retained: true }
                : { retained: false }
          await api(`/api/admin/catalog/nodes/${id}`, { method: 'PATCH', body: jsonBody(patch) })
        } catch (cause) {
          failed.add(id)
          if (!firstFailure) firstFailure = errorMessage(cause, '请求失败')
        }
      }
      await load()
      setSelected(failed)
      if (firstFailure) toast.notifyError(`${failed.size} 项未完成：${firstFailure}`)
      else toast.notify('批量操作已完成')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '批量操作失败'))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const actions: BatchAction[] = [
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => executeBatch('enable') },
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => setPending('disable') },
    { key: 'retain', label: '保留', icon: ShieldCheck, onClick: () => setPending('retain') },
    { key: 'unretain', label: '取消保留', icon: ShieldOff, onClick: () => executeBatch('unretain') },
  ]

  const columns: Array<DataTableColumn<NodeRow>> = [
    {
      key: 'select',
      header: '选择',
      width: 40,
      render: (node) => <input type="checkbox" aria-label={`选择节点 ${node.displayName}`} checked={selected.has(node.id)} disabled={busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })} />,
    },
    { key: 'sequence', header: '序号', width: 60, render: (node) => node.sequence },
    { key: 'name', header: '名称', render: (node) => <strong>{node.displayName}</strong> },
    { key: 'protocol', header: '协议', render: (node) => <StatusBadge tone="info" size="xs">{node.protocol}</StatusBadge> },
    { key: 'server', header: '服务器', render: (node) => node.server },
    { key: 'port', header: '端口', render: (node) => node.port },
    { key: 'sources', header: '来源', render: (node) => node.sourceIds.map((id) => sourceNames.get(id) ?? id).join('、') || '手工保留' },
    { key: 'status', header: '状态', render: (node) => <StatusBadge tone={node.enabled ? 'success' : 'muted'} size="sm">{nodeStatus(node)}</StatusBadge> },
    { key: 'retained', header: '保留', render: (node) => node.retained ? '是' : '否' },
    { key: 'updated', header: '更新时间', render: (node) => formatDate(node.updatedAt) },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (node) => <button className="icon-button" type="button" aria-label="编辑" title="编辑" disabled={busy} onClick={() => openEdit(node)}><Pencil aria-hidden="true" size={16} /></button>,
    },
  ]

  const selectCurrentPage = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const node of visibleNodes) {
        if (checked) next.add(node.id)
        else next.delete(node.id)
      }
      return next
    })
  }

  return (
    <div className="page-stack">
      <PageHeader title="节点" description={`${nodes.length} 个节点 · ${nodes.filter((node) => node.enabled).length} 个启用`} />

      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
      <section className="data-section cat-data-section" aria-labelledby="nodes-title">
        <DataHeader
          id="nodes-title"
          title="节点列表"
          filters={(
            <FilterBar className="data-header-filters cat-filter-bar">
              <SearchInput className="cat-filter-search" label="搜索节点" placeholder="搜索名称、服务器或协议" value={query} onChange={setQuery} />
              <label className="filter-field"><span>协议</span><select aria-label="节点协议" value={protocol} onChange={(event) => setProtocol(event.currentTarget.value)}><option value="all">全部</option>{protocols.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label className="filter-field"><span>来源</span><select aria-label="节点来源" value={sourceId} onChange={(event) => setSourceId(event.currentTarget.value)}><option value="all">全部</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
              <div className="cat-chip-group" role="group" aria-label="节点状态">
                {NODE_STATUS_FILTERS.map((item) => (
                  <FilterChip key={item.value} active={status === item.value} onClick={() => setStatus(item.value)}>{item.label}</FilterChip>
                ))}
              </div>
            </FilterBar>
          )}
          actions={<BatchToolbar selectedCount={selected.size} totalCount={filteredNodes.length} onSelectAll={() => setSelected(new Set(filteredNodes.map((node) => node.id)))} onClear={() => setSelected(new Set())} actions={actions} busy={busy} progress={progress} />}
        />
        {loading && !catalog ? (
          <div className="cat-empty-wrap"><LoadingState label="正在加载节点" /></div>
        ) : nodes.length === 0 ? (
          <div className="cat-empty-wrap"><EmptyState title="暂无节点" description="来源导入节点后会在这里显示" /></div>
        ) : (
          <>
            <div className="cat-table-tools">
              <label className="cat-select-all">
                <input type="checkbox" aria-label="选择当前页节点" checked={visibleNodes.length > 0 && visibleNodes.every((node) => selected.has(node.id))} disabled={busy} onChange={(event) => selectCurrentPage(event.currentTarget.checked)} />
                <span>全选当前页</span>
              </label>
              <div className="cat-page-meta">
                <label><span>每页显示</span><select aria-label="每页显示" value={pageSize} onChange={(event) => setPageSize(Number(event.currentTarget.value))}>{[20, 50, 100, 200].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
                <span>第 {page} / {pageCount} 页 · 共 {filteredNodes.length} 项</span>
              </div>
            </div>
            <DataTable columns={columns} rows={visibleRows} rowKey={(node) => node.id} empty="暂无匹配节点" pagination={{ page, pageCount, onPageChange: setPage }} />
          </>
        )}
      </section>

      <EditDrawer open={editing !== null} title="编辑节点" busy={busy} size="compact" onClose={closeEdit}>
        <form className="form-stack" onSubmit={saveNode}>
          <label className="field"><span>节点名称</span><input aria-label="节点名称" value={nodeForm.displayName} maxLength={256} onChange={(event) => { const displayName = event.currentTarget.value; setNodeForm((current) => ({ ...current, displayName })) }} required /></label>
          <p className="drawer-note">服务器、协议和认证字段由来源内容决定</p>
          <label className="toggle-field"><input type="checkbox" checked={nodeForm.enabled} onChange={(event) => { const enabled = event.currentTarget.checked; setNodeForm((current) => ({ ...current, enabled })) }} /><span>启用节点</span></label>
          <label className="toggle-field"><input type="checkbox" checked={nodeForm.retained} onChange={(event) => { const retained = event.currentTarget.checked; setNodeForm((current) => ({ ...current, retained })) }} /><span>无来源时保留</span></label>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions"><button className="button secondary" type="button" onClick={closeEdit} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy ? '保存中' : '保存修改'}</button></div>
        </form>
      </EditDrawer>

      <ConfirmDialog open={pending !== null} title={pending === 'retain' ? '保留节点' : '停用节点'} description={pending === 'retain' ? `将保留选中的 ${selected.size} 个节点，即使来源后续移除它们` : `将停用选中的 ${selected.size} 个节点，它们不会出现在后续订阅中`} confirmLabel={pending === 'retain' ? '确认保留' : '确认停用'} danger={pending === 'disable'} busy={busy} onClose={() => setPending(null)} onConfirm={() => executeBatch(pending ?? 'disable')} />
    </div>
  )
}
