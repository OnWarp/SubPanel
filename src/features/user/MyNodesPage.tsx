import { GateEmptyState } from '../../ui/GateEmptyState'
import { Network } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError } from '../../app/api'
import { FormSelect } from '../../ui/Controls'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function joinedNames(items: NodeRef[]): string {
  return items.map((item) => item.name).join('、') || '—'
}

export function UserNodesFilters({ query, subscriptionId, groupId, subscriptionOptions, groupOptions, onQuery, onSubscription, onGroup }: {
  query: string
  subscriptionId: string
  groupId: string
  subscriptionOptions: NodeRef[]
  groupOptions: NodeRef[]
  onQuery: (value: string) => void
  onSubscription: (value: string) => void
  onGroup: (value: string) => void
}) {
  return (
    <div className="node-toolbar upd-filters">
      <SearchInput className="node-search" label="搜索节点名称" placeholder="搜索节点名称" value={query} onChange={onQuery} />
      <FormSelect aria-label="按订阅筛选" value={subscriptionId} onChange={(event) => onSubscription(event.target.value)}>
        <option value="all">全部</option>
        {subscriptionOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </FormSelect>
      <FormSelect aria-label="按分组筛选" value={groupId} onChange={(event) => onGroup(event.target.value)}>
        <option value="all">全部</option>
        {groupOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </FormSelect>
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

export function MyNodesPage() {
  const [hasActiveSubscription, setHasActiveSubscription] = useState(false)
  const [nodes, setNodes] = useState<UserNode[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [subscriptionOptions, setSubscriptionOptions] = useState<NodeRef[]>(EMPTY_REFS)
  const [groupOptions, setGroupOptions] = useState<NodeRef[]>(EMPTY_REFS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [subscriptionId, setSubscriptionId] = useState('all')
  const [groupId, setGroupId] = useState('all')
  const requestSeq = useRef(0)

  const activeSubscription = subscriptionId !== 'all' && subscriptionOptions.some((item) => item.id === subscriptionId) ? subscriptionId : 'all'
  const activeGroup = groupId !== 'all' && groupOptions.some((item) => item.id === groupId) ? groupId : 'all'

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    const needle = query.trim()
    if (needle) params.set('q', needle)
    params.set('subscriptionId', activeSubscription)
    params.set('groupId', activeGroup)
    const seq = ++requestSeq.current
    try {
      const result = await api<UserNodesResponse>(`/api/user/nodes?${params.toString()}`)
      if (seq !== requestSeq.current) return
      setHasActiveSubscription(result.hasActiveSubscription)
      setNodes(result.nodes)
      setTotal(result.total)
      setSubscriptionOptions(result.subscriptionOptions)
      setGroupOptions(result.groupOptions)
      setError('')
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setError(errorMessage(cause, '加载节点失败'))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [activeGroup, activeSubscription, page, query])

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

  if (!loading && !error && !hasActiveSubscription) return <GateEmptyState icon={<Network size={48} />} message="需要有效订阅才能查看节点" />

  return (
    <div className="page-stack node-page upd-page upd-nodes">
      <PageHero subtitle="查看当前可用节点" title="我的节点" />
      {loading ? <LoadingState label="正在加载节点" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && total === 0 && !filtersActive ? (
        <EmptyState icon={Network} title="暂无可用节点">
          <Link className="button primary" to="/subscriptions">去订阅</Link>
        </EmptyState>
      ) : null}
      {!loading && !error && (total > 0 || filtersActive) ? (
        <section className="data-section node-list upd-card" aria-labelledby="node-list-title">
          <DataHeader id="node-list-title" title="节点列表" />
          <UserNodesFilters
            query={query}
            subscriptionId={activeSubscription}
            groupId={activeGroup}
            subscriptionOptions={subscriptionOptions}
            groupOptions={groupOptions}
            onQuery={changeQuery}
            onSubscription={changeSubscription}
            onGroup={changeGroup}
          />
          <UserNodesTable nodes={nodes} />
          <UserNodesFooter total={total} page={page} pageCount={pageCount} onPage={setPage} />
        </section>
      ) : null}
    </div>
  )
}
