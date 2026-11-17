import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../app/api'
import { useSession } from '../../app/session'
import { AccountPage } from '../accounts/AccountPage'
import { useAccountProfile, formatProfileDate } from '../accounts/profile'
import { entitlementLabels, type EntitlementState } from '../entitlements/types'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { Switch } from '../../ui/Switch'
import { SubscriptionReset } from './SubscriptionReset'
import { reminderEnabled, reminderKey } from './reminder'

export function MinePage() {
  const { user } = useSession()
  const { profile, error, reload } = useAccountProfile()
  const [rights, setRights] = useState<EntitlementState | null>(null)
  const [rightsError, setRightsError] = useState('')
  const [reminder, setReminder] = useState(() => reminderEnabled(user?.id))
  const [preferenceError, setPreferenceError] = useState('')
  const [reset, setReset] = useState(false)
  useEffect(() => { api<EntitlementState>('/api/account/entitlement').then(setRights).catch(cause => setRightsError(cause instanceof Error ? cause.message : '加载权益失败')) }, [])
  const updateReminder = (checked: boolean) => {
    try { localStorage.setItem(reminderKey(user?.id), checked ? '1' : '0'); setReminder(checked); setPreferenceError('') }
    catch { setPreferenceError('浏览器无法保存提醒设置') }
  }
  return <div className="page-stack">
    <PageHero title="个人中心" subtitle={profile?.user.email ?? user?.username} actions={<Link className="button secondary" to="/subscriptions">管理订阅</Link>} />
    <div className="user-account-grid">
      <div className="page-stack">
        <section className="data-section user-account-card" aria-label="账户信息"><h2>账户信息</h2>
          {profile ? <><img className="profile-avatar" src={profile.avatar.url} alt="" width={56} height={56} /><dl className="profile-fields">
            <div><dt>邮箱</dt><dd>{profile.user.email ?? '未绑定'}</dd></div>
            <div><dt>权益</dt><dd>{rightsError || (rights ? rights.current?.plan.name ?? entitlementLabels[rights.state] : '正在加载权益')}</dd></div>
            <div><dt>到期</dt><dd>{formatProfileDate((rights?.current ?? rights?.latest)?.expiresAt)}</dd></div>
          </dl></> : error ? <ErrorState message={error} onRetry={() => { void reload() }} /> : <LoadingState label="正在加载账户资料" />}
        </section>
        <section className="data-section user-account-card"><h2>通知设置</h2><Switch label="到期提醒" checked={reminder} onChange={updateReminder} /><p className="profile-hint">仅保存在此浏览器，权益到期前 7 天在首页提醒</p>{preferenceError ? <p role="alert">{preferenceError}</p> : null}</section>
        <section className="data-section user-account-card"><h2>订阅操作</h2><p>重置后旧链接立即失效，请重新添加到客户端</p><button className="button danger" onClick={() => setReset(true)}>重置订阅</button></section>
      </div>
      <section className="page-stack" aria-label="安全"><h2>安全</h2><AccountPage embedded /></section>
    </div>
    <SubscriptionReset open={reset} onClose={() => setReset(false)} />
  </div>
}
