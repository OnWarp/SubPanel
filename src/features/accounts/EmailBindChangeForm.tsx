import { Dialog } from '../../ui/Dialog'
import { Input } from '../../ui/Controls'
import { MailCheck, Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type AccountProfile } from '../../app/api'
import { Button } from '../../ui/Button'
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
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [currentPassword, setCurrentPassword] = useState('')
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
      await api(base, { method: 'POST', body: jsonBody({ email, ...(bound && { currentPassword }) }) })
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
      await api(`${base}/confirm`, { method: 'POST', body: jsonBody({ code, ...(bound && { currentPassword }) }) })
      setStep('email')
      setEmail('')
      setCode('')
      setCurrentPassword('')
      setOpen(false)
      setMessage(bound ? '邮箱已更换' : '邮箱已绑定')
      await onUpdated()
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '邮箱验证失败')
    } finally {
      setBusy(false)
    }
  }

  const title = bound ? '更换邮箱' : '绑定邮箱'
  const close = () => {
    setOpen(false)
    setStep('email')
    setCurrentPassword('')
    setEmail('')
    setCode('')
    setError('')
    setMessage('')
  }
  return <>
    <Button onClick={() => { setMessage(''); setOpen(true) }}>{title}</Button>
    {!open && message && <StatusMessage tone="success">{message}</StatusMessage>}
    <Dialog open={open} title={title} size="m" focusStep={step} busy={busy} dirty={Boolean(email || currentPassword || code)} sensitive onClose={close}
      footer={(cancel) => <>
        <Button variant="ghost" disabled={busy} onClick={step === 'code' ? () => { setStep('email'); setCode(''); setError(''); setMessage('') } : cancel}>
          {step === 'code' ? '重新填写邮箱' : '取消'}
        </Button>
        <Button variant="primary" type="submit" form="account-email-editor" loading={busy}>
          {step === 'code' ? <MailCheck aria-hidden="true" size={17} /> : <Send aria-hidden="true" size={17} />}
          {step === 'code' ? bound ? '确认更换' : '确认绑定' : '获取验证码'}
        </Button>
      </>}>
      <form id="account-email-editor" className="form-stack" onSubmit={step === 'code' ? confirm : sendCode}>
        {step === 'code' ? <FormField label="邮箱验证码" htmlFor="account-email-code">
          <Input id="account-email-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}"
            maxLength={6} required value={code} onChange={(event) => setCode(event.target.value)} />
        </FormField> : <>
          <FormField label={bound ? '新邮箱' : '邮箱'} htmlFor="account-email-address">
            <Input id="account-email-address" name="email" type="email" autoComplete="email" required
              value={email} onChange={(event) => setEmail(event.target.value)} />
          </FormField>
          {bound && <FormField label="当前密码" htmlFor="account-email-current-password">
            <Input id="account-email-current-password" type="password" autoComplete="current-password" required
              value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          </FormField>}
        </>}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        {open && message && <StatusMessage tone="success">{message}</StatusMessage>}
      </form>
    </Dialog>
  </>
}
