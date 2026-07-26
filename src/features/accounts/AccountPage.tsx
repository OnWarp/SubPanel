import { KeyRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { useSession } from '../../app/session'
import { DataHeader } from '../../ui/DataHeader'
import { PageHeader } from '../../ui/PageHeader'

export function AccountPage() {
  const { user, refresh } = useSession()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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
      formElement.reset()
      setMessage('密码已更新，其他会话已退出。')
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '密码更新失败')
    }
  }

  return (
    <div className="page-stack account-workspace">
      <PageHeader title="账户安全" description={<>当前账户：<strong>{user?.username}</strong></>} />
      <section className="data-section security-section">
        <DataHeader title="修改密码" />
        <form className="security-form" onSubmit={changePassword}>
          <label className="field"><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label className="field"><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <label className="field"><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          {error ? <p className="form-message error" role="alert">{error}</p> : null}
          {message ? <p className="form-message success" role="status">{message}</p> : null}
          <div><button className="button primary" type="submit"><KeyRound aria-hidden="true" size={17} />更新密码</button></div>
        </form>
      </section>
    </div>
  )
}
