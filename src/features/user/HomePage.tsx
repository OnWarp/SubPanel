import { Network } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, peekApi, watchApi, type AdminSubscription } from '../../app/api'
import { useSession } from '../../app/session'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { NoticeCarousel } from '../../ui/NoticeCarousel'
import { StatCard } from '../../ui/StatCard'
import { StatusPill } from '../../ui/StatusPill'
import { QuickEntryCard } from '../../ui/QuickEntryCard'
import { getExpiryState } from '../delivery/expiry'
import type { Notice } from '../notices/types'
import { reminderEnabled } from './reminder'

type HomeDashboardProps = {
  reminder: string | null
  subscriptionLabel: string
  subscriptionTone: 'success' | 'danger' | 'neutral'
  subscriptionSub: string
  groupValue: string
  groupSub: string
  validity?: string | null
  onOpenNodes: () => void
}

export function HomeDashboard({ reminder, subscriptionLabel, subscriptionTone, subscriptionSub, groupValue, groupSub, validity, onOpenNodes }: HomeDashboardProps) {
  return <>
    {reminder ? <p role="status">{reminder}</p> : null}
    <div className="user-stat-grid upd-stat-grid">
      <StatCard label="订阅" value={<StatusPill tone={subscriptionTone}>{subscriptionLabel}</StatusPill>} sub={subscriptionSub} />
      <StatCard label="分组 / 节点" value={groupValue} sub={groupSub} onClick={onOpenNodes} />
    </div>
    {validity ? <p className="upd-home-validity">{validity}</p> : null}
  </>
}

export function HomePage() {
  const navigate = useNavigate()
  const { user } = useSession()
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [notices, setNotices] = useState<Notice[]>(() => peekApi<{ notices: Notice[] }>('/api/notices')?.notices ?? [])
  const [counts, setCounts] = useState(() => peekApi<{ total: number; groupOptions: { id: string }[] }>('/api/user/nodes?page=1&pageSize=1') ?? { total: 0, groupOptions: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      await Promise.all([
        api<{ subscriptions: AdminSubscription[] }>('/api/account/subscriptions')
          .then((result) => setSubscriptions(result.subscriptions)),
        watchApi<{ total: number; groupOptions: { id: string }[] }>('/api/user/nodes?page=1&pageSize=1', setCounts),
      ])
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载首页失败') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void watchApi<{ notices: Notice[] }>('/api/notices', (result) => setNotices(result.notices)).catch(() => setNotices([])) }, [])
  const active = subscriptions.filter(subscription => subscription.planState === 'active')
  const current = active[0] ?? subscriptions[0]
  const nextExpiry = active.reduce<number | null>((earliest, subscription) => subscription.expiresAt === null
    ? earliest : Math.min(earliest ?? Infinity, subscription.expiresAt), null)
  const remaining = nextExpiry === null ? null : Math.max(0, Math.ceil((nextExpiry - Date.now()) / 86400000))
  const expiry = current ? getExpiryState(current) : null
  const valid = active.length > 0
  const subscriptionLabel = valid ? '有效' : expiry?.kind === 'expired' ? '已过期' : expiry?.kind === 'pending' ? '待生效' : current?.planState === 'disabled' || current?.planState === 'revoked' ? '已停用' : '未开通'
  const validity = nextExpiry !== null && remaining !== null ? `有效期剩余 ${remaining} 天` : null
  return <div className="page-stack nav-home upd-page upd-home">
    <PageHero title="首页" actions={<Link className="button primary" to="/subscriptions">打开订阅</Link>} />
    {loading ? <LoadingState label="正在加载首页" /> : error ? <ErrorState message={error} onRetry={() => { void load() }} /> : <>
      <HomeDashboard
        reminder={remaining !== null && remaining <= 7 && reminderEnabled(user?.id) ? `订阅将在 ${remaining} 天内到期，请联系管理员续期` : null}
        subscriptionLabel={subscriptionLabel}
        subscriptionTone={valid ? 'success' : expiry?.kind === 'expired' ? 'danger' : 'neutral'}
        subscriptionSub={current?.planName ?? '未分配计划'}
        groupValue={`${valid ? counts.groupOptions.length : 0} / ${valid ? counts.total : 0}`}
        groupSub={valid ? '可用分组 / 节点总数' : '需要有效订阅才能查看节点'}
        validity={validity}
        onOpenNodes={() => navigate('/nodes')}
      />
      {current ? <p className="upd-home-import"><Link to="/subscriptions">导入客户端</Link></p> : null}
    </>}
    <NoticeCarousel items={notices.map(notice => ({ id: String(notice.id), title: notice.title }))} onSelect={id => navigate(`/notices?notice=${encodeURIComponent(id)}`)} labels={{ previous: '上一条公告', next: '下一条公告', close: '关闭公告' }} />
    <nav className="user-quick-grid" aria-label="快捷入口">
      <QuickEntryCard icon={<Network />} title="节点" desc="可用节点" href="/nodes" />
    </nav>
  </div>
}
