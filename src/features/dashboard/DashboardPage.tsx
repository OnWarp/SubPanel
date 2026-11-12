import { AlertTriangle, ArrowRight, Database, Layers3, Rss, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, type AdminSubscription, type CatalogResponse, type UserSummary } from '../../app/api'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { DataHeader } from '../../ui/DataHeader'
import { PageHeader } from '../../ui/PageHeader'
import { EXPIRY_SOON_DAYS, formatExpiryTime, formatRemaining, getExpiryState, isWithinExpiryDays } from '../delivery/expiry'

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

  const now = Date.now()
  const within7 = data ? data.subscriptions.filter((subscription) => isWithinExpiryDays(subscription, EXPIRY_SOON_DAYS, now)) : []
  const within15 = data ? data.subscriptions.filter((subscription) => isWithinExpiryDays(subscription, 15, now)).length : 0
  const within30 = data ? data.subscriptions.filter((subscription) => isWithinExpiryDays(subscription, 30, now)).length : 0
  const expiredEnabled = data ? data.subscriptions.filter((subscription) => subscription.enabled && getExpiryState(subscription, now).kind === 'expired').length : 0
  const userNames = new Map((data?.users ?? []).map((user) => [user.id, user.username]))
  const groupNames = new Map((data?.catalog.groups ?? []).map((group) => [group.id, group.name]))
  const expiringSoon = [...within7].sort((left, right) => (left.expiresAt ?? 0) - (right.expiresAt ?? 0)).slice(0, 10)

  return (
    <div className="page-stack">
      <PageHeader title="概览" description="查看资源状态和需要处理的事项。" />
      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
      {loading && !data ? <section className="data-section"><LoadingState label="正在加载概览" /></section> : null}
      {data ? (
        <>
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
          <section className="exp-expiry-grid" aria-label="到期统计">
            <Link className="exp-expiry-stat" to="/delivery/subscriptions?expiry=7">
              <span>7 天内到期</span>
              <strong>{within7.length}</strong>
            </Link>
            <Link className="exp-expiry-stat" to="/delivery/subscriptions?expiry=15">
              <span>15 天内到期</span>
              <strong>{within15}</strong>
            </Link>
            <Link className="exp-expiry-stat" to="/delivery/subscriptions?expiry=30">
              <span>30 天内到期</span>
              <strong>{within30}</strong>
            </Link>
            <Link className="exp-expiry-stat" to="/delivery/subscriptions?expiry=expired&enabled=1">
              <span>已过期</span>
              <strong>{expiredEnabled}</strong>
            </Link>
          </section>
          <section className="data-section" aria-labelledby="expiring-title">
            <DataHeader id="expiring-title" title="即将到期" />
            {expiringSoon.length ? (
              <ul className="exp-soon-list">
                {expiringSoon.map((subscription) => {
                  const state = getExpiryState(subscription, now)
                  const groups = subscription.groupIds.map((id) => groupNames.get(id) ?? id)
                  const title = groups.length ? `${subscription.name} · ${groups.join('、')}` : subscription.name
                  return (
                    <li className="exp-soon-item" key={subscription.id}>
                      <span>{userNames.get(subscription.userId) ?? subscription.userId}</span>
                      <span>{title}</span>
                      <span>{state.expiresAt === null ? '—' : formatExpiryTime(state.expiresAt)}</span>
                      <span className="exp-soon-days">剩余 {formatRemaining(state.remainingDays ?? 0)}</span>
                    </li>
                  )
                })}
              </ul>
            ) : <EmptyState title="暂无即将到期的订阅" />}
          </section>
          <section className="data-section issue-section" aria-labelledby="issues-title">
            <DataHeader id="issues-title" title="需要处理" />
            {issues.length ? <ul className="issue-list">{issues.map((issue) => <li key={issue.key}><AlertTriangle aria-hidden="true" size={17} /><div><strong>{issue.label}</strong><span>{issue.detail}</span></div><Link to={issue.to} aria-label={`查看${issue.label}`}>查看<ArrowRight aria-hidden="true" size={15} /></Link></li>)}</ul> : <EmptyState title="当前没有需要处理的事项" />}
          </section>
        </>
      ) : null}
    </div>
  )
}
