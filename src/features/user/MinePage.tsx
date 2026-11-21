import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MobileBarOptions } from '../../app/MobileBarOptions'
import { useSession } from '../../app/session'
import { AccountPage } from '../accounts/AccountPage'
import { useAccountProfile } from '../accounts/profile'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { Switch } from '../../ui/Switch'
import { useDownloadsEnabled } from '../apps/downloads-visibility'
import { reminderEnabled, reminderKey } from './reminder'

export function MinePage() {
  const { user } = useSession()
  const { profile, error, reload } = useAccountProfile()
  const [reminder, setReminder] = useState(() => reminderEnabled(user?.id))
  const [preferenceError, setPreferenceError] = useState('')
  const downloadsEnabled = useDownloadsEnabled()
  const updateReminder = (checked: boolean) => {
    try { localStorage.setItem(reminderKey(user?.id), checked ? '1' : '0'); setReminder(checked); setPreferenceError('') }
    catch { setPreferenceError('浏览器无法保存提醒设置') }
  }
  return <div className="page-stack upd-page upd-mine">
    <PageHero title="个人中心" subtitle={profile?.user.email ?? user?.username} actions={<Link className="button primary" to="/subscriptions">管理订阅</Link>} />
    <div className="user-account-grid">
      <div className="page-stack">
        <section className="data-section user-account-card" aria-label="账户信息"><h2>账户信息</h2>
          {profile ? <><img className="profile-avatar" src={profile.avatar.url} alt="" width={56} height={56} /><dl className="key-value-rows">
            <div><dt>用户名</dt><dd>{profile.user.username}</dd></div>
            <div><dt>邮箱</dt><dd>{profile.user.email ?? '未绑定'}</dd></div>
          </dl></> : error ? <ErrorState message={error} onRetry={() => { void reload() }} /> : <LoadingState label="正在加载账户资料" />}
        </section>
        <section className="data-section user-account-card"><h2>通知设置</h2><Switch label="到期提醒" checked={reminder} onChange={updateReminder} /><p className="profile-hint">仅保存在此浏览器，订阅到期前 7 天在首页提醒</p>{preferenceError ? <p role="alert">{preferenceError}</p> : null}</section>
        <section className="data-section user-account-card mobile-bar-settings"><h2>显示设置</h2><MobileBarOptions /></section>
        <section className="data-section user-account-card"><h2>帮助与支持</h2><nav className="upd-link-row" aria-label="帮助与支持"><Link className="button ghost" to="/notices">公告</Link><Link className="button ghost" to="/kb">知识库</Link><Link className="button ghost" to="/tickets">工单</Link>{downloadsEnabled ? <Link className="button ghost" to="/apps">客户端下载</Link> : null}</nav></section>
      </div>
      <section className="page-stack" aria-label="安全"><h2>安全</h2><AccountPage embedded /></section>
    </div>
  </div>
}
