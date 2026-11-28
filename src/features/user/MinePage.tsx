import { ArrowLeft, Bell, ChevronRight, LifeBuoy, Monitor, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { MobileBarOptions } from '../../app/MobileBarOptions'
import { useSession } from '../../app/session'
import { ErrorState } from '../../ui/ErrorState'
import { Skeleton } from '../../ui/LoadingState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { Switch } from '../../ui/Switch'
import { AccountPage } from '../accounts/AccountPage'
import { useAccountProfile } from '../accounts/profile'
import { useDownloadsEnabled } from '../apps/downloads-visibility'
import {
  accessStatusLabels, expiringSoonText, formatPlanDate, planStatusLine, type PlanOverview, type PlanSummary,
} from '../plans/my-plan-model'
import { usePlanOverview } from '../plans/use-plan-overview'
import { reminderEnabled, reminderKey } from './reminder'

function MineFrame({ title, width = 'detail', children }: { title: string; width?: 'list' | 'detail' | 'form'; children: ReactNode }) {
  return (
    <PageContainer width={width}>
      <div className="page-stack upd-page upd-mine">
        <PageHeader title={title} />
        {children}
      </div>
    </PageContainer>
  )
}

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
  { path: 'support', label: '帮助与支持', icon: LifeBuoy, Content: SupportSettings },
] as const

// Old links keep working: subscription info moves to the subscription page and
// the old redemption entry becomes My Plans.
const mineRedirects: Record<string, string> = {
  subscription: '/subscriptions',
  subscriptions: '/subscriptions',
  redemption: '/me/plans',
}

export function MineSettingsPage() {
  const { section } = useParams()
  const redirect = section ? mineRedirects[section] : undefined
  if (redirect) return <Navigate to={redirect} replace />
  const setting = mineSettings.find(item => item.path === section)
  if (!setting) return <Navigate to="/me" replace />
  const { label, Content } = setting
  return (
    <PageContainer width="form">
      <div className="page-stack upd-page upd-mine">
        <PageHeader title={label} leading={<Link className="upd-mine-back" to="/me"><ArrowLeft size={16} aria-hidden="true" />个人中心</Link>} />
        <Content />
      </div>
    </PageContainer>
  )
}

function ProfileHeader({ overview }: { overview: PlanOverview }) {
  const { profile } = useAccountProfile()
  const avatar = overview.user.avatarUrl ?? profile?.avatar.url
  return <section className="upd-mine-profile" aria-label="账户信息">
    {avatar
      ? <img className="profile-avatar" src={avatar} alt="" width={48} height={48} />
      : <span className="upd-mine-avatar-fallback" aria-hidden="true" />}
    <div className="upd-mine-profile-text">
      <strong title={overview.user.username}>{overview.user.username}</strong>
      <span title={overview.user.email ?? undefined}>{overview.user.email ?? '未绑定邮箱'}</span>
    </div>
  </section>
}

function PlanOverviewCard({ plans, now }: { plans: PlanSummary; now: number }) {
  const heading = plans.accessStatus === 'active'
    ? plans.hasPermanentActivePlan ? '订阅有效期' : '订阅有效期至'
    : '订阅状态'
  const bigValue = plans.accessStatus === 'active'
    ? plans.hasPermanentActivePlan ? '长期有效' : plans.validUntil === null ? '—' : formatPlanDate(plans.validUntil)
    : planStatusLine(plans)
  const soon = expiringSoonText(plans, now)
  const status = accessStatusLabels[plans.accessStatus]
  const tone = plans.accessStatus === 'active' ? 'is-success' : plans.accessStatus === 'expired' ? 'is-muted' : 'is-neutral'
  return <section className="upd-mine-overview" aria-label="套餐概览">
    <div className="upd-mine-overview-top">
      <p className="upd-mine-caption">{heading}</p>
      <p className={`upd-mine-date ${tone}`}><strong>{bigValue}</strong><span className={`upd-mine-status ${tone}`}>{status}</span></p>
      {soon ? <p className="upd-mine-hint">{soon}</p> : null}
    </div>
    <MyPlansRow plans={plans} />
  </section>
}

function MyPlansRow({ plans }: { plans?: PlanSummary }) {
  const countLine = plans === undefined ? '正在加载套餐'
    : plans.total === 0 ? '暂无套餐'
      : [plans.active ? `${plans.active} 个有效` : '', plans.expired ? `${plans.expired} 个已过期` : '',
        plans.pending ? `${plans.pending} 个待生效` : '', plans.disabled ? `${plans.disabled} 个已停用` : '']
        .filter(Boolean).join(' · ')
  return <Link className="upd-mine-overview-link" to="/me/plans">
    <div>
      <p className="upd-mine-caption">我的套餐</p>
      <p className="upd-mine-count"><strong>{plans?.total ?? '—'}</strong> 个套餐</p>
      <p className="upd-mine-subcount">{countLine}</p>
    </div>
    <ChevronRight size={18} aria-hidden="true" />
  </Link>
}

function OverviewSkeleton() {
  return <section className="upd-mine-overview upd-mine-skeleton" aria-busy="true" aria-label="套餐概览">
    <div className="upd-mine-overview-top"><Skeleton /></div>
    <MyPlansRow />
  </section>
}

export function MinePage() {
  const { state, reload } = usePlanOverview()
  return <MineFrame title="个人中心">
    {state.kind === 'ready' ? <>
      <ProfileHeader overview={state.overview} />
      <PlanOverviewCard plans={state.overview.plans} now={Date.now()} />
    </> : state.kind === 'error' ? <>
      {/* The account settings and the plans link stay usable when only the
          overview request fails; the retry is local to this card. */}
      <section className="upd-mine-overview" aria-label="套餐概览">
        <div className="upd-mine-overview-top">
          <ErrorState message={state.message} onRetry={reload} />
        </div>
        <MyPlansRow />
      </section>
    </> : <OverviewSkeleton />}
    <nav className="upd-mine-menu" aria-label="设置">
      {mineSettings.map(({ path, label, icon: Icon }) => (
        <Link key={path} to={`/me/${path}`}>
          <Icon size={19} aria-hidden="true" />
          <span>{label}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </Link>
      ))}
    </nav>
  </MineFrame>
}
