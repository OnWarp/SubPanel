import { subscriptionError, unifiedSubscriptionPath, useUnifiedSubscription, type SubscriptionNode } from '../delivery/unified-subscription'
import { GateEmptyState } from '../../ui/GateEmptyState'
import { Network } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, peekApi, watchApi, ApiClientError } from '../../app/api'
import { FormSelect } from '../../ui/Controls'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { SearchInput } from '../../ui/SearchInput'

type NodeRef = {
  id: string
  name: string
}

export type UserNode = {
  id: string
  name: string
  protocol: string | null
  groups: NodeRef[]
  subscriptions: NodeRef[]
}

type UserNodesResponse = {
  hasActiveSubscription: boolean
  nodes: UserNode[]
  total: number
  page: number
  pageSize: number
  subscriptionOptions: NodeRef[]
  groupOptions: NodeRef[]
}

const PAGE_SIZE = 20
const EMPTY_REFS: NodeRef[] = []

function NodesPageFrame({ children }: { children: ReactNode }) {
  return (
    <PageContainer width="list">
      <div className="page-stack node-page upd-page upd-nodes">
        <PageHeader title="我的节点" />
        {children}
      </div>
    </PageContainer>
  )
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function joinedNames(items: NodeRef[]): string {
  return items.map((item) => item.name).join('、') || '—'
}

export function UserNodesFilters({ query, subscriptionId, groupId, subscriptionOptions, groupOptions, onQuery, onSubscription, onGroup, onReset }: {
  query: string
  subscriptionId: string
  groupId: string
  subscriptionOptions: NodeRef[]
  groupOptions: NodeRef[]
  onQuery: (value: string) => void
  onSubscription: (value: string) => void
  onGroup: (value: string) => void
  onReset?: () => void
}) {
  return (
    <div className="node-toolbar upd-filters">
      <SearchInput className="node-search" label="搜索节点名称" placeholder="搜索节点名称" value={query} onChange={onQuery} />
      <FormSelect aria-label="按订阅筛选" value={subscriptionId} onChange={(event) => onSubscription(event.target.value)}>
        <option value="all">全部</option>
        {subscriptionOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </FormSelect>
      <details className="upd-more-filters" {...(groupId !== 'all' ? { open: true } : {})}>
        <summary>更多筛选</summary>
        <FormSelect aria-label="按分组筛选" value={groupId} onChange={(event) => onGroup(event.target.value)}>
          <option value="all">全部</option>
          {groupOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </FormSelect>
      </details>
      {onReset ? <button className="button ghost" type="button" onClick={onReset}>重置筛选</button> : null}
    </div>
  )
}

const columns: Array<DataTableColumn<UserNode>> = [
  {
    key: 'name',
    header: '节点',
    width: '28%',
    render: (node) => <div className="upd-twoline"><strong>{node.name}</strong><span>{node.id}</span></div>,
  },
  {
    key: 'protocol',
    header: '协议',
    width: '14%',
    render: (node) => node.protocol ? node.protocol : <span className="node-missing">—</span>,
  },
  {
    key: 'status',
    header: '状态',
    width: '14%',
    render: () => <span className="upd-status upd-status-ok"><i aria-hidden="true" />可用</span>,
  },
  { key: 'groups', header: '所属分组', width: '22%', render: (node) => joinedNames(node.groups) },
  { key: 'subscriptions', header: '所属订阅', width: '22%', render: (node) => joinedNames(node.subscriptions) },
]

export function UserNodesTable({ nodes }: { nodes: UserNode[] }) {
  return <DataTable className="node-table" columns={columns} rows={nodes} rowKey={(node) => node.id} empty="没有匹配的节点" />
}

export function UserNodesFooter({ total, page, pageCount, onPage }: {
  total: number
  page: number
  pageCount: number
  onPage: (page: number) => void
}) {
  const current = Math.min(Math.max(page, 1), Math.max(pageCount, 1))
  return (
    <footer className="upd-foot">
      <span>共 {total} 个节点</span>
      <div className="upd-pager">
        <span>{current} / {Math.max(pageCount, 1)} 页</span>
        <button type="button" aria-label="上一页" disabled={current <= 1} onClick={() => onPage(current - 1)}>上一页</button>
        <button type="button" aria-label="下一页" disabled={current >= pageCount} onClick={() => onPage(current + 1)}>下一页</button>
      </div>
    </footer>
  )
}

function LegacyMyNodesPage() {
  const [initial] = useState(() => peekApi<UserNodesResponse>(`/api/user/nodes?page=1&pageSize=${PAGE_SIZE}&subscriptionId=all&groupId=all`))
  const [hasActiveSubscription, setHasActiveSubscription] = useState(initial?.hasActiveSubscription ?? false)
  const [nodes, setNodes] = useState<UserNode[]>(initial?.nodes ?? [])
  const [total, setTotal] = useState(initial?.total ?? 0)
  const [page, setPage] = useState(1)
  const [subscriptionOptions, setSubscriptionOptions] = useState<NodeRef[]>(initial?.subscriptionOptions ?? EMPTY_REFS)
  const [groupOptions, setGroupOptions] = useState<NodeRef[]>(initial?.groupOptions ?? EMPTY_REFS)
  const [loading, setLoading] = useState(initial === undefined)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [subscriptionId, setSubscriptionId] = useState('all')
  const [groupId, setGroupId] = useState('all')
  const requestSeq = useRef(0)

  const activeSubscription = subscriptionId !== 'all' && subscriptionOptions.some((item) => item.id === subscriptionId) ? subscriptionId : 'all'
  const activeGroup = groupId !== 'all' && groupOptions.some((item) => item.id === groupId) ? groupId : 'all'

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
  const needle = query.trim()
  if (needle) params.set('q', needle)
  params.set('subscriptionId', activeSubscription)
  params.set('groupId', activeGroup)
  const path = `/api/user/nodes?${params}`

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      await watchApi<UserNodesResponse>(path, (result) => {
        if (seq !== requestSeq.current) return
        setHasActiveSubscription(result.hasActiveSubscription)
        setNodes(result.nodes)
        setTotal(result.total)
        setSubscriptionOptions(result.subscriptionOptions)
        setGroupOptions(result.groupOptions)
        setError('')
      })
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setError(errorMessage(cause, '加载节点失败'))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [path])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtersActive = query.trim() !== '' || activeSubscription !== 'all' || activeGroup !== 'all'

  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])

  const changeQuery = (value: string) => {
    setQuery(value)
    setPage(1)
  }

  const changeSubscription = (value: string) => {
    setSubscriptionId(value)
    setPage(1)
  }

  const changeGroup = (value: string) => {
    setGroupId(value)
    setPage(1)
  }

  const resetFilters = () => {
    setQuery('')
    setSubscriptionId('all')
    setGroupId('all')
    setPage(1)
  }

  if (!loading && !error && !hasActiveSubscription) {
    return (
      <NodesPageFrame>
        <GateEmptyState icon={<Network size={48} />} message="需要有效订阅才能查看节点" action={<Link className="button primary" to="/subscriptions">去订阅</Link>} />
      </NodesPageFrame>
    )
  }

  return (
    <NodesPageFrame>
      {loading ? <LoadingState label="正在加载节点" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && total === 0 && !filtersActive ? (
        <EmptyState icon={Network} title="暂无可用节点">
          <Link className="button primary" to="/subscriptions">去订阅</Link>
        </EmptyState>
      ) : null}
      {!loading && !error && (total > 0 || filtersActive) ? (
        <section className="data-section node-list" aria-label="节点列表">
          <UserNodesFilters
            query={query}
            subscriptionId={activeSubscription}
            groupId={activeGroup}
            subscriptionOptions={subscriptionOptions}
            groupOptions={groupOptions}
            onQuery={changeQuery}
            onSubscription={changeSubscription}
            onGroup={changeGroup}
            onReset={filtersActive ? resetFilters : undefined}
          />
          <UserNodesTable nodes={nodes} />
          <UserNodesFooter total={total} page={page} pageCount={pageCount} onPage={setPage} />
        </section>
      ) : null}
    </NodesPageFrame>
  )
}

function UnifiedNodes({ reloadSummary }: { reloadSummary: () => void }) {
  const [nodes, setNodes] = useState<SubscriptionNode[]>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api<{ nodes: SubscriptionNode[] }>(`${unifiedSubscriptionPath}/nodes`, { signal: controller.signal, cache: 'no-store' })
      .then(result => { if (!controller.signal.aborted) setNodes(result.nodes) })
      .catch(cause => {
        if (!controller.signal.aborted) setError(subscriptionError(cause, '加载节点失败'))
      })
    return () => controller.abort()
  }, [revision])
  return <NodesPageFrame>
    {error ? <ErrorState message={error} onRetry={() => {
      setError(''); setRevision(value => value + 1); reloadSummary()
    }} /> : !nodes ? <LoadingState label="正在加载节点" /> : <>
      <DataTable rows={nodes.map((node, index) => ({ ...node, index }))} rowKey={node => node.index} empty="暂无可用节点"
        columns={[{ key: 'name', header: '节点' }, { key: 'protocol', header: '协议' }]} />
      {!nodes.length && <Link to="/subscriptions">打开订阅</Link>}
    </>}
  </NodesPageFrame>
}

export function MyNodesPage() {
  const { state, reload } = useUnifiedSubscription()
  if (state.kind === 'legacy') return <LegacyMyNodesPage />
  if (state.kind === 'ready') return <UnifiedNodes reloadSummary={reload} />
  return <NodesPageFrame>
    {state.kind === 'loading' ? <LoadingState label="正在加载订阅" /> : <ErrorState message={state.message} onRetry={reload} />}
  </NodesPageFrame>
}
