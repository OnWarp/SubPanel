import { Input } from '../../ui/Controls'
import { PasswordInput } from '../../ui/PasswordInput'
import { UserPlus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { useSession } from '../../app/session'
import { FormField } from '../../ui/FormField'
import { AuthLayout } from './AuthLayout'

type RegistrationMode = 'closed' | 'invite' | 'open'

export function RegisterPage({ initialMode = null }: { initialMode?: RegistrationMode | null } = {}) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [inviteCode, setInviteCode] = useState(params.get('inviteCode') ?? '')
  const { refresh } = useSession()
  const [mode, setMode] = useState<RegistrationMode | null>(initialMode)
  const invited = mode === 'invite' || inviteCode.trim() !== ''
  const [configError, setConfigError] = useState('')
  const [email, setEmail] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [errorField, setErrorField] = useState('confirmPassword')
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
    setErrorField('email')
    setNotice('')
    setSending(true)
    try {
      await api('/api/register/send-code', { method: 'POST', body: jsonBody({ email }) })
      setNotice('验证码已发送，请查看邮箱')
      setCountdown(60)
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '验证码发送失败')
      document.getElementById('register-email')?.focus()
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
      setErrorField('confirmPassword')
      setError('两次输入的密码不一致')
      document.getElementById('register-confirm-password')?.focus()
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
          code: invited ? undefined : String(form.get('code')),
          inviteCode: invited ? inviteCode.trim() : undefined,
        }),
      })
      await refresh()
      navigate('/', { replace: true })
    } catch (cause) {
      const message = cause instanceof ApiClientError ? cause.message : '注册失败'
      const field = /邀请码/.test(message) ? 'inviteCode' : /验证码/.test(message) ? 'code' : /邮箱/.test(message) ? 'email' : /用户名/.test(message) ? 'username' : /密码/.test(message) ? 'password' : 'confirmPassword'
      setErrorField(field); setError(message)
      document.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  if (configError) {
    return (
      <AuthLayout className="upd-auth" title="注册">
        <div className="content-scope">
          <p className="form-message error" role="alert">{configError}</p>
          <p className="form-message"><Link to="/login">返回登录</Link></p>
        </div>
      </AuthLayout>
    )
  }
  if (mode === null) {
    return (
      <AuthLayout className="upd-auth" title="注册">
        <p className="content-scope form-message" role="status">正在加载</p>
      </AuthLayout>
    )
  }
  if (mode === 'closed') {
    return (
      <AuthLayout className="upd-auth" title="注册">
        <div className="content-scope">
          <p className="form-message">当前未开放注册，请联系管理员</p>
          <p className="form-message"><Link to="/login">返回登录</Link></p>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout className="upd-auth" title="注册">
      <form className="form-stack content-scope" onSubmit={submit}>
        <FormField label="用户名" htmlFor="register-username" error={errorField === 'username' ? error : undefined}>
          <Input id="register-username" name="username" autoComplete="username" minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" autoFocus required />
          <p className="profile-hint">3 至 32 位字母、数字或 . _ -</p>
        </FormField>
        <FormField label="邮箱" htmlFor="register-email" error={errorField === 'email' ? error : undefined}>
          <Input id="register-email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </FormField>
        {!invited ? <>
        <FormField label="验证码" htmlFor="register-code" error={errorField === 'code' ? error : undefined}>
          <Input id="register-code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
        </FormField>
        <button className="button" type="button" disabled={sending || countdown > 0 || email === ''} onClick={sendCode}>
          {countdown > 0 ? `${countdown} 秒后可重新发送` : sending ? '正在发送' : '发送验证码'}
        </button>
        </> : null}
        <FormField label={mode === 'invite' ? "邀请码" : "邀请码（选填）"} htmlFor="register-invite-code" error={errorField === 'inviteCode' ? error : undefined}>
            <Input id="register-invite-code" name="inviteCode" autoComplete="off" required={mode === 'invite'} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} />
          </FormField>
        {mode === 'invite' ? <p className="profile-hint">请向管理员获取邀请码</p> : null}
        <FormField label="密码" htmlFor="register-password" error={errorField === 'password' ? error : undefined}>
          <PasswordInput id="register-password" name="password" autoComplete="new-password" minLength={12} maxLength={128} required />
          <p className="profile-hint">密码长度为 12 至 128 个字符</p>
        </FormField>
        <FormField label="确认密码" htmlFor="register-confirm-password" error={errorField === 'confirmPassword' ? error : undefined}>
          <PasswordInput id="register-confirm-password" name="confirmPassword" autoComplete="new-password" minLength={12} maxLength={128} required />
        </FormField>
        {notice ? <p className="form-message" role="status">{notice}</p> : null}
        <button className="button primary" type="submit" disabled={submitting}>
          <UserPlus aria-hidden="true" size={17} />
          {submitting ? '正在注册' : '注册'}
        </button>
        <p className="form-message">已有账号？<Link to="/login">直接登录</Link></p>
      </form>
    </AuthLayout>
  )
}
