import { PageContainer } from '../../ui/PageContainer'
import { AdminModuleTabs } from '../admin-resources/AdminModuleTabs'
import { Button } from '../../ui/Button'
import { ResourceRowActions, ResourceSelectAll } from '../admin-resources/ResourceCard'
import { Checkbox, FormSelect, Input, Textarea } from '../../ui/Controls'
import { CheckCircle2, Plus, ShieldCheck, ShieldOff, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody, type CatalogNode, type CatalogResponse, type CatalogSource } from '../../app/api'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { Switch } from '../../ui/Switch'
import { ErrorState } from '../../ui/ErrorState'
import { PageHeader } from '../../ui/PageHeader'
import { FilterBar } from '../../ui/FilterBar'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DetailList } from '../../ui/DetailList'
import { PasswordInput } from '../../ui/PasswordInput'
import { Dialog } from '../../ui/Dialog'
import { HintTip } from '../../ui/HintTip'
import { Link } from 'react-router-dom'
import { useToast } from '../../ui/Toast'
import { groupNodeIds } from './catalog-counts'
import { catalogPreview, formatDate, matchesText } from './catalog-utils'

const protocolsSupported = ['shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2',
  'tuic', 'wireguard', 'anytls', 'naive', 'snell', 'shadowtls', 'http', 'https', 'socks5']
const credentialKeys: Record<string, string[]> = {
  shadowsocks: ['method', 'password'], ss2022: ['method', 'password'], ssr: ['method', 'password', 'protocol', 'obfs'],
  vmess: ['uuid'], vless: ['uuid'], trojan: ['password'], hysteria: ['auth'], hysteria2: ['password'], anytls: ['password'],
  tuic: ['uuid', 'password'], wireguard: ['privateKey', 'publicKey'],
  naive: ['username', 'password'], snell: ['psk', 'version'], shadowtls: ['password'],
  http: ['username', 'password'], https: ['username', 'password'], socks5: ['username', 'password'],
}
type NodeDetails = { credentials: Record<string, unknown>; tls?: unknown; transport?: unknown; plugin?: unknown; extensions: unknown; rawVariants: unknown[] }
type NodeForm = {
  protocol: string
  server: string
  port: string
  tags: string
  region: string
  displayName: string
  enabled: boolean
  retained: boolean
}

const batchActions = {
  enable: { label: '启用', impact: '重新参与订阅分发，仍受来源和分组规则限制' },
  disable: { label: '停用', impact: '从后续订阅交付中移除' },
  retain: { label: '保留', impact: '失去最后一个来源后仍保留' },
  unretain: { label: '取消保留', impact: '失去最后一个来源后可被清理' },
}
type BatchMutation = keyof typeof batchActions
type NodeRow = CatalogNode & { sequence: number }
type NodeStatusFilter = 'all' | 'enabled' | 'disabled'

const NODE_STATUS_FILTERS: Array<{ value: NodeStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '启用' },
  { value: 'disabled', label: '已停用' },
]

const EMPTY_NODES: CatalogNode[] = []
const EMPTY_SOURCES: CatalogSource[] = []

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function nodeStatus(node: CatalogNode): string {
  return node.enabled ? node.missingSince ? '待失效' : '启用' : '已停用'
}

export function NodesPage() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(() => peekApi<CatalogResponse>('/api/admin/catalog') ?? null)
  const [loading, setLoading] = useState(() => catalog === null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [batchError, setBatchError] = useState('')
  const editorTrigger = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [protocol, setProtocol] = useState('all')
  const [sourceId, setSourceId] = useState('all')
  const [status, setStatus] = useState<NodeStatusFilter>('all')
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<CatalogNode | null>(null)
  const [nodeForm, setNodeForm] = useState<NodeForm>({ displayName: '', enabled: true, retained: false, protocol: '', server: '', port: '', tags: '', region: '' })
  const [nodeBaseline, setNodeBaseline] = useState<NodeForm>(nodeForm)
  const [adding, setAdding] = useState(false)
  const [connection, setConnection] = useState<NodeDetails | null>(null)
  const [invalidFields, setInvalidFields] = useState<string[]>([])
  const [connectionDirty, setConnectionDirty] = useState(false)
  const [testClient, setTestClient] = useState('mihomo')
  const [testResult, setTestResult] = useState<{ outputNodes: number; body: string; diagnostics: Array<{ code: string; message: string }> } | null>(null)
  const [editorError, setEditorError] = useState('')
  const [detail, setDetail] = useState<CatalogNode | null>(null)
  const [groupId, setGroupId] = useState('all')
  const [pending, setPending] = useState<BatchMutation | null>(null)
  const [progress, setProgress] = useState('')
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/catalog') === undefined)
    setError('')
    try {
      await watchApi<CatalogResponse>('/api/admin/catalog', (next) => {
        setCatalog(next)
        setSelected((current) => {
          const retained = [...current].filter((id) => next.nodes.some((node) => node.id === id))
          return retained.length === current.size ? current : new Set(retained)
        })
      })
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
  const groups = catalog?.groups
  const groupMembers = useMemo(() => groups?.map((group) => ({
    id: group.id, name: group.name, members: groupNodeIds(group, sources, nodes),
  })) ?? [], [groups, sources, nodes])
  const groupNames = (node: CatalogNode) => groupMembers.filter(({ members }) => members.has(node.id)).map(({ name }) => name).join('、') || '—'
  const filteredNodes = useMemo(() => nodes.filter((node) => {
    if (!matchesText(`${node.displayName} ${node.server} ${node.protocol}`, query)) return false
    if (protocol !== 'all' && node.protocol !== protocol) return false
    if (sourceId !== 'all' && !node.sourceIds.includes(sourceId)) return false
    if (groupId !== 'all' && !groupMembers.some(({ id, members }) => id === groupId && members.has(node.id))) return false
    if (status === 'enabled' && !node.enabled) return false
    if (status === 'disabled' && node.enabled) return false
    return true
  }), [groupId, groupMembers, nodes, protocol, query, sourceId, status])
  const pageCount = Math.max(1, Math.ceil(filteredNodes.length / pageSize))
  const visibleNodes = useMemo(() => filteredNodes.slice((page - 1) * pageSize, page * pageSize), [filteredNodes, page, pageSize])
  const visibleRows = useMemo<NodeRow[]>(() => visibleNodes.map((node, index) => ({ ...node, sequence: (page - 1) * pageSize + index + 1 })), [page, pageSize, visibleNodes])

  useEffect(() => { setPage(1) }, [groupId, pageSize, protocol, query, sourceId, status])
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])

  useEffect(() => {
    const visible = new Set(filteredNodes.map((node) => node.id))
    setSelected((current) => new Set([...current].filter((id) => visible.has(id))))
  }, [filteredNodes])

  const openEdit = (node: CatalogNode, trigger: HTMLButtonElement | null) => {
    editorTrigger.current = trigger
    setDetail(null)
    setEditing(node)
    setAdding(false)
    setTestResult(null)
    setConnection(null)
    setConnectionDirty(false)
    setInvalidFields([])
    const baseline = { displayName: node.displayName, enabled: node.enabled, retained: node.retained,
      protocol: node.protocol, server: node.server, port: String(node.port), tags: node.tags?.join(', ') ?? '', region: node.region ?? '' }
    setNodeBaseline(baseline)
    setNodeForm(baseline)
    setEditorError('')
  }

  useEffect(() => {
    if (!editing) return
    let active = true
    void catalogPreview<NodeDetails>(`/api/admin/catalog/nodes/${editing.id}/details`, {})
      .then((details) => { if (active) setConnection(details) }).catch(() => { if (active) setEditorError('加载连接参数失败，请关闭后重新打开') })
    return () => { active = false }
  }, [editing])

  function openCreate(trigger: HTMLButtonElement) {
    editorTrigger.current = trigger
    setEditing(null)
    setAdding(true)
    setEditorError('')
    setTestResult(null)
    setConnectionDirty(true)
    setInvalidFields([])
    setConnection({ credentials: {}, extensions: {}, rawVariants: [] })
    const baseline = { displayName: '', enabled: true, retained: true, protocol: '', server: '', port: '', tags: '', region: '' }
    setNodeBaseline(baseline)
    setNodeForm(baseline)
  }

  const closeEdit = () => {
    if (!busy) {
      setEditing(null)
      setAdding(false)
      setConnection(null)
      setTestResult(null)
      setEditorError('')
    }
  }

  const saveNode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || invalidFields.length || (!editing && !adding)) return
    setEditorError('')
    if (!nodeForm.displayName.trim()) {
      setEditorError('请输入节点名称')
      return
    }
    setBusy(true)
    try {
      const { displayName, enabled, retained, protocol, server, port, tags, region } = nodeForm
      await api(editing ? `/api/admin/catalog/nodes/${editing.id}` : '/api/admin/catalog/nodes', {
        method: editing ? 'PATCH' : 'POST',
        body: jsonBody({ displayName, enabled, retained, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), region,
          ...(connectionDirty ? { protocol, server, port: Number(port), credentials: connection?.credentials,
            tls: connection?.tls, transport: connection?.transport, plugin: connection?.plugin, extensions: connection?.extensions } : {}) }),
      })
      setEditing(null)
      setAdding(false)
      setConnection(null)
      setTestResult(null)
      await load()
      toast.notify('节点已更新')
    } catch (cause) {
      setEditorError(errorMessage(cause, '保存节点失败'))
    } finally {
      setBusy(false)
    }
  }

  async function copyNode() {
    if (!editing) return
    setBusy(true)
    try {
      await api('/api/admin/catalog/nodes', { method: 'POST', body: jsonBody({ originNodeId: editing.id, displayName: `${editing.displayName} 副本` }) })
      setEditing(null)
      setConnection(null)
      setTestResult(null)
      await load()
      toast.notify('节点副本已添加')
    } catch (cause) {
      setEditorError(errorMessage(cause, '复制节点失败'))
    } finally {
      setBusy(false)
    }
  }

  async function testOutput() {
    if (!editing) return
    setEditorError('')
    try {
      setTestResult(await catalogPreview(`/api/admin/catalog/nodes/${editing.id}/test-output`, { client: testClient }))
    } catch (cause) {
      setEditorError(errorMessage(cause, '转换测试失败'))
    }
  }

  function updateJsonField(key: 'tls' | 'transport' | 'extensions' | 'plugin', input: HTMLTextAreaElement) {
    try {
      const value: unknown = JSON.parse(input.value || '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_OBJECT')
      setConnection((current) => current && { ...current, [key]: value })
      setInvalidFields((current) => current.filter((field) => field !== key))
      setConnectionDirty(true)
    } catch {
      setInvalidFields((current) => current.includes(key) ? current : [...current, key])
    }
  }

  const executeBatch = async (action: BatchMutation) => {
    const ids = [...selected]
    if (!ids.length) return
    setPending(null)
    setBusy(true)
    setBatchError('')
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
      if (firstFailure) setBatchError(`${failed.size} 项未完成：${firstFailure}`)
      else toast.notify('批量操作已完成')
    } catch (cause) {
      setBatchError(errorMessage(cause, '批量操作失败'))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const actions: BatchAction[] = [
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => setPending('enable') },
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => setPending('disable') },
    { key: 'retain', label: '保留', icon: ShieldCheck, onClick: () => setPending('retain') },
    { key: 'unretain', label: '取消保留', icon: ShieldOff, onClick: () => setPending('unretain') },
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

  const columns: Array<DataTableColumn<NodeRow>> = [
    {
      key: 'select',
      header: '选择',
      headerContent: <ResourceSelectAll label="选择当前页节点" ids={visibleNodes.map((row) => row.id)} selected={selected} disabled={busy} onChange={(checked) => selectCurrentPage(checked)} />,
      width: 40,
      render: (node) => <Checkbox type="checkbox" aria-label={`选择节点 ${node.displayName}`} checked={selected.has(node.id)} disabled={busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })} />,
    },
    { key: 'sequence', hideBelow: 'tablet', header: '序号', width: 60, render: (node) => node.sequence },
    { key: 'name', header: '名称', render: (node) => <span className="resource-card-name"><strong>{node.displayName}</strong><span className="cell-note">{node.server} · {node.port}{node.duplicateAcrossSources ? ' · 跨来源疑似重复' : ''}</span></span> },
    { key: 'protocol', width: '15%', header: '协议', render: (node) => <StatusBadge tone="info" size="xs">{node.protocol}</StatusBadge> },
    { key: 'sources', hideBelow: 'tablet', header: '来源', render: (node) => node.sourceIds.map((id) => sourceNames.get(id) ?? id).join('、') || '手工保留' },
    { key: 'status', width: '17%', header: '状态', render: (node) => <StatusBadge tone={node.enabled ? 'success' : 'muted'} size="sm">{nodeStatus(node)}</StatusBadge> },
    { key: 'groups', hideBelow: 'tablet', header: '分组', render: (node) => groupNames(node) },
    { key: 'updated', hideBelow: 'desktop', header: '最后同步', render: (node) => formatDate(node.lastSeenAt) },
    {
      key: 'actions',
      width: 52,
      header: '操作',
      align: 'right',
      render: (node) => <ResourceRowActions actions={[
        { label: '查看', onClick: (trigger) => { editorTrigger.current = trigger; setDetail(node) } },
        { label: '编辑', disabled: busy, onClick: (trigger) => openEdit(node, trigger) },
      ]} />,
    },
  ]

  return (
    <PageContainer width="list">
      <div className="page-stack resource-pages phase3-catalog">
      <section className="catalog-data-section" aria-labelledby="nodes-title">
        <PageHeader placement="inline" id="nodes-title" title="节点" actions={<Button variant="primary" size="page" onClick={(event) => openCreate(event.currentTarget)}><Plus aria-hidden="true" size={18} />添加节点</Button>} />
        <AdminModuleTabs />
        <FilterBar className="catalog-filters" searchRef={searchRef}
          onReset={query || protocol !== 'all' || sourceId !== 'all' || groupId !== 'all' || status !== 'all'
            ? () => { setQuery(''); setProtocol('all'); setSourceId('all'); setGroupId('all'); setStatus('all') }
            : undefined}
          moreActive={protocol !== 'all' || sourceId !== 'all' || groupId !== 'all'}
          more={<>
            <label className="filter-field"><span>协议</span><FormSelect aria-label="节点协议" value={protocol} onChange={(event) => setProtocol(event.currentTarget.value)}><option value="all">全部</option>{protocols.map((item) => <option key={item} value={item}>{item}</option>)}</FormSelect></label>
            <label className="filter-field"><span>来源</span><FormSelect aria-label="节点来源" value={sourceId} onChange={(event) => setSourceId(event.currentTarget.value)}><option value="all">全部</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</FormSelect></label>
            <label className="filter-field"><span>分组</span><FormSelect aria-label="节点分组" value={groupId} onChange={(event) => setGroupId(event.currentTarget.value)}>
              <option value="all">全部</option>{groupMembers.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </FormSelect></label>
          </>}>
          <SearchInput inputRef={searchRef} label="搜索节点" placeholder="搜索名称、服务器或协议" value={query} onChange={setQuery} />
          <label className="filter-field"><span>状态</span><FormSelect aria-label="节点状态" value={status} onChange={(event) => setStatus(event.currentTarget.value as NodeStatusFilter)}>{NODE_STATUS_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormSelect></label>
          <label className="filter-field"><span>每页显示</span><FormSelect aria-label="每页显示" value={pageSize} onChange={(event) => setPageSize(Number(event.currentTarget.value))}>
            {[20, 50, 100, 200].map((size) => <option key={size} value={size}>{size}</option>)}
          </FormSelect></label>
        </FilterBar>
        {error && <ErrorState message={error} onRetry={() => load()} />}
        {batchError && <ErrorState message={batchError} />}
        <BatchToolbar compact selectedCount={selected.size} totalCount={filteredNodes.length} onSelectAll={() => setSelected(new Set(filteredNodes.map((node) => node.id)))} onClear={() => { setSelected(new Set()); searchRef.current?.focus() }} actions={actions} busy={busy} progress={progress} />
        {!catalog && error ? null : !loading && nodes.length === 0 ? (
          <EmptyState title="暂无节点"><Link className="button secondary" to="/catalog/sources">管理来源</Link></EmptyState>
        ) : (
          <DataTable columns={columns} rows={visibleRows} loadingLabel={loading && !catalog ? '正在加载节点' : undefined}
            rowKey={(node) => node.id} empty="暂无匹配节点"
            summary={catalog && `共 ${filteredNodes.length} 个节点 · ${nodes.filter((node) => node.enabled).length} 个启用${filteredNodes.length !== nodes.length ? ` · 全部 ${nodes.length} 个` : ''}`}
            pagination={{ page, pageCount, onPageChange: setPage, compact: true }} />
        )}
      </section>

      <Dialog appearance="content" open={detail !== null} title={detail?.displayName ?? '节点详情'} size="l"
        onClose={() => setDetail(null)} returnFocusRef={editorTrigger}
        footer={detail && <button type="button" className="button secondary" disabled={busy}
          onClick={() => openEdit(detail, editorTrigger.current)}>编辑节点</button>}>
        {detail && <PageContainer width="detail"><DetailList items={[
          { id: 'protocol', label: '协议', value: detail.protocol },
          { id: 'server', label: '服务器与端口', value: `${detail.server} · ${detail.port}` },
          { id: 'status', label: '状态', value: nodeStatus(detail) },
          { id: 'sources', label: '来源', value: detail.sourceIds.map((id) => sourceNames.get(id) ?? id).join('、') || '手工保留' },
          { id: 'groups', label: '分组', value: groupNames(detail) },
          { id: 'updated', label: '最后同步', value: formatDate(detail.lastSeenAt) },
          { id: 'retained', label: '无来源时保留', value: detail.retained ? '是' : '否' },
        ]} /></PageContainer>}
      </Dialog>

      <Dialog appearance="content" open={editing !== null || adding} title={adding ? '添加节点' : '编辑节点'} busy={busy} size="l" onClose={closeEdit} returnFocusRef={editorTrigger}
        dirty={invalidFields.length > 0 || (!adding && connectionDirty) || JSON.stringify(nodeForm) !== JSON.stringify(nodeBaseline)}
        footer={(requestClose) => <>
          <button className="button secondary" type="button" onClick={requestClose} disabled={busy}>取消</button>
          <button className="button primary" type="submit" form="node-editor-form" disabled={busy || invalidFields.length > 0}>{busy ? '保存中' : adding ? '保存节点' : '保存修改'}</button>
        </>}
      >
        {(editing || adding) && <form id="node-editor-form" className="form-stack" onSubmit={saveNode}>
          <fieldset className="choice-section catalog-node-fields"><legend>基础信息</legend>
            <label className="field"><span>节点名称</span><Input aria-label="节点名称" value={nodeForm.displayName} maxLength={256} onChange={(event) => { const displayName = event.currentTarget.value; setNodeForm((current) => ({ ...current, displayName })) }} required /></label>
            <label className="field"><span>标签（逗号分隔）</span><Input value={nodeForm.tags} onChange={(event) => setNodeForm({ ...nodeForm, tags: event.currentTarget.value })} /></label>
            <label className="field"><span>地区</span><Input maxLength={64} value={nodeForm.region} onChange={(event) => setNodeForm({ ...nodeForm, region: event.currentTarget.value })} /></label>
            <Switch label="启用节点" checked={nodeForm.enabled} onChange={(enabled) => setNodeForm((current) => ({ ...current, enabled }))} />
            <Switch label="无来源时保留" checked={nodeForm.retained} onChange={(retained) => setNodeForm((current) => ({ ...current, retained }))} />
          </fieldset>
          <fieldset className="choice-section catalog-node-fields"><legend>连接参数</legend>
            <label className="field"><span>协议</span><FormSelect aria-label="协议" value={nodeForm.protocol} onChange={(event) => {
              setNodeForm({ ...nodeForm, protocol: event.currentTarget.value })
              setConnection((current) => current && { ...current, credentials: {} })
              setConnectionDirty(true)
            }} required disabled={!connection}><option value="">请选择协议</option>{protocolsSupported.map((item) => <option key={item}>{item}</option>)}</FormSelect></label>
            {nodeForm.protocol && <>
              <label className="field"><span>服务器</span><Input value={nodeForm.server} onChange={(event) => {
                setNodeForm({ ...nodeForm, server: event.currentTarget.value }); setConnectionDirty(true)
              }} required disabled={!connection} /></label>
              <label className="field"><span>端口</span><Input type="number" min={1} max={65535} value={nodeForm.port} onChange={(event) => {
                setNodeForm({ ...nodeForm, port: event.currentTarget.value }); setConnectionDirty(true)
              }} required disabled={!connection} /></label>
              {connection && credentialKeys[nodeForm.protocol]?.map((key) => {
                const CredentialInput = /^(password|privateKey|psk|auth|uuid)$/u.test(key) ? PasswordInput : Input
                return <div key={key} className="field"><label htmlFor={`credential-${key}`}>{key}</label>
                <CredentialInput id={`credential-${key}`} autoComplete="off" value={String(connection.credentials[key] ?? '')}
                  required={!['http', 'https', 'socks5'].includes(nodeForm.protocol)} onChange={(event) => {
                    setConnection({ ...connection, credentials: { ...connection.credentials, [key]: event.currentTarget.value } })
                    setConnectionDirty(true)
                  }} /></div>
              })}
            </>}
          </fieldset>
          {connection && nodeForm.protocol && <details><summary>TLS / 传输</summary>
            {(['tls', 'transport'] as const).map((key) => <label key={key} className="field"><span>{key}（JSON）</span>
              <Textarea aria-invalid={invalidFields.includes(key)} defaultValue={JSON.stringify(connection[key] ?? {}, null, 2)}
                onChange={(event) => updateJsonField(key, event.currentTarget)} />
              {invalidFields.includes(key) && <span>请输入有效的 JSON 对象</span>}
            </label>)}
          </details>}
          <details><summary>高级原始字段</summary>
            {connection && (['extensions', 'plugin'] as const).map((key) => <label key={key} className="field"><span>{key}（JSON）</span>
              <Textarea aria-invalid={invalidFields.includes(key)} defaultValue={JSON.stringify(connection[key] ?? {}, null, 2)}
                onChange={(event) => updateJsonField(key, event.currentTarget)} />
              {invalidFields.includes(key) && <span>请输入有效的 JSON 对象</span>}
            </label>)}
            {connection?.rawVariants.length ? <pre className="source-preview catalog-node-raw">{JSON.stringify(connection.rawVariants, null, 2)}</pre> : <p>暂无原始导入记录</p>}
          </details>
          {editing && <div className="form-stack">
            <button className="button secondary" type="button" disabled={busy} onClick={copyNode}>以此节点复制</button>
            <label className="field"><span>转换目标</span><FormSelect value={testClient} onChange={(event) => { setTestClient(event.currentTarget.value); setTestResult(null) }}>
              {['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'].map((client) => <option key={client}>{client}</option>)}
            </FormSelect></label>
            <div className="sp-hint-row">
              <button className="button secondary" type="button" onClick={testOutput}>测试转换输出</button>
              {connectionDirty ? <HintTip text="转换测试使用已保存的连接参数" /> : null}
            </div>
            {testResult && <section className="form-stack"><p>可输出 {testResult.outputNodes} 个节点</p>
              {testResult.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic.message}</p>)}
              {testResult.outputNodes > 0 && <details><summary>显示转换结果（含连接凭据）</summary><Textarea aria-label="转换结果" readOnly value={testResult.body} /></details>}
            </section>}
          </div>}
          {editorError ? <StatusMessage tone="error">{editorError}</StatusMessage> : null}
        </form>}
      </Dialog>

      <ConfirmDialog appearance="content" open={pending !== null}
        title={pending ? `${batchActions[pending].label}节点` : ''}
        description={pending ? `选中的 ${selected.size} 个节点将${batchActions[pending].impact}` : ''}
        confirmLabel={pending ? batchActions[pending].label : '确认'} danger={pending === 'disable'} busy={busy}
        onClose={() => setPending(null)} onConfirm={() => { if (pending) return executeBatch(pending) }} />
    </div>
    </PageContainer>
  )
}
