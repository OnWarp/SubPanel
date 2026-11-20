import { AlertTriangle, ArrowRight } from 'lucide-react'
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
    <div className="page-stack ops-page">
      <PageHeader title="概览" />
      <div className="page-stack" aria-label="概览">
        {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
        {loading && !data ? <LoadingState label="正在加载概览" /> : null}
        {data ? (
          <>
            <section className="stat-grid" aria-label="用户与订阅统计">
              <StatCard label="总用户" value={data.stats.users} />
              <StatCard label="有效订阅" value={data.stats.activeSubscriptions} />
              <StatCard label="7 日内到期" value={data.stats.expiringSubscriptions} />
              <StatCard label="待处理工单" value={data.stats.pendingTickets} sub="未关闭工单" />
            </section>
            <section className="stat-grid" aria-label="系统统计">{Object.entries({plans:'计划',groups:'分组',nodes:'节点'}).map(([key,label])=><StatCard key={key} label={label} value={data.stats[key]} />)}</section>
            <section className="stat-grid" aria-label="资源统计">
              <StatCard to="/catalog/sources" label="来源" value={data.catalog.sources.length} />
              <StatCard to="/catalog/nodes" label="启用节点" value={data.catalog.nodes.filter((node) => node.enabled).length} />
              <StatCard to="/delivery/subscriptions" label="订阅总数" value={data.subscriptions.length} />
              <StatCard to="/users" label="用户" value={data.stats.users} />
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
    </div>
  )
}