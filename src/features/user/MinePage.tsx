import { ChevronRight, Download, LogOut, Share2, ShieldCheck, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiClientError } from '../../app/api'
import { useSession } from '../../app/session'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'

export function MinePage() {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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

  return (
    <div className="page-stack nav-mine">
      <PageHeader title="我的" description="账户、分享和下载" />
      <section className="data-section nav-profile" aria-label="当前用户">
        <span className="nav-profile-mark" aria-hidden="true"><UserRound size={20} /></span>
        <div className="nav-profile-id">
          <strong>{user?.username}</strong>
          <StatusBadge tone={user?.role === 'admin' ? 'warning' : 'info'} size="sm">{roleLabel}</StatusBadge>
        </div>
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
    </div>
  )
}
