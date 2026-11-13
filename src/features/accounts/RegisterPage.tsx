import { UserPlus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { useSession } from '../../app/session'
import { FormField } from '../../ui/FormField'
import { AuthLayout } from './AuthLayout'

type RegistrationMode = 'closed' | 'invite' | 'open'

export function RegisterPage() {
  const navigate = useNavigate()
  const { refresh } = useSession()
  const [mode, setMode] = useState<RegistrationMode | null>(null)
  const [configError, setConfigError] = useState('')
  const [email, setEmail] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api<{ mode: RegistrationMode }>('/api/register/config')
      .then(({ mode: value }) => setMode(value))
      .catch(() => setConfigError('注册状态读取失败'))
  }, [])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1_000)
    return () => clearTimeout(timer)
  }, [countdown])

  const sendCode = async () => {
    setError('')
    setNotice('')
    setSending(true)
    try {
      await api('/api/register/send-code', { method: 'POST', body: jsonBody({ email }) })
      setNotice('验证码已发送，请查看邮箱')
      setCountdown(60)
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '验证码发送失败')
    } finally {
      setSending(false)
    }
  }

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
      await api('/api/register', {
        method: 'POST',
        body: jsonBody({
          username: String(form.get('username')),
          password,
          email,
          code: String(form.get('code')),
          inviteCode: mode === 'invite' ? String(form.get('inviteCode')) : undefined,
        }),
      })
      await refresh()
      navigate('/', { replace: true })
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '注册失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (configError) {
    return (
      <AuthLayout title="注册">
        <p className="form-message error" role="alert">{configError}</p>
        <p className="form-message"><Link to="/login">返回登录</Link></p>
      </AuthLayout>
    )
  }
  if (mode === null) {
    return (
      <AuthLayout title="注册">
        <p className="form-message" role="status">正在加载</p>
      </AuthLayout>
    )
  }
  if (mode === 'closed') {
    return (
      <AuthLayout title="注册">
        <p className="form-message">当前未开放注册，请联系管理员</p>
        <p className="form-message"><Link to="/login">返回登录</Link></p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="注册">
      <form className="form-stack" onSubmit={submit}>
        <FormField label="用户名" htmlFor="register-username">
          <input id="register-username" name="username" autoComplete="username" required />
        </FormField>
        <FormField label="邮箱" htmlFor="register-email">
          <input id="register-email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </FormField>
        <FormField label="验证码" htmlFor="register-code">
          <input id="register-code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
        </FormField>
        <button className="button" type="button" disabled={sending || countdown > 0 || email === ''} onClick={sendCode}>
          {countdown > 0 ? `${countdown} 秒后可重新发送` : sending ? '正在发送' : '发送验证码'}
        </button>
        {mode === 'invite' ? (
          <FormField label="邀请码" htmlFor="register-invite-code">
            <input id="register-invite-code" name="inviteCode" autoComplete="off" required />
          </FormField>
        ) : null}
        <FormField label="密码" htmlFor="register-password">
          <input id="register-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
        </FormField>
        <FormField label="确认密码" htmlFor="register-confirm-password">
          <input id="register-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
        </FormField>
        {notice ? <p className="form-message" role="status">{notice}</p> : null}
        {error ? <p className="form-message error" role="alert">{error}</p> : null}
        <button className="button primary" type="submit" disabled={submitting}>
          <UserPlus aria-hidden="true" size={17} />
          {submitting ? '正在注册' : '注册'}
        </button>
        <p className="form-message">已有账号？<Link to="/login">直接登录</Link></p>
      </form>
    </AuthLayout>
  )
}
