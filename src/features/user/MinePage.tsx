import { ChevronRight, Download, LogOut, Network, Share2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiClientError } from '../../app/api'
import { useSession } from '../../app/session'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { ProfileCard } from '../accounts/ProfileCard'
import { formatProfileDate, useAccountProfile } from '../accounts/profile'

export function MinePage() {
  const { user, logout } = useSession()
  const { profile } = useAccountProfile()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false)
  const roleLabel = user?.role === 'admin' ? '管理员' : '用户'

  const signOut = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await logout()
      navigate('/login', { replace: true })
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '退出登录失败')
      setBusy(false)
    }
  }

  const logoutAll = async () => {
    try {
      await api('/api/account/logout-all', { method: 'POST', body: '{}' })
      window.location.assign('/login')
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '退出全部设备失败')
      setConfirmLogoutAll(false)
    }
  }

  return (
    <div className="page-stack nav-mine">
      <PageHeader title="我的" description="资料、会话与账户安全" />
      {profile ? (
        <ProfileCard profile={profile} />
      ) : (
        <section className="data-section nav-profile" aria-label="当前用户">
          <span className="nav-profile-mark" aria-hidden="true">
            <ShieldCheck size={20} />
          </span>
          <div className="nav-profile-id">
            <strong>{user?.username}</strong>
            <StatusBadge tone={user?.role === 'admin' ? 'warning' : 'info'} size="sm">{roleLabel}</StatusBadge>
          </div>
        </section>
      )}
      <section className="data-section profile-session" aria-label="会话与安全">
        <div className="profile-session-info">
          <strong>会话与安全</strong>
          {profile?.session ? (
            <span>本次登录 {formatProfileDate(profile.session.issuedAt)}，{formatProfileDate(profile.session.expiresAt)} 过期</span>
          ) : (
            <span>会话信息加载中</span>
          )}
        </div>
        <button className="button danger" type="button" onClick={() => setConfirmLogoutAll(true)}>
          <LogOut aria-hidden="true" size={16} />
          退出全部设备
        </button>
      </section>
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      <nav className="data-section nav-menu" aria-label="我的入口">
        <Link className="nav-menu-item" to="/account">
          <ShieldCheck aria-hidden="true" size={18} />
          <span>账户安全</span>
          <ChevronRight className="nav-menu-chevron" aria-hidden="true" size={16} />
        </Link>
        <Link className="nav-menu-item" to="/subscriptions">
          <Share2 aria-hidden="true" size={18} />
          <span>我的分享</span>
          <ChevronRight className="nav-menu-chevron" aria-hidden="true" size={16} />
        </Link>
        <Link className="nav-menu-item" to="/nodes">
          <Network aria-hidden="true" size={18} />
          <span>我的节点</span>
          <ChevronRight className="nav-menu-chevron" aria-hidden="true" size={16} />
        </Link>
        <Link className="nav-menu-item" to="/apps">
          <Download aria-hidden="true" size={18} />
          <span>APP 下载</span>
          <ChevronRight className="nav-menu-chevron" aria-hidden="true" size={16} />
        </Link>
        <button className="nav-menu-item" type="button" disabled={busy} onClick={() => { signOut().catch(() => undefined) }}>
          <LogOut aria-hidden="true" size={18} />
          <span>退出登录</span>
        </button>
      </nav>
      <ConfirmDialog
        open={confirmLogoutAll}
        title="退出全部设备"
        description="所有设备上的会话都会失效，包括当前设备，需要重新登录"
        confirmLabel="退出全部设备"
        danger
        busy={busy}
        onClose={() => setConfirmLogoutAll(false)}
        onConfirm={() => { logoutAll().catch(() => undefined) }}
      />
    </div>
  )
}
