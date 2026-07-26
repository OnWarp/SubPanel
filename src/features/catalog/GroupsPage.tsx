import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type AdminSubscription, type CatalogGroup, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataHeader } from '../../ui/DataHeader'
import { PageHeader } from '../../ui/PageHeader'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { StatusMessage } from '../../ui/StatusMessage'
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
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<'create' | CatalogGroup | null>(null)
  const [form, setForm] = useState<GroupForm>(emptyForm)
  const [drawerError, setDrawerError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [progress, setProgress] = useState('')

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
      setMessage(editing === 'create' ? '分组已添加' : '分组已更新')
      await load()
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
    setError('')
    setMessage('')
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
      if (firstFailure) setError(`${failed.size} 项未完成：${firstFailure}`)
      else setMessage('分组已删除')
    } catch (cause) {
      setError(errorMessage(cause, '批量删除失败'))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const actions: BatchAction[] = [{ key: 'delete', label: '删除', icon: Trash2, tone: 'danger', onClick: () => setConfirmDelete(true) }]

  return (
    <div className="page-stack">
      <PageHeader title="分组" description={`${groups.length} 个分组 · 组合来源与节点生成订阅内容`} actions={<button className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加分组</button>} />

      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><button className="button secondary" type="button" onClick={() => load()}>重试</button></div> : null}
      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
      <section className="data-section" aria-labelledby="groups-title">
        <DataHeader id="groups-title" title="分组列表" actions={<BatchToolbar selectedCount={selected.size} totalCount={groups.length} onSelectAll={() => setSelected(new Set(groups.map((group) => group.id)))} onClear={() => setSelected(new Set())} actions={actions} busy={busy} progress={progress} />} />
        <div className="table-scroll">
          <table>
            <thead><tr><th className="check-cell"><input type="checkbox" aria-label="选择全部分组" checked={groups.length > 0 && selected.size === groups.length} disabled={busy} onChange={(event) => setSelected(event.currentTarget.checked ? new Set(groups.map((group) => group.id)) : new Set())} /></th><th>名称</th><th>来源数</th><th>节点数</th><th>单独包含</th><th>排除</th><th>更新时间</th><th className="align-right">操作</th></tr></thead>
            <tbody>
              {loading && !catalog ? <tr><td colSpan={8} className="empty-row">正在加载分组</td></tr> : null}
              {!loading && groups.length === 0 ? <tr><td colSpan={8} className="empty-row">暂无分组</td></tr> : null}
              {groups.map((group) => <tr key={group.id}>
                <td className="check-cell"><input type="checkbox" aria-label={`选择分组 ${group.name}`} checked={selected.has(group.id)} disabled={busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })} /></td>
                <td><strong>{group.name}</strong></td>
                <td>{group.sourceIds.length}</td>
                <td>{groupNodeCounts.get(group.id) ?? 0}</td>
                <td>{group.includedNodeIds.length}</td>
                <td>{group.excludedNodeIds.length}</td>
                <td>{formatDate(group.updatedAt)}</td>
                <td className="align-right"><span className="row-actions"><button className="icon-button" type="button" aria-label="编辑" title="编辑" disabled={busy} onClick={() => openEdit(group)}><Pencil aria-hidden="true" size={16} /></button><button className="icon-button danger" type="button" aria-label="删除" title="删除" disabled={busy} onClick={() => { setSelected(new Set([group.id])); setConfirmDelete(true) }}><Trash2 aria-hidden="true" size={16} /></button></span></td>
              </tr>)}
            </tbody>
          </table>
        </div>
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

      <ConfirmDialog open={confirmDelete} title="删除分组" description={`将删除选中的 ${selected.size} 个分组。${affectedSubscriptions ? `有 ${affectedSubscriptions} 个订阅会移除这些分组引用。` : ''}`} confirmLabel="确认删除" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={deleteSelected} />
    </div>
  )
}
