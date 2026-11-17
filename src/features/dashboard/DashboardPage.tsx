import { AlertTriangle, ArrowRight, Database, Layers3, Rss, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, type AdminSubscription, type CatalogResponse } from '../../app/api'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { StatCard } from '../../ui/StatCard'
import { PageHeader } from '../../ui/PageHeader'

type DashboardData = {
  stats: Record<string,number>
  catalog: CatalogResponse
  subscriptions: AdminSubscription[]
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      const [stats, catalog, subscriptionResult] = await Promise.all([
        api<Record<string,number>>('/api/admin/stats'),
        api<CatalogResponse>('/api/admin/catalog'),
        api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions'),
      ])
      setData({ stats, catalog, subscriptions: subscriptionResult.subscriptions })
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
            <StatCard label="总用户" value={data.stats.users} />
            <StatCard label="有效权益" value={data.stats.activeEntitlements} />
            <StatCard label="7 日内到期" value={data.stats.expiringEntitlements} />
            <StatCard label="待处理工单" value={data.stats.pendingTickets} sub="未关闭工单" />
          </section>
          <section className="adm-stat-grid" aria-label="系统统计">{Object.entries({plans:'计划',groups:'分组',nodes:'节点'}).map(([key,label])=><div className="adm-stat" key={key}><span className="adm-stat-label">{label}</span><strong className="adm-stat-value">{data.stats[key]}</strong></div>)}</section>
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
              <strong className="adm-stat-value">{data.stats.users}</strong>
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