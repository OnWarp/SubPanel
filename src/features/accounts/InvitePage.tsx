import { UserPlus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiClientError, jsonBody, type InviteStatus } from '../../app/api'
import { AuthLayout } from './AuthLayout'

export function InvitePage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [invite, setInvite] = useState<InviteStatus | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api<{ invite: InviteStatus }>(`/api/invites/${encodeURIComponent(token)}`)
      .then(({ invite: value }) => setInvite(value))
      .catch((cause) => setError(cause instanceof ApiClientError ? cause.message : '邀请不可用'))
  }, [token])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (password !== String(form.get('confirmPassword'))) {
      setError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    try {
      await api(`/api/invites/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: jsonBody({ password }),
      })
      navigate('/login', { replace: true })
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '创建账户失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout title="接受邀请">
      {invite ? (
        <form className="form-stack" onSubmit={submit}>
          <p className="account-identifier">账户：<strong>{invite.username}</strong></p>
          <label className="field"><span>密码</span><input name="password" type="password" minLength={12} maxLength={128} required /></label>
          <label className="field"><span>确认密码</span><input name="confirmPassword" type="password" minLength={12} maxLength={128} required /></label>
          {error ? <p className="form-message error" role="alert">{error}</p> : null}
          <button className="button primary" type="submit" disabled={submitting}>
            <UserPlus aria-hidden="true" size={17} />
            {submitting ? '正在创建' : '创建账户'}
          </button>
        </form>
      ) : error ? <p className="form-message error" role="alert">{error}</p> : <p className="form-message" role="status">正在验证邀请</p>}
    </AuthLayout>
  )
}
