import { CalendarClock, Layers, Network, Package, Ticket, Users, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError } from '../../app/api'
import { ErrorState } from '../../ui/ErrorState'
import { PageHeader } from '../../ui/PageHeader'

type DashboardStats = {
  users: number
  activeSubscriptions: number
  expiringSubscriptions: number
  pendingTickets: number
  plans: number
  groups: number
  nodes: number
}

const metrics: { field: keyof DashboardStats; label: string; icon: LucideIcon; to?: string }[] = [
  { field: 'users', label: '总用户', icon: Users },
  { field: 'activeSubscriptions', label: '有效订阅', icon: Layers },
  { field: 'expiringSubscriptions', label: '7 日内到期', icon: CalendarClock, to: '/delivery/subscriptions?expiry=soon' },
  { field: 'pendingTickets', label: '待处理工单', icon: Ticket, to: '/delivery/tickets' },
  { field: 'nodes', label: '节点', icon: Network },
  { field: 'plans', label: '计划', icon: Package },
  { field: 'groups', label: '分组', icon: Layers },
]

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const loading = !stats && !error

  useEffect(() => {
    const controller = new AbortController()
    api<DashboardStats>('/api/admin/stats', { signal: controller.signal })
      .then(setStats)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof ApiClientError ? cause.message : '加载概览失败')
        }
      })
    return () => controller.abort()
  }, [attempt])

  return (
    <div className="page-stack adm-overview">
      <PageHeader
        title="概览"
        description={<span className="adm-overview-description">查看系统统计和待处理事项</span>}
      />
      {error ? <ErrorState message={error} onRetry={() => {
        setError('')
        setAttempt((current) => current + 1)
      }} /> : (
        <section
          className="adm-stat-grid"
          aria-label={loading ? '正在加载概览' : '概览统计与待办'}
          aria-busy={loading}
        >
          {metrics.map(({ field, label, icon: Icon, to }) => {
            const content = (
              <>
                <span className="sp-stat-label">
                  {label}
                  <Icon size={16} aria-hidden="true" />
                </span>
                <strong className="sp-stat-value">{stats?.[field]}</strong>
              </>
            )

            if (stats && to) {
              return <Link className="sp-stat-card sp-stat-body" key={field} to={to}>{content}</Link>
            }

            return <div className="sp-stat-card sp-stat-body" key={field} aria-hidden={loading || undefined}>{content}</div>
          })}
        </section>
      )}
    </div>
  )
}
