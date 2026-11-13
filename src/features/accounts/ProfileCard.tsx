import type { AccountProfile } from '../../app/api'
import { StatusBadge } from '../../ui/StatusBadge'
import { formatProfileDate } from './profile'

export function ProfileCard({ profile }: { profile: AccountProfile }) {
  const roleLabel = profile.user.role === 'admin' ? '管理员' : '用户'
  return (
    <section className="data-section profile-card" aria-label="账户资料">
      <img className="profile-avatar" src={profile.avatar.url} alt="" width={56} height={56} />
      <div className="profile-card-main">
        <div className="profile-card-name">
          <strong>{profile.user.username}</strong>
          <StatusBadge tone={profile.user.role === 'admin' ? 'warning' : 'info'} size="sm">
            {roleLabel}
          </StatusBadge>
        </div>
        <dl className="profile-fields">
          <div>
            <dt>邮箱</dt>
            <dd>{profile.emailBound ? profile.user.email : '未绑定'}</dd>
          </div>
          <div>
            <dt>注册时间</dt>
            <dd>{formatProfileDate(profile.user.createdAt)}</dd>
          </div>
        </dl>
        {profile.user.role === 'admin' && !profile.emailBound ? (
          <p className="profile-hint">绑定邮箱后，管理员头像将显示 Gravatar</p>
        ) : null}
      </div>
    </section>
  )
}
