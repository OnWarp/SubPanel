import { AlertTriangle, ArrowRight, Database, Layers3, Rss, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, type AdminSubscription, type CatalogResponse, type UserSummary } from '../../app/api'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { StatCard } from '../../ui/StatCard'
import type { EntitlementState } from '../entitlements/types'
import { PageHeader } from '../../ui/PageHeader'

type DashboardData = {
  catalog: CatalogResponse
  subscriptions: AdminSubscription[]
  users: UserSummary[]
  userTotal: number
  rights: EntitlementState[] | null
  pendingTickets: number | null
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      const [catalog, subscriptionResult, userResult] = await Promise.all([
        api<CatalogResponse>('/api/admin/catalog'),
        api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions'),
        api<{ users: UserSummary[], total: number }>('/api/admin/users?pageSize=100'),
      ])
      const users = [...userResult.users]
      for (let page = 2; users.length < userResult.total; page += 1) {
        const result = await api<{ users: UserSummary[] }>(`/api/admin/users?pageSize=100&page=${page}`)
        if (!result.users.length) throw new Error('用户列表不完整')
        users.push(...result.users)
      }
      const [rightsResult, ticketsResult] = await Promise.allSettled([
        (async () => {
          const rights: EntitlementState[] = []
          for (let start = 0; start < users.length; start += 8) {
            rights.push(...await Promise.all(users.slice(start, start + 8).map((user) => api<EntitlementState>(`/api/admin/users/${user.id}/entitlement`))))
          }
          return rights
        })(),
        api<{ total: number }>('/api/admin/tickets?status=open&pageSize=1'),
      ])
      setData({ catalog, subscriptions: subscriptionResult.subscriptions, users, userTotal: userResult.total, rights: rightsResult.status === 'fulfilled' ? rightsResult.value : null, pendingTickets: ticketsResult.status === 'fulfilled' ? ticketsResult.value.total : null })
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '加载概览失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const issues = data ? [
    ...data.catalog.sources.filter((source) => source.lastErrorCode).map((source) => ({
      key: `source-${source.id}`,
      label: `来源「${source.name}」最近刷新失败`,
      detail: source.lastErrorCode ?? '请检查来源状态',
      to: '/catalog/sources',
    })),
    ...data.subscriptions.flatMap((subscription) => {
      const skipped = Object.values(subscription.diagnostics).reduce((sum, item) => sum + item.skippedNodes, 0)
      return skipped > 0 ? [{
        key: `subscription-${subscription.id}`,
        label: `订阅「${subscription.name}」存在兼容性跳过`,
        detail: `${skipped} 个节点被目标格式跳过`,
        to: '/delivery/subscriptions',
      }] : []
    }),
  ] : []

  return (
    <div className="page-stack">
      <PageHeader title="概览" />
      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
      {loading && !data ? <section className="data-section"><LoadingState label="正在加载概览" /></section> : null}
      {data ? (
        <>
          <section className="ui3-stat-grid" aria-label="用户与权益统计">
            <StatCard label="总用户" value={data.userTotal} />
            {data.rights ? <><StatCard label="有效权益" value={data.rights.filter((right) => right.state === 'active' && right.current).length} /><StatCard label="7 日内到期" value={data.rights.filter((right) => right.state === 'active' && right.current && Date.parse(right.current.expiresAt) > Date.now() && Date.parse(right.current.expiresAt) <= Date.now() + 7 * 86400000).length} /></> : null}
            {data.pendingTickets !== null ? <StatCard label="待处理工单" value={data.pendingTickets} sub="未关闭工单" /> : null}
          </section>
          <section className="adm-stat-grid" aria-label="资源统计">
            <Link className="adm-stat" to="/catalog/sources">
              <span className="adm-stat-label">来源</span>
              <Rss className="adm-stat-icon" aria-hidden="true" size={18} />
              <strong className="adm-stat-value">{data.catalog.sources.length}</strong>
            </Link>
            <Link className="adm-stat" to="/catalog/nodes">
              <span className="adm-stat-label">启用节点</span>
              <Database className="adm-stat-icon" aria-hidden="true" size={18} />
              <strong className="adm-stat-value">{data.catalog.nodes.filter((node) => node.enabled).length}</strong>
            </Link>
            <Link className="adm-stat" to="/delivery/subscriptions">
              <span className="adm-stat-label">活跃订阅</span>
              <Layers3 className="adm-stat-icon" aria-hidden="true" size={18} />
              <strong className="adm-stat-value">{data.subscriptions.filter((subscription) => subscription.enabled).length}</strong>
            </Link>
            <Link className="adm-stat" to="/users">
              <span className="adm-stat-label">用户</span>
              <Users className="adm-stat-icon" aria-hidden="true" size={18} />
              <strong className="adm-stat-value">{data.users.length}</strong>
            </Link>
          </section>
          {issues.length > 0 && (
            <div className="adm-alert" role="alert">
              <AlertTriangle aria-hidden="true" size={16} />
              <span>{issues.length} 项需要处理</span>
              <Link to="/catalog/sources" className="adm-alert-link">查看详情<ArrowRight aria-hidden="true" size={14} /></Link>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}