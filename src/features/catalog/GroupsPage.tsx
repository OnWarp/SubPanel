import { ResourceFooter, ResourceRowActions, ResourceSelectAll } from '../admin-resources/ResourceCard'
import { Checkbox, FormSelect, Input } from '../../ui/Controls'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody, type AdminSubscription, type CatalogGroup, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { PageHeader } from '../../ui/PageHeader'
import { FilterBar } from '../../ui/FilterBar'
import { SearchInput } from '../../ui/SearchInput'
import { StatusMessage } from '../../ui/StatusMessage'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Dialog } from '../../ui/Dialog'
import { useToast } from '../../ui/Toast'
import { catalogPreview, formatDate } from './catalog-utils'
import { groupNodeIds } from './catalog-counts'

type GroupForm = {
  name: string
  sourceIds: string[]
  includedNodeIds: string[]
  excludedNodeIds: string[]
  nodeOrder: string[]
  rules?: CatalogGroup['rules']
}

type RulePreview = {
  matched: number; disabled: number; incompatible: number; outputNodes: number; affectedSubscriptions: number
  nodes: Array<{ id: string; displayName: string }>
  entitlement?: { authorizedNodeIds: string[]; outputNodes: number; reason: string | null }
}
const previewClients = ['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic']
const splitRules = (text: string) => text.split(',').map((part) => part.trim()).filter(Boolean)

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
  const [catalog, setCatalog] = useState<CatalogResponse | null>(() => peekApi<CatalogResponse>('/api/admin/catalog') ?? null)
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [loading, setLoading] = useState(() => catalog === null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [batchError, setBatchError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [choosingNodes, setChoosingNodes] = useState(false)
  const [editing, setEditing] = useState<'create' | CatalogGroup | null>(null)
  const [form, setForm] = useState<GroupForm>(emptyForm)
  const [baseline, setBaseline] = useState(form)
  const [rulesPreview, setRulesPreview] = useState<RulePreview | null>(null)
  const [previewClient, setPreviewClient] = useState('mihomo')
  const [previewSubscription, setPreviewSubscription] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [drawerError, setDrawerError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [progress, setProgress] = useState('')
  const drawerTrigger = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/catalog') === undefined)
    setError('')
    try {
      await Promise.all([
        watchApi<CatalogResponse>('/api/admin/catalog', (next) => {
          setCatalog(next)
          setLoading(false)
          setSelected((current) => {
            const retained = [...current].filter((id) => next.groups.some((group) => group.id === id))
            return retained.length === current.size ? current : new Set(retained)
          })
        }),
        api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions')
          .then((result) => setSubscriptions(result.subscriptions)),
      ])
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

  useEffect(() => {
    const visible = new Set(filteredGroups.map((group) => group.id))
    setSelected((current) => new Set([...current].filter((id) => visible.has(id))))
  }, [filteredGroups])

  const openCreate = (event: React.MouseEvent<HTMLButtonElement>) => {
    drawerTrigger.current = event.currentTarget
    const draft = { ...emptyForm(), nodeOrder: nodes.map((node) => node.id) }
    setBaseline(draft)
    setForm(draft)
    setDrawerError('')
    setChoosingNodes(false)
    setEditing('create')
  }

  const openEdit = (group: CatalogGroup, trigger: HTMLButtonElement | null) => {
    drawerTrigger.current = trigger
    const draft = {
      name: group.name,
      rules: group.rules,
      sourceIds: [...group.sourceIds],
      includedNodeIds: [...group.includedNodeIds],
      excludedNodeIds: [...group.excludedNodeIds],
      nodeOrder: [...group.nodeOrder, ...nodes.map((node) => node.id).filter((id) => !group.nodeOrder.includes(id))],
    }
    setBaseline(draft)
    setForm(draft)
    setDrawerError('')
    setChoosingNodes(false)
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

  useEffect(() => {
    setRulesPreview(null)
    setPreviewError('')
    if (!editing || !form.name.trim()) return
    let active = true
    const timer = window.setTimeout(() => {
      void catalogPreview<RulePreview>('/api/admin/catalog/groups/preview', {
        input: form, groupId: editing === 'create' ? undefined : editing.id,
        client: previewClient, subscriptionId: previewSubscription || undefined,
      }).then((result) => { if (active) setRulesPreview(result) })
        .catch((cause) => { if (active) setPreviewError(errorMessage(cause, '无法预览，请检查分组规则')) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [editing, form, previewClient, previewSubscription])

  const saveGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing || busy || choosingNodes || !rulesPreview) return
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
    setBatchError('')
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
      if (firstFailure) setBatchError(`${failed.size} 项未完成：${firstFailure}`)
      else toast.notify('分组已删除')
    } catch (cause) {
      setBatchError(errorMessage(cause, '批量删除失败'))
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
      headerContent: <ResourceSelectAll label="选择全部分组" ids={filteredGroups.map((row) => row.id)} selected={selected} disabled={busy} onChange={(checked) => setSelected(checked ? new Set(filteredGroups.map((group) => group.id)) : new Set())} />,
      width: 40,
      render: (group) => <Checkbox type="checkbox" aria-label={`选择分组 ${group.name}`} checked={selected.has(group.id)} disabled={busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })} />,
    },
    { key: 'name', header: '名称', render: (group) => <span className="resource-card-name"><strong>{group.name}</strong><span className="cell-note">{group.id}</span></span> },
    { key: 'sources', width: '17%', header: '来源数', render: (group) => group.sourceIds.length },
    { key: 'nodes', width: '17%', header: '节点数', render: (group) => groupNodeCounts.get(group.id) ?? 0 },
    { key: 'included', hideBelow: 'desktop', header: '单独包含', render: (group) => group.includedNodeIds.length },
    { key: 'excluded', hideBelow: 'desktop', header: '排除', render: (group) => group.excludedNodeIds.length },
    { key: 'updated', hideBelow: 'tablet', header: '更新时间', render: (group) => formatDate(group.updatedAt) },
    {
      key: 'actions',
      width: 52,
      header: '操作',
      align: 'right',
      render: (group) => <ResourceRowActions actions={[{ label: '编辑', disabled: busy, onClick: (trigger) => openEdit(group, trigger) }]} />,
    },
  ]

  return (
    <div className="page-stack resource-pages">
      <section className="catalog-data-section" aria-labelledby="groups-title">
        <PageHeader id="groups-title" title="分组" actions={<button className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加分组</button>} />
        <FilterBar className="catalog-filters" searchRef={searchRef} onReset={query ? () => setQuery('') : undefined}>
          <SearchInput inputRef={searchRef} label="搜索名称" placeholder="搜索分组名称" value={query} onChange={setQuery} />
        </FilterBar>
        {error && <ErrorState message={error} onRetry={() => load()} />}
        {batchError && <ErrorState message={batchError} />}
        <BatchToolbar compact selectedCount={selected.size} totalCount={filteredGroups.length} onSelectAll={() => setSelected(new Set(filteredGroups.map((group) => group.id)))} onClear={() => { setSelected(new Set()); searchRef.current?.focus() }} actions={actions} busy={busy} progress={progress} />
        {!catalog && error ? null : !loading && groups.length === 0 ? (
          <EmptyState title="暂无分组"><button className="button secondary" type="button" onClick={openCreate} aria-label="创建首个分组">添加分组</button></EmptyState>
        ) : (
          <DataTable flat columns={columns} rows={filteredGroups} loadingLabel={loading && !catalog ? '正在加载分组' : undefined} rowKey={(group) => group.id} empty="暂无匹配分组" />
        )}
        <ResourceFooter count={filteredGroups.length} unit="个分组" />
      </section>

      <Dialog open={editing !== null} title={choosingNodes ? '选择关联节点' : editing === 'create' ? '添加分组' : '编辑分组'} busy={busy} focusStep={choosingNodes ? 'nodes' : 'details'} size={choosingNodes ? 'l' : 'm'} dirty={JSON.stringify(form) !== JSON.stringify(baseline)} onClose={closeEdit} returnFocusRef={drawerTrigger}
        footer={(cancel) => choosingNodes ? <button className="button primary" type="button" data-dialog-initial-focus onClick={() => setChoosingNodes(false)}>完成</button> : <>
          <button className="button secondary" type="button" disabled={busy} onClick={cancel}>取消</button>
          <button className="button primary" form="group-editor" type="submit" disabled={busy || !rulesPreview}>{busy ? '保存中' : editing === 'create' ? '保存分组' : '保存修改'}</button>
        </>}
      >
        <form id="group-editor" className="form-stack group-form" onSubmit={saveGroup}>
          <div className="form-stack" hidden={choosingNodes}>
            <label className="field"><span>分组名称</span><Input aria-label="分组名称" value={form.name} maxLength={128} onChange={(event) => { const name = event.currentTarget.value; setForm((current) => ({ ...current, name })) }} required /></label>

            <section className="form-stack" aria-label="分组规则预览">
              <strong>分组规则预览</strong>
              <label className="field"><span>目标客户端</span><FormSelect value={previewClient} onChange={(event) => setPreviewClient(event.currentTarget.value)}>{previewClients.map((client) => <option key={client}>{client}</option>)}</FormSelect></label>
              <label className="field"><span>订阅权限预览</span><FormSelect value={previewSubscription} onChange={(event) => setPreviewSubscription(event.currentTarget.value)}><option value="">选择订阅</option>{subscriptions.map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}</FormSelect></label>
              {rulesPreview && <>
                <p>命中 {rulesPreview.matched} · 已停用 {rulesPreview.disabled} · 不兼容 {rulesPreview.incompatible} · 可输出 {rulesPreview.outputNodes}</p>
                <p>预计影响 {rulesPreview.affectedSubscriptions} 个订阅</p>
                {rulesPreview.nodes.length > 0 && <details><summary>查看可输出节点与顺序</summary><ol>{rulesPreview.nodes.map((node) => <li key={node.id}>{node.displayName}</li>)}</ol></details>}
                {rulesPreview.entitlement && <p>启用节点 ∩ 订阅选择 ∩ 计划授权 · 授权 {rulesPreview.entitlement.authorizedNodeIds.length} · 输出 {rulesPreview.entitlement.outputNodes}
                  {rulesPreview.entitlement.reason ? ` · ${rulesPreview.entitlement.reason}` : ''}</p>}
              </>}
              {previewError && <StatusMessage tone="error">{previewError}</StatusMessage>}
              {!rulesPreview && !previewError && form.name.trim() && <p role="status">正在计算规则预览</p>}
            </section>
            <details>
              <summary>动态匹配</summary>
              <p className="drawer-note">动态条件需同时满足，命中结果与来源、指定节点合并，排除节点优先</p>
              {(['tags', 'protocols'] as const).map((key) => <label className="field" key={key}><span>{key === 'tags' ? '标签' : '协议'}（逗号分隔）</span>
                <Input key={editing === 'create' ? 'new' : editing?.id} defaultValue={form.rules?.[key]?.join(', ')} onChange={(event) => {
                  const values = splitRules(event.currentTarget.value)
                  setForm((current) => ({ ...current, rules: { ...current.rules, [key]: values } }))
                }} /></label>)}
              {(['region', 'namePattern'] as const).map((key) => <label className="field" key={key}><span>{key === 'region' ? '地区' : '名称正则'}</span>
                <Input value={form.rules?.[key] ?? ''} onChange={(event) => {
                  const value = event.currentTarget.value
                  setForm((current) => ({ ...current, rules: { ...current.rules, [key]: value } }))
                }} /></label>)}
            </details>
            <button className="button secondary" type="button" onClick={() => setChoosingNodes(true)}>选择关联节点</button>
          </div>
          <div className="form-stack" hidden={!choosingNodes}>
            <fieldset className="choice-section"><legend>包含来源</legend>{sources.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选包含来源" onClick={() => setForm((current) => ({ ...current, sourceIds: sources.map((source) => source.id) }))}>全选</button><button className="button secondary" type="button" aria-label="反选包含来源" onClick={() => setForm((current) => ({ ...current, sourceIds: sources.map((source) => source.id).filter((id) => !current.sourceIds.includes(id)) }))}>反选</button></div><div className="choice-list">{sources.map((source) => <label key={source.id} className="choice-row"><Checkbox type="checkbox" aria-label={`包含来源 ${source.name}`} checked={form.sourceIds.includes(source.id)} onChange={() => setForm((current) => ({ ...current, sourceIds: toggle(current.sourceIds, source.id) }))} /><span>{source.name}</span></label>)}</div></> : <p className="drawer-note">暂无来源</p>}</fieldset>

            <fieldset className="choice-section"><legend>单独包含节点</legend>{nodes.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选单独包含节点" onClick={() => setAllNodeChoices('includedNodeIds', false)}>全选</button><button className="button secondary" type="button" aria-label="反选单独包含节点" onClick={() => setAllNodeChoices('includedNodeIds', true)}>反选</button></div><div className="choice-list">{nodes.map((node) => <label key={node.id} className="choice-row"><Checkbox type="checkbox" aria-label={`单独包含节点 ${node.displayName}`} checked={form.includedNodeIds.includes(node.id)} onChange={() => setNodeChoice('includedNodeIds', node.id)} /><span>{node.displayName}</span></label>)}</div></> : <p className="drawer-note">暂无节点</p>}</fieldset>

            <fieldset className="choice-section"><legend>排除节点</legend>{nodes.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选排除节点" onClick={() => setAllNodeChoices('excludedNodeIds', false)}>全选</button><button className="button secondary" type="button" aria-label="反选排除节点" onClick={() => setAllNodeChoices('excludedNodeIds', true)}>反选</button></div><div className="choice-list">{nodes.map((node) => <label key={node.id} className="choice-row"><Checkbox type="checkbox" aria-label={`排除节点 ${node.displayName}`} checked={form.excludedNodeIds.includes(node.id)} onChange={() => setNodeChoice('excludedNodeIds', node.id)} /><span>{node.displayName}</span></label>)}</div></> : <p className="drawer-note">暂无节点</p>}</fieldset>

            <fieldset className="choice-section"><legend>节点顺序</legend>{form.nodeOrder.length ? <ol className="order-list">{form.nodeOrder.map((id, index) => <li key={id}><span>{nodeNames.get(id) ?? id}</span><span className="row-actions"><button className="icon-button" type="button" aria-label={`上移 ${nodeNames.get(id) ?? id}`} title="上移" disabled={index === 0} onClick={() => moveNode(id, -1)}><ArrowUp aria-hidden="true" size={15} /></button><button className="icon-button" type="button" aria-label={`下移 ${nodeNames.get(id) ?? id}`} title="下移" disabled={index === form.nodeOrder.length - 1} onClick={() => moveNode(id, 1)}><ArrowDown aria-hidden="true" size={15} /></button></span></li>)}</ol> : <p className="drawer-note">暂无节点</p>}</fieldset>
          </div>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
        </form>
      </Dialog>

      <ConfirmDialog open={confirmDelete} title="删除分组" description={`将删除选中的 ${selected.size} 个分组${affectedSubscriptions ? ` · 有 ${affectedSubscriptions} 个订阅引用这些分组` : ''}`} confirmLabel="确认删除" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={deleteSelected} />
    </div>
  )
}