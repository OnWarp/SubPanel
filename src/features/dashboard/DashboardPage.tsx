import { AlertTriangle, ArrowRight, Database, Layers3, Rss, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, type AdminSubscription, type CatalogResponse, type UserSummary } from '../../app/api'
import { StatusMessage } from '../../ui/StatusMessage'
import { DataHeader } from '../../ui/DataHeader'
import { PageHeader } from '../../ui/PageHeader'

type DashboardData = {
  catalog: CatalogResponse
  subscriptions: AdminSubscription[]
  users: UserSummary[]
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
        api<{ users: UserSummary[] }>('/api/admin/users'),
      ])
      setData({ catalog, subscriptions: subscriptionResult.subscriptions, users: userResult.users })
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
      <PageHeader title="概览" description="查看资源状态和需要处理的事项。" />
      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><button className="button secondary" type="button" onClick={() => load()}>重试</button></div> : null}
      {loading && !data ? <div className="data-section loading-section" role="status">正在加载概览</div> : null}
      {data ? (
        <>
          <section className="metric-grid" aria-label="资源统计">
            <Link className="metric" to="/catalog/sources"><Rss aria-hidden="true" size={18} /><span>来源</span><strong>{data.catalog.sources.length}</strong></Link>
            <Link className="metric" to="/catalog/nodes"><Database aria-hidden="true" size={18} /><span>启用节点</span><strong>{data.catalog.nodes.filter((node) => node.enabled).length}</strong></Link>
            <Link className="metric" to="/delivery/subscriptions"><Layers3 aria-hidden="true" size={18} /><span>活跃订阅</span><strong>{data.subscriptions.filter((subscription) => subscription.enabled).length}</strong></Link>
            <Link className="metric" to="/users"><Users aria-hidden="true" size={18} /><span>用户</span><strong>{data.users.length}</strong></Link>
          </section>
          <section className="data-section issue-section" aria-labelledby="issues-title">
            <DataHeader id="issues-title" title="需要处理" />
            {issues.length ? <ul className="issue-list">{issues.map((issue) => <li key={issue.key}><AlertTriangle aria-hidden="true" size={17} /><div><strong>{issue.label}</strong><span>{issue.detail}</span></div><Link to={issue.to} aria-label={`查看${issue.label}`}>查看<ArrowRight aria-hidden="true" size={15} /></Link></li>)}</ul> : <p className="empty-state">当前没有需要处理的事项。</p>}
          </section>
        </>
      ) : null}
    </div>
  )
}
