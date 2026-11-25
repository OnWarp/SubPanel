import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { peekApi, watchApi, ApiClientError } from '../../app/api'
import { ErrorState } from '../../ui/ErrorState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { StatGroup } from '../../ui/DetailList'
import { Skeleton } from '../../ui/LoadingState'

type DashboardStats = {
  users: number
  activeSubscriptions: number
  expiringSubscriptions: number
  pendingTickets: number
  plans: number
  groups: number
  nodes: number
}

type Metric = {
  id: string
  field: keyof DashboardStats
  label: string
  to?: string
}

const metrics: Metric[] = [
  { id: 'pending', field: 'pendingTickets', label: '待处理工单', to: '/delivery/tickets?status=open' },
  { id: 'expiring', field: 'expiringSubscriptions', label: '7 日内到期', to: '/users?expiry=soon' },
  { id: 'users', field: 'users', label: '总用户', to: '/users' },
  { id: 'active', field: 'activeSubscriptions', label: '有效订阅' },
  { id: 'nodes', field: 'nodes', label: '节点', to: '/catalog/nodes' },
  { id: 'groups', field: 'groups', label: '分组', to: '/catalog/groups' },
  { id: 'plans', field: 'plans', label: '计划' },
]

function metricValue(value: number | undefined, to: string | undefined, loading: boolean): ReactNode {
  const body = loading || value === undefined ? <Skeleton /> : value
  return to ? <Link to={to}>{body}</Link> : body
}

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(() => peekApi<DashboardStats>('/api/admin/stats') ?? null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const loading = !stats && !error

  useEffect(() => {
    const controller = new AbortController()
    watchApi<DashboardStats>('/api/admin/stats', setStats, { signal: controller.signal })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && peekApi('/api/admin/stats') === undefined) {
          setError(cause instanceof ApiClientError ? cause.message : '加载概览失败')
        }
      })
    return () => controller.abort()
  }, [attempt])

  return (
    <PageContainer width="list">
      <PageHeader title="概览" />
      {error ? <ErrorState message={error} onRetry={() => {
        setError('')
        setAttempt((current) => current + 1)
      }} /> : (
        <section aria-label={loading ? '正在加载概览' : '概览统计与待办'} aria-busy={loading || undefined}>
          <StatGroup items={metrics.map(({ id, field, label, to }) => ({
            id,
            label,
            value: metricValue(stats?.[field], to, loading),
          }))} />
        </section>
      )}
    </PageContainer>
  )
}
