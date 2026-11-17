import { Download, Megaphone, MessageSquare, Network, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type AdminSubscription } from '../../app/api'
import { useSession } from '../../app/session'
import { CopyButton } from '../../ui/CopyButton'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { NoticeCarousel } from '../../ui/NoticeCarousel'
import { StatCard } from '../../ui/StatCard'
import { StatusPill } from '../../ui/StatusPill'
import { QuickEntryCard } from '../../ui/QuickEntryCard'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { useDownloadsEnabled } from '../apps/downloads-visibility'
import { CLIENT_LABELS, orderLinkEntries, pickPrimaryLink, useEnabledPlatforms } from '../delivery/platforms'
import { getExpiryState } from '../delivery/expiry'
import type { Notice } from '../notices/types'
import { entitlementLabels, type EntitlementState } from '../entitlements/types'
import { SubscriptionReset } from './SubscriptionReset'
import { reminderEnabled } from './reminder'
import { clientImportLink } from './client-import'

export function HomePage() {
  const navigate = useNavigate()
  const { user } = useSession()
  const downloadsEnabled = useDownloadsEnabled()
  const platforms = useEnabledPlatforms()
  const [rights, setRights] = useState<EntitlementState | null>(null)
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [counts, setCounts] = useState({ total: 0, groupOptions: [] as { id: string }[] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [client, setClient] = useState('')
  const [qr, setQr] = useState('')
  const [qrError, setQrError] = useState('')
  const [reset, setReset] = useState(false)
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
  const entries = current ? orderLinkEntries(Object.entries(current.links).filter(([key]) => key !== 'generic'), platforms) : []
  const primary = current ? pickPrimaryLink(current.links, current.defaultClient, platforms) : ''
  const activeClient = entries.some(([key]) => key === client) ? client : entries.find(([, value]) => value === primary)?.[0] ?? entries[0]?.[0] ?? ''
  const activeLink = entries.find(([key]) => key === activeClient)?.[1] ?? ''
  useEffect(() => {
    let live = true
    setQr(''); setQrError('')
    if (activeLink) void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(activeLink, { width: 240, margin: 2 })).then(value => { if (live) setQr(value) }).catch(() => { if (live) setQrError('二维码生成失败') })
    return () => { live = false }
  }, [activeLink])
  const entitlement = rights?.current ?? rights?.latest
  const remaining = entitlement ? Math.max(0, Math.ceil((Date.parse(entitlement.expiresAt) - Date.now()) / 86400000)) : 0
  const duration = entitlement ? (Date.parse(entitlement.expiresAt) - Date.parse(entitlement.startsAt)) / 86400000 : 0
  const valid = !!rights?.current
  const expiry = current ? getExpiryState(current) : null
  const subscriptionValid = valid && current?.enabled && expiry?.kind !== 'expired' && expiry?.kind !== 'pending'
  const importLink = clientImportLink(activeClient, activeLink)
  return <div className="page-stack nav-home">
    <PageHero title="首页" subtitle={rights ? entitlementLabels[rights.state] : '正在读取账户状态'} actions={<Link className="button primary" to="/subscriptions">管理订阅</Link>} />
    <NoticeCarousel items={notices.map(notice => ({ id: String(notice.id), title: notice.title }))} onSelect={() => navigate('/notices')} labels={{ previous: '上一条公告', next: '下一条公告', close: '关闭公告' }} />
    {loading ? <LoadingState label="正在加载首页" /> : error ? <ErrorState message={error} onRetry={() => { void load() }} /> : <>
      {valid && remaining <= 7 && reminderEnabled(user?.id) ? <p role="status">权益将在 {remaining} 天内到期，请联系管理员续期</p> : null}
      <div className="user-stat-grid">
        <StatCard label="权益" value={entitlement?.plan.name ?? '未开通'} sub={entitlement ? `${new Date(entitlement.expiresAt).toLocaleDateString('zh-CN')} 到期 · 剩余 ${remaining} 天` : '未开通'} variant="bar" percent={valid && duration > 0 ? remaining / duration * 100 : 0} tone={rights?.state === 'expired' ? 'danger' : 'normal'} />
        <StatCard label="订阅" value={<StatusPill tone={subscriptionValid ? 'success' : rights?.state === 'expired' || expiry?.kind === 'expired' ? 'danger' : 'neutral'}>{subscriptionValid ? '有效' : expiry?.kind === 'expired' || rights?.state === 'expired' ? '已过期' : current && !current.enabled ? '已停用' : expiry?.kind === 'pending' ? '待生效' : '未开通'}</StatusPill>} sub={`${valid ? counts.groupOptions.length : 0} 个分组 · ${valid ? counts.total : 0} 个节点`} footer={activeLink ? <CopyButton variant="full-width" label="复制订阅链接" value={activeLink} onError={() => setError('复制失败，请手动选择链接')} /> : '暂无订阅链接'} />
        <StatCard label="分组 / 节点" value={`${valid ? counts.groupOptions.length : 0} / ${valid ? counts.total : 0}`} sub={valid ? '可用分组 / 节点总数' : '需要有效权益才能查看节点'} onClick={() => navigate('/nodes')} />
      </div>
      <section className="data-section user-subscription-card" aria-labelledby="home-subscription-title">
        <h2 id="home-subscription-title">我的订阅</h2>
        {activeLink ? <div className="user-subscription-content"><div className="user-subscription-main">
          <div className="nav-seg-scroll"><SegmentedControl label="客户端平台" value={activeClient} options={entries.map(([key]) => ({ value: key, label: platforms.names[key] ?? CLIENT_LABELS[key] ?? key }))} onChange={setClient} /></div>
          <p className="nav-link-text user-link-code">{activeLink}</p>
          <div className="user-link-actions"><CopyButton variant="full-width" value={activeLink} onError={() => setError('复制失败，请手动选择链接')} />{importLink ? <a className="button primary" href={importLink}>一键导入</a> : <button className="button primary" disabled title="请选择支持导入的客户端平台">一键导入</button>}</div>
          {!importLink ? <p className="profile-hint">请选择支持导入的客户端平台，或复制链接手动添加</p> : null}
        </div><div className="user-qr">{qr ? <img src={qr} alt="订阅二维码" width={180} height={180} /> : <p role="status">{qrError || '正在生成二维码'}</p>}</div></div> : <p className="section-empty">{current?.linkError ? '订阅域名尚未配置，请联系管理员' : '暂无订阅链接'}</p>}
      </section>
    </>}
    <nav className="user-quick-grid" aria-label="快捷入口">
      <QuickEntryCard icon={<MessageSquare />} title="工单" desc="联系管理员获取支持" href="/tickets" />
      <QuickEntryCard icon={<Megaphone />} title="公告" desc="查看最新服务通知" href="/notices" />
      <QuickEntryCard icon={<Network />} title="节点" desc="查看当前可用节点" href="/nodes" />
      {downloadsEnabled ? <QuickEntryCard icon={<Download />} title="APP 下载" desc="选择适合设备的客户端" href="/apps" /> : null}
      <QuickEntryCard icon={<RefreshCw />} title="重置订阅" desc="重置后旧链接立即失效" onClick={() => setReset(true)} />
    </nav>
    <SubscriptionReset open={reset} onClose={() => setReset(false)} onUpdated={() => { void load() }} />
  </div>
}
