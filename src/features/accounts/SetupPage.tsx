import { KeyRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { useSession } from '../../app/session'
import { AuthLayout } from './AuthLayout'

export function SetupPage() {
  const navigate = useNavigate()
  const { refresh } = useSession()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    const form = new FormData(event.currentTarget)
    try {
      await api('/api/setup', {
        method: 'POST',
        body: jsonBody({
          username: form.get('username'),
          password: form.get('password'),
        }),
      })
      await refresh()
      navigate('/login', { replace: true })
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '初始化失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout title="初始化管理员">
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>管理员用户名</span>
          <input name="username" autoComplete="username" minLength={3} maxLength={32} required />
        </label>
        <label className="field">
          <span>管理员密码</span>
          <input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
        </label>
        {error ? <p className="form-message error" role="alert">{error}</p> : null}
        <button className="button primary" type="submit" disabled={submitting}>
          <KeyRound aria-hidden="true" size={17} />
          {submitting ? '正在创建' : '创建管理员'}
        </button>
      </form>
    </AuthLayout>
  )
}
