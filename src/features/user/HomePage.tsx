import { Network } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type AdminSubscription } from '../../app/api'
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
import { entitlementLabels, type EntitlementState } from '../entitlements/types'
import { reminderEnabled } from './reminder'

type HomeDashboardProps = {
  reminder: string | null
  entitlementName: string
  entitlementSub: string
  entitlementPercent: number
  entitlementTone: 'normal' | 'danger'
  subscriptionLabel: string
  subscriptionTone: 'success' | 'danger' | 'neutral'
  subscriptionSub: string
  groupValue: string
  groupSub: string
  onOpenNodes: () => void
}

export function HomeDashboard({ reminder, entitlementName, entitlementSub, entitlementPercent, entitlementTone, subscriptionLabel, subscriptionTone, subscriptionSub, groupValue, groupSub, onOpenNodes }: HomeDashboardProps) {
  return <>
    {reminder ? <p role="status">{reminder}</p> : null}
    <div className="user-stat-grid upd-stat-grid">
      <StatCard label="权益" value={entitlementName} sub={entitlementSub} variant="bar" percent={entitlementPercent} tone={entitlementTone} />
      <StatCard label="订阅" value={<StatusPill tone={subscriptionTone}>{subscriptionLabel}</StatusPill>} sub={subscriptionSub} footer={<Link to="/subscriptions">打开订阅</Link>} />
      <StatCard label="分组 / 节点" value={groupValue} sub={groupSub} onClick={onOpenNodes} />
    </div>
  </>
}

export function HomePage() {
  const navigate = useNavigate()
  const { user } = useSession()
  const [rights, setRights] = useState<EntitlementState | null>(null)
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [counts, setCounts] = useState({ total: 0, groupOptions: [] as { id: string }[] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [r, s, n] = await Promise.all([
        api<EntitlementState>('/api/account/entitlement'),
        api<{ subscriptions: AdminSubscription[] }>('/api/account/subscriptions'),
        api<{ total: number; groupOptions: { id: string }[] }>('/api/user/nodes?page=1&pageSize=1'),
      ])
      setRights(r); setSubscriptions(s.subscriptions); setCounts(n)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载首页失败') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { api<{ notices: Notice[] }>('/api/notices').then(r => setNotices(r.notices)).catch(() => setNotices([])) }, [])
  const current = subscriptions[0]
  const entitlement = rights?.current ?? rights?.latest
  const remaining = entitlement ? Math.max(0, Math.ceil((Date.parse(entitlement.expiresAt) - Date.now()) / 86400000)) : 0
  const duration = entitlement ? (Date.parse(entitlement.expiresAt) - Date.parse(entitlement.startsAt)) / 86400000 : 0
  const valid = !!rights?.current
  const expiry = current ? getExpiryState(current) : null
  const subscriptionValid = valid && current?.enabled && expiry?.kind !== 'expired' && expiry?.kind !== 'pending'
  const subscriptionLabel = subscriptionValid ? '有效' : expiry?.kind === 'expired' || rights?.state === 'expired' ? '已过期' : current && !current.enabled ? '已停用' : expiry?.kind === 'pending' ? '待生效' : '未开通'
  return <div className="page-stack nav-home upd-page upd-home">
    <PageHero title="首页" subtitle={rights ? entitlementLabels[rights.state] : '正在读取账户状态'} actions={<Link className="button primary" to="/subscriptions">打开订阅</Link>} />
    <NoticeCarousel items={notices.map(notice => ({ id: String(notice.id), title: notice.title }))} onSelect={id => navigate(`/notices?notice=${encodeURIComponent(id)}`)} labels={{ previous: '上一条公告', next: '下一条公告', close: '关闭公告' }} />
    {loading ? <LoadingState label="正在加载首页" /> : error ? <ErrorState message={error} onRetry={() => { void load() }} /> : <HomeDashboard
      reminder={valid && remaining <= 7 && reminderEnabled(user?.id) ? `权益将在 ${remaining} 天内到期，请联系管理员续期` : null}
      entitlementName={entitlement?.plan.name ?? '未开通'}
      entitlementSub={entitlement ? `${new Date(entitlement.expiresAt).toLocaleDateString('zh-CN')} 到期 · 剩余 ${remaining} 天` : '未开通'}
      entitlementPercent={valid && duration > 0 ? remaining / duration * 100 : 0}
      entitlementTone={rights?.state === 'expired' ? 'danger' : 'normal'}
      subscriptionLabel={subscriptionLabel}
      subscriptionTone={subscriptionValid ? 'success' : rights?.state === 'expired' || expiry?.kind === 'expired' ? 'danger' : 'neutral'}
      subscriptionSub={`${valid ? counts.groupOptions.length : 0} 个分组 · ${valid ? counts.total : 0} 个节点`}
      groupValue={`${valid ? counts.groupOptions.length : 0} / ${valid ? counts.total : 0}`}
      groupSub={valid ? '可用分组 / 节点总数' : '需要有效权益才能查看节点'}
      onOpenNodes={() => navigate('/nodes')}
    />}
    <nav className="user-quick-grid" aria-label="快捷入口">
      <QuickEntryCard icon={<Network />} title="节点" desc="查看当前可用节点" href="/nodes" />
    </nav>
  </div>
}
