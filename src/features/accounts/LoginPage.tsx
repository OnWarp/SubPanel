import { LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiClientError } from '../../app/api'
import { useSession } from '../../app/session'
import { FormField } from '../../ui/FormField'
import { AuthLayout } from './AuthLayout'

export function LoginPage() {
  const navigate = useNavigate()
  const { login } = useSession()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    const form = new FormData(event.currentTarget)
    try {
      await login(String(form.get('username')), String(form.get('password')))
      navigate('/', { replace: true })
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout title="登录">
      <form className="form-stack" onSubmit={submit}>
        <FormField label="用户名" htmlFor="login-username">
          <input id="login-username" name="username" autoComplete="username" required />
        </FormField>
        <FormField label="密码" htmlFor="login-password">
          <input id="login-password" name="password" type="password" autoComplete="current-password" required />
        </FormField>
        {error ? <p className="form-message error" role="alert">{error}</p> : null}
        <button className="button primary" type="submit" disabled={submitting}>
          <LogIn aria-hidden="true" size={17} />
          {submitting ? '正在登录' : '登录'}
        </button>
      </form>
    </AuthLayout>
  )
}
