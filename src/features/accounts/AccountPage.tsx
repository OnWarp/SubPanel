import { KeyRound, LogOut } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { Button } from '../../ui/Button'
import { useSession } from '../../app/session'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusMessage } from '../../ui/StatusMessage'
import { EmailBindChangeForm } from './EmailBindChangeForm'
import { ProfileCard } from './ProfileCard'
import { formatProfileDate, useAccountProfile } from './profile'

export function AccountPage() {
  const { refresh } = useSession()
  const { profile, error: profileError, reload } = useAccountProfile()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    setError('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const newPassword = String(form.get('newPassword'))
    if (newPassword !== String(form.get('confirmPassword'))) {
      setError('两次输入的新密码不一致')
      return
    }
    try {
      await api('/api/account/password', {
        method: 'POST',
        body: jsonBody({ currentPassword: form.get('currentPassword'), newPassword }),
      })
      await refresh()
      await reload()
      formElement.reset()
      setMessage('密码已更新，其他会话已退出')
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '密码更新失败')
    }
  }

  const logoutAll = async () => {
    setLogoutBusy(true)
    try {
      await api('/api/account/logout-all', { method: 'POST', body: '{}' })
      window.location.assign('/login')
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '退出全部设备失败')
      setLogoutBusy(false)
      setConfirmLogoutAll(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="个人中心" />
      {profile ? (
        <ProfileCard profile={profile} />
      ) : profileError ? (
        <ErrorState message={profileError} onRetry={() => { reload().catch(() => undefined) }} />
      ) : (
        <LoadingState label="正在加载账户资料" />
      )}
      <section className="data-section security-section">
        <DataHeader title="修改密码" />
        <form className="security-form adm-account-form" onSubmit={changePassword}>
          <FormField label="当前密码" htmlFor="account-current-password">
            <input id="account-current-password" name="currentPassword" type="password" autoComplete="current-password" required />
          </FormField>
          <FormField label="新密码" htmlFor="account-new-password">
            <input id="account-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
          </FormField>
          <FormField label="确认新密码" htmlFor="account-confirm-password">
            <input id="account-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
          </FormField>
          {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
          {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
          <div className="form-actions"><Button variant="primary" type="submit"><KeyRound aria-hidden="true" size={17} />更新密码</Button></div>
        </form>
      </section>
      {profile ? (
        <section className="data-section security-section">
          <DataHeader title={profile.emailBound ? '更换邮箱' : '绑定邮箱'} />
          <EmailBindChangeForm
            profile={profile}
            onUpdated={async () => {
              await reload()
              await refresh()
            }}
          />
        </section>
      ) : null}
      <section className="data-section security-section">
        <DataHeader title="会话与安全" />
        <div className="security-form">
          {profile?.session ? (
            <dl className="profile-fields">
              <div>
                <dt>本次登录</dt>
                <dd>{formatProfileDate(profile.session.issuedAt)}</dd>
              </div>
              <div>
                <dt>会话过期</dt>
                <dd>{formatProfileDate(profile.session.expiresAt)}</dd>
              </div>
            </dl>
          ) : (
            <p className="profile-hint">会话信息加载中</p>
          )}
          <div>
            <Button variant="danger" onClick={() => setConfirmLogoutAll(true)}>
              <LogOut aria-hidden="true" size={17} />
              退出全部设备
            </Button>
          </div>
        </div>
      </section>
      <ConfirmDialog
        open={confirmLogoutAll}
        title="退出全部设备"
        description="所有设备上的会话都会失效，包括当前设备，需要重新登录"
        confirmLabel="退出全部设备"
        danger
        busy={logoutBusy}
        onClose={() => setConfirmLogoutAll(false)}
        onConfirm={() => { logoutAll().catch(() => undefined) }}
      />
    </div>
  )
}
