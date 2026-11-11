import { KeyRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { useSession } from '../../app/session'
import { DataHeader } from '../../ui/DataHeader'
import { FormField } from '../../ui/FormField'
import { PageHeader } from '../../ui/PageHeader'
import { StatusMessage } from '../../ui/StatusMessage'

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
    <div className="page-stack">
      <PageHeader title="账户安全" description={<>当前账户：<strong>{user?.username}</strong></>} />
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
          <div><button className="button primary" type="submit"><KeyRound aria-hidden="true" size={17} />更新密码</button></div>
        </form>
      </section>
    </div>
  )
}
