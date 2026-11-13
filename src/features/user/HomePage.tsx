import { Rss } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, type AdminSubscription } from '../../app/api'
import { CopyButton } from '../../ui/CopyButton'
import { DataHeader } from '../../ui/DataHeader'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { InlineMessage } from '../../ui/InlineMessage'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { StatusBadge } from '../../ui/StatusBadge'
import { EXPIRY_BADGE, formatExpiryTime, formatRemaining, getExpiryState } from '../delivery/expiry'
import { useDownloadsEnabled } from '../apps/downloads-visibility'
import { CLIENT_LABELS, orderLinkEntries, pickPrimaryLink, useEnabledPlatforms } from '../delivery/platforms'

function groupSummary(groupIds: string[]): string {
  return groupIds.length ? `${groupIds.length} 个分组` : '未选择分组'
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function HomePage() {
  const downloadsEnabled = useDownloadsEnabled()
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [client, setClient] = useState('')

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

  const current = subscriptions[0] ?? null
  const expiry = current ? getExpiryState(current, Date.now()) : null
  const expiryBadge = expiry ? EXPIRY_BADGE[expiry.kind] : null

  const platforms = useEnabledPlatforms()
  const linkEntries = current
    ? orderLinkEntries(Object.entries(current.links).filter(([key]) => key !== 'generic'), platforms)
    : []
  const primaryClient = current
    ? linkEntries.find(([, link]) => link === pickPrimaryLink(current.links, current.defaultClient, platforms))?.[0] ?? ''
    : ''
  const activeClient = linkEntries.some(([key]) => key === client)
    ? client
    : primaryClient || linkEntries[0]?.[0] || ''
  const activeLink = linkEntries.find(([key]) => key === activeClient)?.[1] ?? ''

  return (
    <div className="page-stack nav-home">
      <PageHeader title="首页" />
      {loading ? <LoadingState label="正在加载订阅" /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !error && !current ? (
        <EmptyState icon={Rss} title="暂无订阅">
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
                <div><dt>到期时间</dt><dd>{expiry.expiresAt === null ? '永久有效' : formatExpiryTime(expiry.expiresAt)}</dd></div>
                {expiry.expiresAt !== null ? <div><dt>剩余天数</dt><dd className="nav-meta-big">{formatRemaining(expiry.remainingDays ?? 0)}</dd></div> : null}
                <div><dt>生效时间</dt><dd>{formatExpiryTime(expiry.startsAt)}</dd></div>
              </dl>
            </div>
          </section>

          <section className="data-section nav-links" aria-labelledby="nav-links-title">
            <DataHeader id="nav-links-title" title="订阅链接" />
            {linkEntries.length ? (
              <div className="nav-link-body">
                <div className="nav-seg-scroll">
                  <SegmentedControl
                    label="客户端平台"
                    value={activeClient}
                    options={linkEntries.map(([key]) => ({ value: key, label: platforms.names[key] ?? CLIENT_LABELS[key] ?? key }))}
                    onChange={setClient}
                  />
                </div>
                <div className="nav-link-line">
                  <p className="nav-link-text">{activeLink}</p>
                  <CopyButton value={activeLink} />
                </div>
              </div>
            ) : <p className="section-empty">暂无订阅链接</p>}
          </section>
        </>
      ) : null}
    </div>
  )
}
