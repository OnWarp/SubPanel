import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type AdminSubscription, type CatalogGroup, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { SearchInput } from '../../ui/SearchInput'
import { StatusMessage } from '../../ui/StatusMessage'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { useToast } from '../../ui/Toast'
import { formatDate } from './catalog-utils'
import { groupNodeIds } from './catalog-counts'

type GroupForm = {
  name: string
  sourceIds: string[]
  includedNodeIds: string[]
  excludedNodeIds: string[]
  nodeOrder: string[]
}

const emptyForm = (): GroupForm => ({ name: '', sourceIds: [], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [] })
const EMPTY_GROUPS: CatalogGroup[] = []
const EMPTY_SOURCES: CatalogSource[] = []
const EMPTY_NODES: CatalogNode[] = []

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function toggle(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id]
}

export function GroupsPage() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<'create' | CatalogGroup | null>(null)
  const [form, setForm] = useState<GroupForm>(emptyForm)
  const [drawerError, setDrawerError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [progress, setProgress] = useState('')
  const [query, setQuery] = useState('')
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextCatalog, result] = await Promise.all([
        api<CatalogResponse>('/api/admin/catalog'),
        api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions'),
      ])
      setCatalog(nextCatalog)
      setSubscriptions(result.subscriptions)
      setSelected((current) => new Set([...current].filter((id) => nextCatalog.groups.some((group) => group.id === id))))
    } catch (cause) {
      setError(errorMessage(cause, '加载分组失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const groups = catalog?.groups ?? EMPTY_GROUPS
  const sources = catalog?.sources ?? EMPTY_SOURCES
  const nodes = catalog?.nodes ?? EMPTY_NODES
  const nodeNames = useMemo(() => new Map(nodes.map((node) => [node.id, node.displayName])), [nodes])
  const groupNodeCounts = useMemo(() => new Map(groups.map((group) => [group.id, groupNodeIds(group, sources, nodes).size])), [groups, nodes, sources])
  const affectedSubscriptions = useMemo(() => subscriptions.filter((subscription) => subscription.groupIds.some((id) => selected.has(id))).length, [selected, subscriptions])

  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return groups
    return groups.filter((group) => group.name.toLowerCase().includes(needle))
  }, [groups, query])

  const openCreate = () => {
    setForm({ ...emptyForm(), nodeOrder: nodes.map((node) => node.id) })
    setDrawerError('')
    setEditing('create')
  }

  const openEdit = (group: CatalogGroup) => {
    setForm({
      name: group.name,
      sourceIds: [...group.sourceIds],
      includedNodeIds: [...group.includedNodeIds],
      excludedNodeIds: [...group.excludedNodeIds],
      nodeOrder: [...group.nodeOrder, ...nodes.map((node) => node.id).filter((id) => !group.nodeOrder.includes(id))],
    })
    setDrawerError('')
    setEditing(group)
  }

  const closeEdit = () => {
    if (!busy) {
      setEditing(null)
      setDrawerError('')
    }
  }

  const setNodeChoice = (key: 'includedNodeIds' | 'excludedNodeIds', id: string) => {
    setForm((current) => {
      const other = key === 'includedNodeIds' ? 'excludedNodeIds' : 'includedNodeIds'
      const adding = !current[key].includes(id)
      return {
        ...current,
        [key]: toggle(current[key], id),
        [other]: adding ? current[other].filter((value) => value !== id) : current[other],
      }
    })
  }

  const setAllNodeChoices = (key: 'includedNodeIds' | 'excludedNodeIds', invert: boolean) => {
    setForm((current) => {
      const other = key === 'includedNodeIds' ? 'excludedNodeIds' : 'includedNodeIds'
      const next = invert ? nodes.map((node) => node.id).filter((id) => !current[key].includes(id)) : nodes.map((node) => node.id)
      return { ...current, [key]: next, [other]: current[other].filter((id) => !next.includes(id)) }
    })
  }

  const moveNode = (id: string, direction: -1 | 1) => {
    setForm((current) => {
      const index = current.nodeOrder.indexOf(id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.nodeOrder.length) return current
      const order = [...current.nodeOrder]
      ;[order[index], order[target]] = [order[target], order[index]]
      return { ...current, nodeOrder: order }
    })
  }

  const saveGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing) return
    setDrawerError('')
    if (!form.name.trim()) {
      setDrawerError('请输入分组名称')
      return
    }
    setBusy(true)
    try {
      const path = editing === 'create' ? '/api/admin/catalog/groups' : `/api/admin/catalog/groups/${editing.id}`
      await api(path, { method: editing === 'create' ? 'POST' : 'PUT', body: jsonBody(form) })
      setEditing(null)
      await load()
      toast.notify(editing === 'create' ? '分组已添加' : '分组已更新')
    } catch (cause) {
      setDrawerError(errorMessage(cause, '保存分组失败'))
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async () => {
    const ids = [...selected]
    if (!ids.length) return
    setConfirmDelete(false)
    setBusy(true)
    const failed = new Set<string>()
    let firstFailure = ''
    try {
      for (const [index, id] of ids.entries()) {
        setProgress(`正在删除 ${index + 1}/${ids.length}`)
        try {
          await api(`/api/admin/catalog/groups/${id}`, { method: 'DELETE' })
        } catch (cause) {
          failed.add(id)
          if (!firstFailure) firstFailure = errorMessage(cause, '删除失败')
        }
      }
      await load()
      setSelected(failed)
      if (firstFailure) toast.notifyError(`${failed.size} 项未完成：${firstFailure}`)
      else toast.notify('分组已删除')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '批量删除失败'))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const actions: BatchAction[] = [{ key: 'delete', label: '删除', icon: Trash2, tone: 'danger', onClick: () => setConfirmDelete(true) }]

  const columns: Array<DataTableColumn<CatalogGroup>> = [
    {
      key: 'select',
      header: '选择',
      width: 40,
      render: (group) => <input type="checkbox" aria-label={`选择分组 ${group.name}`} checked={selected.has(group.id)} disabled={busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })} />,
    },
    { key: 'name', header: '名称', render: (group) => <strong>{group.name}</strong> },
    { key: 'sources', header: '来源数', render: (group) => group.sourceIds.length },
    { key: 'nodes', header: '节点数', render: (group) => groupNodeCounts.get(group.id) ?? 0 },
    { key: 'included', header: '单独包含', render: (group) => group.includedNodeIds.length },
    { key: 'excluded', header: '排除', render: (group) => group.excludedNodeIds.length },
    { key: 'updated', header: '更新时间', render: (group) => formatDate(group.updatedAt) },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (group) => (
        <span className="row-actions">
          <button className="icon-button" type="button" aria-label="编辑" title="编辑" disabled={busy} onClick={() => openEdit(group)}><Pencil aria-hidden="true" size={16} /></button>
        </span>
      ),
    },
  ]

  return (
    <div className="page-stack">
      <PageHeader title="分组" actions={<button className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加分组</button>} />

      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}

      <FilterBar className="groups-filter-bar">
        <SearchInput label="搜索名称" placeholder="搜索分组名称" value={query} onChange={setQuery} />
      </FilterBar>

      <section className="data-section" aria-labelledby="groups-title">
        <DataHeader
          id="groups-title"
          title="分组列表"
          actions={<BatchToolbar selectedCount={selected.size} totalCount={filteredGroups.length} onSelectAll={() => setSelected(new Set(filteredGroups.map((group) => group.id)))} onClear={() => setSelected(new Set())} actions={actions} busy={busy} progress={progress} />}
        />
        {loading && !catalog ? (
          <div className="cat-empty-wrap"><LoadingState label="正在加载分组" /></div>
        ) : filteredGroups.length === 0 ? (
          <div className="cat-empty-wrap"><EmptyState title="暂无分组" description={query ? '换个关键词试试' : '创建分组后即可组合来源与节点'} /></div>
        ) : (
          <DataTable columns={columns} rows={filteredGroups} rowKey={(group) => group.id} empty="暂无匹配分组" />
        )}
      </section>

      <EditDrawer open={editing !== null} title={editing === 'create' ? '添加分组' : '编辑分组'} busy={busy} size="wide" onClose={closeEdit}>
        <form className="form-stack group-form" onSubmit={saveGroup}>
          <label className="field"><span>分组名称</span><input aria-label="分组名称" value={form.name} maxLength={128} onChange={(event) => { const name = event.currentTarget.value; setForm((current) => ({ ...current, name })) }} required /></label>

          <fieldset className="choice-section"><legend>包含来源</legend>{sources.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选包含来源" onClick={() => setForm((current) => ({ ...current, sourceIds: sources.map((source) => source.id) }))}>全选</button><button className="button secondary" type="button" aria-label="反选包含来源" onClick={() => setForm((current) => ({ ...current, sourceIds: sources.map((source) => source.id).filter((id) => !current.sourceIds.includes(id)) }))}>反选</button></div><div className="choice-list">{sources.map((source) => <label key={source.id} className="choice-row"><input type="checkbox" aria-label={`包含来源 ${source.name}`} checked={form.sourceIds.includes(source.id)} onChange={() => setForm((current) => ({ ...current, sourceIds: toggle(current.sourceIds, source.id) }))} /><span>{source.name}</span></label>)}</div></> : <p className="drawer-note">暂无来源</p>}</fieldset>

          <fieldset className="choice-section"><legend>单独包含节点</legend>{nodes.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选单独包含节点" onClick={() => setAllNodeChoices('includedNodeIds', false)}>全选</button><button className="button secondary" type="button" aria-label="反选单独包含节点" onClick={() => setAllNodeChoices('includedNodeIds', true)}>反选</button></div><div className="choice-list">{nodes.map((node) => <label key={node.id} className="choice-row"><input type="checkbox" aria-label={`单独包含节点 ${node.displayName}`} checked={form.includedNodeIds.includes(node.id)} onChange={() => setNodeChoice('includedNodeIds', node.id)} /><span>{node.displayName}</span></label>)}</div></> : <p className="drawer-note">暂无节点</p>}</fieldset>

          <fieldset className="choice-section"><legend>排除节点</legend>{nodes.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选排除节点" onClick={() => setAllNodeChoices('excludedNodeIds', false)}>全选</button><button className="button secondary" type="button" aria-label="反选排除节点" onClick={() => setAllNodeChoices('excludedNodeIds', true)}>反选</button></div><div className="choice-list">{nodes.map((node) => <label key={node.id} className="choice-row"><input type="checkbox" aria-label={`排除节点 ${node.displayName}`} checked={form.excludedNodeIds.includes(node.id)} onChange={() => setNodeChoice('excludedNodeIds', node.id)} /><span>{node.displayName}</span></label>)}</div></> : <p className="drawer-note">暂无节点</p>}</fieldset>

          <fieldset className="choice-section"><legend>节点顺序</legend>{form.nodeOrder.length ? <ol className="order-list">{form.nodeOrder.map((id, index) => <li key={id}><span>{nodeNames.get(id) ?? id}</span><span className="row-actions"><button className="icon-button" type="button" aria-label={`上移 ${nodeNames.get(id) ?? id}`} title="上移" disabled={index === 0} onClick={() => moveNode(id, -1)}><ArrowUp aria-hidden="true" size={15} /></button><button className="icon-button" type="button" aria-label={`下移 ${nodeNames.get(id) ?? id}`} title="下移" disabled={index === form.nodeOrder.length - 1} onClick={() => moveNode(id, 1)}><ArrowDown aria-hidden="true" size={15} /></button></span></li>)}</ol> : <p className="drawer-note">暂无节点</p>}</fieldset>

          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions"><button className="button secondary" type="button" onClick={closeEdit} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy ? '保存中' : editing === 'create' ? '保存分组' : '保存修改'}</button></div>
        </form>
      </EditDrawer>

      <ConfirmDialog open={confirmDelete} title="删除分组" description={`将删除选中的 ${selected.size} 个分组${affectedSubscriptions ? ` · 有 ${affectedSubscriptions} 个订阅会移除这些分组引用` : ''}`} confirmLabel="确认删除" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={deleteSelected} />
    </div>
  )
}