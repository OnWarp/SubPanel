import { Copy, Download, Rss, Share2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, type AdminSubscription } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { DataHeader } from '../../ui/DataHeader'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { InlineMessage } from '../../ui/InlineMessage'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { EXPIRY_BADGE, EXPIRY_SOON_DAYS, formatExpiryTime, formatRemaining, getExpiryState, isWithinExpiryDays } from '../delivery/expiry'
import { useDownloadsEnabled } from '../apps/downloads-visibility'

function groupSummary(groupIds: string[]): string {
  return groupIds.length ? `${groupIds.length} 个分组` : '未选择分组'
}

function subscriptionLink(subscription: AdminSubscription): string {
  return subscription.links.auto || subscription.links[subscription.defaultClient] || ''
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function HomePage() {
  const downloadsEnabled = useDownloadsEnabled()
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api<{ subscriptions: AdminSubscription[] }>('/api/account/subscriptions')
      setSubscriptions(result.subscriptions)
    } catch (cause) {
      setSubscriptions([])
      setError(errorMessage(cause, '加载订阅失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const now = Date.now()
  const current = subscriptions[0] ?? null
  const expiry = current ? getExpiryState(current, now) : null
  const expiryBadge = expiry ? EXPIRY_BADGE[expiry.kind] : null
  const soon = subscriptions
    .filter((subscription) => isWithinExpiryDays(subscription, EXPIRY_SOON_DAYS, now))
    .sort((left, right) => (left.expiresAt ?? 0) - (right.expiresAt ?? 0))

  const copyLink = async () => {
    if (!current) return
    const link = subscriptionLink(current)
    if (!link) {
      setNotice('')
      setNoticeError('暂无订阅链接')
      return
    }
    try {
      await copyToClipboard(link)
      setNotice('订阅链接已复制')
      setNoticeError('')
    } catch {
      setNotice('')
      setNoticeError('浏览器未允许复制，请手动选择内容')
    }
  }

  return (
    <div className="page-stack nav-home">
      <PageHeader title="首页" description="查看当前订阅和即将到期的提醒" />
      {loading ? <LoadingState label="正在加载订阅" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && !current ? (
        <EmptyState icon={Rss} title="还没有订阅" description="管理员分配订阅后，状态会显示在这里">
          {downloadsEnabled ? <Link className="button primary" to="/apps">看 APP 下载</Link> : null}
        </EmptyState>
      ) : null}
      {!loading && !error && current && expiry && expiryBadge ? (
        <>
          <section className="data-section nav-status" aria-labelledby="nav-current-title">
            <DataHeader id="nav-current-title" title="当前订阅" />
            <div className="nav-status-body">
              {expiry.kind === 'expired' ? <div className="nav-alert"><InlineMessage tone="warning">订阅已过期，请联系管理员续期</InlineMessage></div> : null}
              {expiry.kind === 'pending' ? <div className="nav-alert"><InlineMessage tone="warning">{`将于 ${formatExpiryTime(expiry.startsAt)} 生效`}</InlineMessage></div> : null}
              <div className="nav-status-head">
                <h3 className="nav-status-name">{current.name}</h3>
                <span className="nav-badges">
                  {current.enabled ? <StatusBadge tone={expiryBadge.tone}>{expiryBadge.label}</StatusBadge> : <StatusBadge tone="muted">已停用</StatusBadge>}
                </span>
              </div>
              <p className="nav-group">{groupSummary(current.groupIds)}</p>
              <dl className="nav-meta">
                <div><dt>生效时间</dt><dd>{formatExpiryTime(expiry.startsAt)}</dd></div>
                <div><dt>到期时间</dt><dd>{expiry.expiresAt === null ? '永久有效' : formatExpiryTime(expiry.expiresAt)}</dd></div>
                {expiry.expiresAt !== null ? <div><dt>剩余天数</dt><dd>{formatRemaining(expiry.remainingDays ?? 0)}</dd></div> : null}
              </dl>
              {!current.enabled ? <StatusMessage tone="warning">此订阅已停用，链接暂时不会提供内容</StatusMessage> : null}
            </div>
          </section>

          <section className="nav-actions-block" aria-labelledby="nav-actions-title">
            <h2 id="nav-actions-title" className="nav-kicker">快捷操作</h2>
            {notice ? <StatusMessage tone="success">{notice}</StatusMessage> : null}
            {noticeError ? <StatusMessage tone="error">{noticeError}</StatusMessage> : null}
            <div className="nav-actions">
              <button className="button secondary" type="button" onClick={() => { copyLink().catch(() => undefined) }}><Copy aria-hidden="true" size={16} />复制订阅链接</button>
              <Link className="button secondary" to="/subscriptions"><Rss aria-hidden="true" size={16} />打开订阅管理</Link>
              <Link className="button secondary" to={`/subscriptions?share=${encodeURIComponent(current.id)}`}><Share2 aria-hidden="true" size={16} />创建分享</Link>
              {downloadsEnabled ? <Link className="button secondary" to="/apps"><Download aria-hidden="true" size={16} />去下载 APP</Link> : null}
            </div>
          </section>

          <section className="data-section nav-soon" aria-labelledby="nav-soon-title">
            <DataHeader id="nav-soon-title" title="最近到期" />
            {soon.length ? (
              <ul className="nav-soon-list">
                {soon.map((subscription) => {
                  const state = getExpiryState(subscription, now)
                  const badge = EXPIRY_BADGE[state.kind]
                  return (
                    <li className="nav-soon-item" key={subscription.id}>
                      <Link to="/subscriptions">
                        <strong>{subscription.name}</strong>
                        <span>{groupSummary(subscription.groupIds)}</span>
                        <span>{state.expiresAt === null ? '永久有效' : formatExpiryTime(state.expiresAt)}</span>
                        <span className="nav-soon-days">剩余 {formatRemaining(state.remainingDays ?? 0)}</span>
                        <StatusBadge tone={badge.tone} size="sm">{badge.label}</StatusBadge>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            ) : <EmptyState title="暂无 7 天内到期的订阅" />}
          </section>
        </>
      ) : null}
    </div>
  )
}
