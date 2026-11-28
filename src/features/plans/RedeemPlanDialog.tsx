import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatCode } from '../../../shared/redemption-code'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { Dialog } from '../../ui/Dialog'
import { Input } from '../../ui/Controls'
import { FormActions, FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'
import { formatPlanDate } from './my-plan-model'

type RedeemedInstance = { id: string; planId: string; name: string; status: string; startsAt: number; expiresAt: number | null; nodeCount: number }
type RedeemResponse = { replayed: boolean; redemptionId: string; token?: string; instance: RedeemedInstance }

// One user-facing sentence per backend code. Codes are stable; anything else
// falls back to the server message so a new code is still readable.
const redeemErrors: Record<string, string> = {
  CODE_INVALID: '兑换码无效或不可用',
  CODE_EXHAUSTED: '该兑换码已用完',
  CODE_USER_LIMIT: '你已达到该兑换码的使用次数上限',
  PLAN_NOT_ASSIGNABLE: '该套餐当前不可兑换',
  CONFLICT: '这次请求与之前的兑换冲突，请刷新后重试',
  REDEMPTION_RATE_LIMITED: '操作过于频繁，请稍后再试',
  INVALID_INPUT: '请输入有效的兑换码',
  FORBIDDEN: '无法为其他账号兑换',
}

function redeemMessage(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'NETWORK_ERROR' || cause.status === 0) return '网络异常，结果可能已生效，请先刷新套餐列表再重试'
    return redeemErrors[cause.code] ?? cause.message
  }
  return '兑换失败，请稍后重试'
}

export function RedeemPlanDialog({ open, onClose, onRedeemed }: {
  open: boolean
  onClose: () => void
  onRedeemed: (instance: RedeemedInstance) => void
}) {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<RedeemedInstance>()
  // The key is generated once per attempt so a network retry of the same
  // submission cannot create a second instance.
  const idempotencyKey = useRef<string>(crypto.randomUUID())

  useEffect(() => {
    if (!open) return
    setMessage('')
    setResult(undefined)
  }, [open])

  const close = () => {
    if (busy) return
    setCode('')
    setMessage('')
    setResult(undefined)
    idempotencyKey.current = crypto.randomUUID()
    onClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !code.trim()) return
    setBusy(true)
    setMessage('')
    try {
      const response = await api<RedeemResponse>('/api/me/plans/redeem', {
        method: 'POST',
        // Trim only; the server normalizes case and separators itself.
        body: jsonBody({ code: code.trim(), idempotencyKey: idempotencyKey.current }),
      })
      setResult(response.instance)
      onRedeemed(response.instance)
    } catch (cause) {
      // Keep the input so the user can fix a typo; a successful retry rotates
      // the key because the failed attempt may have partially consumed it.
      if (cause instanceof ApiClientError && cause.code !== 'NETWORK_ERROR') idempotencyKey.current = crypto.randomUUID()
      setMessage(redeemMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return <Dialog open={open} onClose={close} title="兑换套餐" appearance="content" size="m" busy={busy}
    description={result ? undefined : '输入兑换码后会新建一份套餐，不影响现有套餐'}>
    {result ? <div className="upd-redeem-result">
      <StatusMessage tone="success">兑换成功</StatusMessage>
      <dl className="upd-redeem-detail">
        <div><dt>套餐</dt><dd>{result.name}</dd></div>
        <div><dt>有效期至</dt><dd>{result.expiresAt === null ? '长期有效' : formatPlanDate(result.expiresAt)}</dd></div>
      </dl>
      <FormActions>
        <button className="button primary" type="button" onClick={() => { setResult(undefined); navigate(`/me/plans/${encodeURIComponent(result.id)}`) }}>查看套餐详情</button>
        <button className="button secondary" type="button" onClick={close}>完成</button>
      </FormActions>
    </div> : <form className="sp-form-stack" onSubmit={event => { void submit(event) }}>
      <FormField label="兑换码" htmlFor="redeem-plan-code">
        <Input id="redeem-plan-code" required autoComplete="off" spellCheck={false} maxLength={100}
          value={code} disabled={busy} data-dialog-initial-focus
          onChange={event => setCode(event.target.value)}
          onBlur={() => {
            // Cosmetic only; the request sends the trimmed raw value.
            const trimmed = code.trim()
            const formatted = formatCode(trimmed.replaceAll('-', '').toUpperCase())
            if (trimmed.length > 0 && /^[0-9A-Za-z]{12}$/u.test(trimmed)) setCode(formatted)
          }} />
      </FormField>
      {message ? <StatusMessage tone="error">{message}</StatusMessage> : null}
      <FormActions>
        <button className="button primary" type="submit" disabled={busy || !code.trim()}>{busy ? '兑换中' : '兑换'}</button>
        <button className="button secondary" type="button" disabled={busy} onClick={close}>取消</button>
      </FormActions>
    </form>}
  </Dialog>
}
