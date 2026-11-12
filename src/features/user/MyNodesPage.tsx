import { Network } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError } from '../../app/api'
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

type NodeRef = {
  id: string
  name: string
}

type UserNode = {
  id: string
  name: string
  protocol: string | null
  groups: NodeRef[]
  subscriptions: NodeRef[]
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function uniqueRefs(nodes: UserNode[], key: 'groups' | 'subscriptions'): NodeRef[] {
  const refs = new Map<string, string>()
  for (const node of nodes) {
    for (const item of node[key]) {
      if (!refs.has(item.id)) refs.set(item.id, item.name)
    }
  }
  return [...refs].map(([id, name]) => ({ id, name }))
}

function joinedNames(items: NodeRef[]): string {
  return items.map((item) => item.name).join('、') || '—'
}

export function MyNodesPage() {
  const [nodes, setNodes] = useState<UserNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [subscriptionId, setSubscriptionId] = useState('all')
  const [groupId, setGroupId] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api<{ nodes: UserNode[] }>('/api/user/nodes')
      setNodes(result.nodes)
    } catch (cause) {
      setNodes([])
      setError(errorMessage(cause, '加载节点失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const subscriptionOptions = useMemo(() => uniqueRefs(nodes, 'subscriptions'), [nodes])
  const groupOptions = useMemo(() => uniqueRefs(nodes, 'groups'), [nodes])
  const activeSubscription = subscriptionId !== 'all' && subscriptionOptions.some((item) => item.id === subscriptionId) ? subscriptionId : 'all'
  const activeGroup = groupId !== 'all' && groupOptions.some((item) => item.id === groupId) ? groupId : 'all'
  const groupCount = useMemo(() => new Set(nodes.flatMap((node) => node.groups.map((group) => group.id))).size, [nodes])
  const visibleNodes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return nodes.filter((node) => {
      const nameHit = node.name.toLocaleLowerCase().includes(needle)
      const subscriptionHit = activeSubscription === 'all' || node.subscriptions.some((item) => item.id === activeSubscription)
      const groupHit = activeGroup === 'all' || node.groups.some((item) => item.id === activeGroup)
      return nameHit && subscriptionHit && groupHit
    })
  }, [nodes, query, activeSubscription, activeGroup])

  const columns: Array<DataTableColumn<UserNode>> = [
    { key: 'name', header: '节点名', width: '28%', render: (node) => <strong className="node-name">{node.name}</strong> },
    {
      key: 'protocol',
      header: '协议',
      width: '18%',
      render: (node) => node.protocol
        ? <StatusBadge tone="info" size="sm">{node.protocol}</StatusBadge>
        : <span className="node-missing">—</span>,
    },
    { key: 'groups', header: '所属分组', width: '27%', render: (node) => joinedNames(node.groups) },
    { key: 'subscriptions', header: '所属订阅', width: '27%', render: (node) => joinedNames(node.subscriptions) },
  ]

  return (
    <div className="page-stack node-page">
      <PageHeader title="我的节点" description="汇总名下订阅里的可用节点" />
      {loading ? <LoadingState label="正在加载节点" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && nodes.length === 0 ? (
        <EmptyState icon={Network} title="还没有可用节点" description="订阅分配分组后，节点会显示在这里">
          <Link className="button primary" to="/subscriptions">去订阅</Link>
        </EmptyState>
      ) : null}
      {!loading && !error && nodes.length > 0 ? (
        <>
          <div className="node-summary" aria-label="节点汇总">
            <div className="node-summary-item"><span>节点总数</span><strong>{nodes.length}</strong></div>
            <div className="node-summary-item"><span>来自分组数</span><strong>{groupCount}</strong></div>
          </div>
          <section className="data-section node-list" aria-labelledby="node-list-title">
            <DataHeader id="node-list-title" title="节点列表" />
            <div className="node-toolbar">
              <SearchInput className="node-search" label="搜索节点名称" placeholder="搜索节点名称" value={query} onChange={setQuery} />
              <FilterBar className="node-filters">
                <div className="node-filter-row" role="group" aria-label="按订阅筛选">
                  <span className="node-filter-label">订阅</span>
                  <FilterChip active={activeSubscription === 'all'} onClick={() => setSubscriptionId('all')}>全部</FilterChip>
                  {subscriptionOptions.map((item) => (
                    <FilterChip key={item.id} active={activeSubscription === item.id} onClick={() => setSubscriptionId(item.id)}>{item.name}</FilterChip>
                  ))}
                </div>
                <div className="node-filter-row" role="group" aria-label="按分组筛选">
                  <span className="node-filter-label">分组</span>
                  <FilterChip active={activeGroup === 'all'} onClick={() => setGroupId('all')}>全部</FilterChip>
                  {groupOptions.map((item) => (
                    <FilterChip key={item.id} active={activeGroup === item.id} onClick={() => setGroupId(item.id)}>{item.name}</FilterChip>
                  ))}
                </div>
              </FilterBar>
            </div>
            <DataTable className="node-table" columns={columns} rows={visibleNodes} rowKey={(node) => node.id} empty="没有匹配的节点" />
          </section>
        </>
      ) : null}
    </div>
  )
}
