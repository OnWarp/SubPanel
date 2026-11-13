import { MailCheck, Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type AccountProfile } from '../../app/api'
import { FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'

type EmailBindChangeFormProps = {
  profile: AccountProfile
  onUpdated: () => Promise<void>
}

// One component, two flows (batch 7): accounts without an email use the
// batch-4 bind endpoints; accounts with one use the change endpoints, which
// deliver the code to the new address.
export function EmailBindChangeForm({ profile, onUpdated }: EmailBindChangeFormProps) {
  const bound = profile.emailBound
  const base = bound ? '/api/account/email/change' : '/api/account/email/bind'
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const sendCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      await api(base, { method: 'POST', body: jsonBody({ email }) })
      setStep('code')
      setMessage(`验证码已发送至 ${email}`)
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '验证码发送失败')
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      await api(`${base}/confirm`, { method: 'POST', body: jsonBody({ code }) })
      setStep('email')
      setEmail('')
      setCode('')
      setMessage(bound ? '邮箱已更换' : '邮箱已绑定')
      await onUpdated()
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '邮箱验证失败')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'code') {
    return (
      <form className="security-form" onSubmit={confirm}>
        <FormField label="邮箱验证码" htmlFor="account-email-code">
          <input
            id="account-email-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </FormField>
        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
        {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
        <div className="profile-actions">
          <button className="button primary" type="submit" disabled={busy}>
            <MailCheck aria-hidden="true" size={17} />
            {bound ? '确认更换' : '确认绑定'}
          </button>
          <button className="button" type="button" disabled={busy} onClick={() => setStep('email')}>
            重新填写邮箱
          </button>
        </div>
      </form>
    )
  }

  return (
    <form className="security-form" onSubmit={sendCode}>
      {bound ? (
        <p className="profile-hint">当前邮箱：{profile.user.email}，验证码将发送至新邮箱</p>
      ) : (
        <p className="profile-hint">绑定后可使用邮箱登录</p>
      )}
      <FormField label={bound ? '新邮箱' : '邮箱'} htmlFor="account-email-address">
        <input
          id="account-email-address"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </FormField>
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
      <div>
        <button className="button primary" type="submit" disabled={busy}>
          <Send aria-hidden="true" size={17} />
          获取验证码
        </button>
      </div>
    </form>
  )
}
