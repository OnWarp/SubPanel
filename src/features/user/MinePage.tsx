import { ArrowLeft, Bell, ChevronRight, Gift, LifeBuoy, Monitor, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { api, ApiClientError, jsonBody, type AdminSubscription } from '../../app/api'
import { MobileBarOptions } from '../../app/MobileBarOptions'
import { useSession } from '../../app/session'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { Switch } from '../../ui/Switch'
import { AccountPage } from '../accounts/AccountPage'
import { useAccountProfile } from '../accounts/profile'
import { useDownloadsEnabled } from '../apps/downloads-visibility'
import { formatExpiryTime } from '../delivery/expiry'
import { subscriptionPlanLabels } from '../delivery/plan-types'
import { orderLinkEntries, pickPrimaryLink, useEnabledPlatforms } from '../delivery/platforms'
import { subscriptionStatus, useUnifiedSubscription } from '../delivery/unified-subscription'
import { PersonalRedemptions } from '../redemption/PersonalRedemptions'
import { clientImportLink } from './client-import'
import { formatTrafficGb } from './home-traffic'
import { reminderEnabled, reminderKey } from './reminder'

function NotificationSettings() {
  const { user } = useSession()
  const [reminder, setReminder] = useState(() => reminderEnabled(user?.id))
  const [preferenceError, setPreferenceError] = useState('')
  const updateReminder = (checked: boolean) => {
    try {
      localStorage.setItem(reminderKey(user?.id), checked ? '1' : '0')
      setReminder(checked)
      setPreferenceError('')
    } catch {
      setPreferenceError('浏览器无法保存提醒设置')
    }
  }
  return <section className="data-section user-account-card">
    <Switch label="到期提醒" checked={reminder} onChange={updateReminder} />
    <p className="profile-hint">仅在此浏览器生效，到期前 7 天在首页提醒</p>
    {preferenceError ? <p role="alert">{preferenceError}</p> : null}
  </section>
}

function DisplaySettings() {
  return <section className="data-section user-account-card"><MobileBarOptions /></section>
}

function SupportSettings() {
  const downloadsEnabled = useDownloadsEnabled()
  return <section className="data-section user-account-card">
    <nav className="upd-link-row" aria-label="帮助与支持">
      <Link className="button ghost" to="/notices">公告</Link>
      <Link className="button ghost" to="/kb">知识库</Link>
      <Link className="button ghost" to="/tickets">工单</Link>
      {downloadsEnabled ? <Link className="button ghost" to="/apps">客户端下载</Link> : null}
    </nav>
  </section>
}

function SecuritySettings() {
  return <AccountPage embedded />
}

const mineSettings = [
  { path: 'security', label: '安全', icon: ShieldCheck, Content: SecuritySettings },
  { path: 'notifications', label: '通知设置', icon: Bell, Content: NotificationSettings },
  { path: 'display', label: '显示设置', icon: Monitor, Content: DisplaySettings },
  { path: 'redemption', label: '兑换订阅', icon: Gift, Content: RedemptionSettings },
  { path: 'support', label: '帮助与支持', icon: LifeBuoy, Content: SupportSettings },
] as const

const mineSubscriptions = { path: 'subscription', label: '订阅信息', Content: SubscriptionInfo }

export function MineSettingsPage() {
  const { section } = useParams()
  const { search, hash } = useLocation()
  if (section === 'subscriptions') return <Navigate to={{ pathname: '/me/subscription', search, hash }} replace />
  const setting = section === mineSubscriptions.path ? mineSubscriptions : mineSettings.find(item => item.path === section)
  if (!setting) return <Navigate to="/home" replace />
  const { label, Content } = setting
  return <div className="page-stack upd-page upd-mine">
    <Link className="upd-mine-back" to="/me"><ArrowLeft size={16} aria-hidden="true" />个人中心</Link>
    <PageHero title={label} />
    <Content />
  </div>
}

function isActive(subscription: AdminSubscription) {
  return subscription.status ? subscription.status === 'active'
    : subscription.planState ? subscription.planState === 'active' : subscription.enabled
}

function LegacySubscriptionOverview({ details = false }: { details?: boolean }) {
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>()
  const [error, setError] = useState('')
  const load = useCallback((signal?: AbortSignal) => {
    void api<{ subscriptions: AdminSubscription[] }>('/api/account/subscriptions', { signal })
      .then(result => {
        if (!signal?.aborted) setSubscriptions(result.subscriptions)
      })
      .catch((cause: unknown) => {
        if (!signal?.aborted) setError(cause instanceof ApiClientError ? cause.message : '订阅加载失败')
      })
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    load(abort.signal)
    return () => abort.abort()
  }, [load])

  const current = subscriptions?.find(isActive) ?? subscriptions?.[0]
  return <section className="upd-mine-panel" aria-label="订阅">
    {details ? null : <div className="upd-mine-subscription-heading">
      <h2>订阅</h2>
      <Link to="/me/subscription">订阅信息<ChevronRight size={16} aria-hidden="true" /></Link>
    </div>}
    {error ? <ErrorState message={error} onRetry={() => { setError(''); load() }} />
      : !subscriptions ? <LoadingState label="正在加载订阅" />
      : !current ? <p>暂无订阅</p>
      : <>
        <div className="upd-mine-plan">
          <strong>{current.name}</strong>
          <StatusBadge tone={isActive(current) ? 'success' : 'muted'}>
            {current.statusLabel ?? (current.planState ? subscriptionPlanLabels[current.planState] : current.enabled ? '正常' : '已停用')}
          </StatusBadge>
        </div>
        <p>{current.planName ?? current.entitlementTemplateName ?? '未分配计划'}</p>
        <dl className="upd-mine-metrics">
          <div><dt>到期时间</dt><dd>{current.expiresAt === null ? '永久有效' : formatExpiryTime(current.expiresAt)}</dd></div>
          <div><dt>剩余额度</dt><dd>{typeof current.remainingGb === 'number' && Number.isFinite(current.remainingGb) && current.remainingGb >= 0
            ? `${formatTrafficGb(current.remainingGb)} GB`
            : current.remainingGb === null || current.trafficGb === 0 ? '不限' : '暂无数据'}</dd></div>
        </dl>
        {details ? <SubscriptionLink key={current.id} subscription={current}
          onReset={(updated) => setSubscriptions(rows => rows?.map(row => row.id === updated.id ? updated : row))} /> : null}
      </>}
  </section>
}

function SubscriptionLink({ subscription, onReset }: {
  subscription: AdminSubscription
  onReset: (subscription: AdminSubscription) => void
}) {
  const platforms = useEnabledPlatforms()
  const [resetOpen, setResetOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resetError, setResetError] = useState('')
  const [resetDone, setResetDone] = useState(false)
  const resetButton = useRef<HTMLButtonElement>(null)
  const link = pickPrimaryLink(subscription.links, subscription.defaultClient, platforms)
  const entries = orderLinkEntries(Object.entries(subscription.links), platforms)
  const primaryEntry = entries.find(([, url]) => url === link)
  const primaryImport = primaryEntry ? clientImportLink(...primaryEntry) : null
  const clientImport = primaryImport ?? entries.map(entry => clientImportLink(...entry)).find(Boolean)

  async function resetLink() {
    if (busy) return
    setBusy(true)
    setResetError('')
    try {
      const result = await api<{ subscription: AdminSubscription }>(
        `/api/account/subscriptions/${subscription.id}/token/reset`,
        { method: 'POST', body: jsonBody({}) },
      )
      onReset(result.subscription)
      setResetOpen(false)
      setResetDone(true)
    } catch (cause) {
      setResetError(cause instanceof ApiClientError ? cause.message : '重置链接失败')
    } finally {
      setBusy(false)
    }
  }

  return <section className="upd-mine-subscription-link" aria-labelledby="mine-subscription-link">
    <div className="upd-mine-subscription-heading"><h2 id="mine-subscription-link">订阅链接</h2></div>
    {link ? <div className="del-link-line">
      <p className="del-link-text">{link}</p>
      <CopyButton key={link} value={link} label="复制链接" />
    </div> : <p>暂无可用链接</p>}
    <div className="upd-link-row">
      {link ? <a className="button secondary" href={clientImport ?? `/subscriptions?subscription=${encodeURIComponent(subscription.id)}`}>导入客户端</a> : null}
      <button ref={resetButton} className="button ghost" type="button" onClick={() => {
        setResetError('')
        setResetDone(false)
        setResetOpen(true)
      }}>重置链接</button>
    </div>
    {resetDone ? <StatusMessage tone="success">订阅链接已重置</StatusMessage> : null}
    <ConfirmDialog open={resetOpen} title="重置订阅链接" description="重置后旧链接会立即失效，请将新链接重新添加到客户端"
      confirmLabel="确认重置" danger busy={busy} returnFocusRef={resetButton}
      onClose={() => setResetOpen(false)} onConfirm={() => { void resetLink() }}>
      {resetError ? <StatusMessage tone="error">{resetError}</StatusMessage> : null}
    </ConfirmDialog>
  </section>
}

function RedemptionSettings() {
  const { state, reload } = useUnifiedSubscription()
  if (state.kind === 'loading') return <LoadingState label="正在加载订阅" />
  if (state.kind === 'error') return <ErrorState message={state.message} onRetry={reload} />
  return <PersonalRedemptions unified={state.kind === 'ready'} />
}

function SubscriptionOverview({ details = false }: { details?: boolean }) {
  const { state, reload } = useUnifiedSubscription()
  if (state.kind === 'legacy') return <LegacySubscriptionOverview details={details} />
  if (state.kind === 'ready') return details ? <Navigate to="/subscriptions" replace /> :
    <section className="upd-mine-panel">
      <Link to="/subscriptions">我的订阅<ChevronRight size={16} aria-hidden="true" /></Link>
      <StatusBadge tone={state.summary.status === 'active' ? 'success' : 'muted'}>{subscriptionStatus[state.summary.status]}</StatusBadge>
    </section>
  return state.kind === 'loading' ? <LoadingState label="正在加载订阅" /> : <ErrorState message={state.message} onRetry={reload} />
}

function SubscriptionInfo() {
  return <>
    <SubscriptionOverview details />
    <div className="upd-link-row"><Link className="button secondary" to="/me/redemption">兑换订阅</Link></div>
  </>
}

export function MinePage() {
  const { profile, error, reload } = useAccountProfile()

  return <div className="page-stack upd-page upd-mine">
    <PageHero title="个人中心" />
    <div className="upd-mine-overview">
      <section className="upd-mine-panel upd-mine-identity" aria-label="账户信息">
        {profile ? <>
          <img className="profile-avatar" src={profile.avatar.url} alt="" width={56} height={56} />
          <div><strong>{profile.user.username}</strong><p>{profile.user.email ?? '未绑定'}</p></div>
        </> : error ? <ErrorState message={error} onRetry={() => { void reload() }} /> : <LoadingState label="正在加载账户资料" />}
      </section>
      <SubscriptionOverview />
    </div>
    <nav className="upd-mine-menu" aria-label="设置">
      {mineSettings.map(({ path, label, icon: Icon }) => (
        <Link key={path} to={`/me/${path}`}>
          <Icon size={19} aria-hidden="true" />
          <span>{label}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </Link>
      ))}
    </nav>
  </div>
}
