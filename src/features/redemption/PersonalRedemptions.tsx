import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { formatCode, normalizeCode } from '../../../shared/redemption-code'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { Input } from '../../ui/Controls'
import { DataTable } from '../../ui/DataTable'
import { ErrorState } from '../../ui/ErrorState'
import { FormActions, FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'
import { BYTES_PER_GIB, TERM_UNITS } from '../delivery/entitlement-types'
import { formatExpiryTime } from '../delivery/expiry'
import { errorText, myRedemptionsPath, useRedemptionPage, type Receipt, type RedemptionRecord } from './api'

type Preview = {
  name: string
  duration: { value: number; unit: keyof typeof TERM_UNITS }
  quotaBytes: number | null
  nodePolicy: 'groups' | 'nodes' | 'mixed'
  previewProof: string
}
const policyLabels = { groups: '动态分组', nodes: '指定节点', mixed: '动态分组与指定节点' }

export function PersonalRedemptions({ unified = false, onRedeemed, onPending }: { unified?: boolean; onRedeemed?: () => void; onPending?: (busy: boolean) => void } = {}) {
  const [code, setCode] = useState('')
  const [pending, setPending] = useState<{ preview: Preview; idempotencyKey: string }>()
  const [receipt, setReceipt] = useState<Receipt>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [historyPage, setHistoryPage] = useState(1)
  const history = useRedemptionPage<RedemptionRecord>(myRedemptionsPath, historyPage)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    onPending?.(true)
    setMessage('')
    setReceipt(undefined)
    try {
      if (!pending) {
        const { preview } = await api<{ preview: Preview }>(`${myRedemptionsPath}/preview`, {
          method: 'POST', body: jsonBody({ code }),
        })
        setPending({ preview, idempotencyKey: crypto.randomUUID() })
      } else {
        const { subscription } = await api<{ subscription: Receipt }>(myRedemptionsPath, {
          method: 'POST', body: jsonBody({ code, previewProof: pending.preview.previewProof, idempotencyKey: pending.idempotencyKey }),
        })
        setReceipt(subscription)
        setCode('')
        setPending(undefined)
        setHistoryPage(1)
        history.reload()
        onRedeemed?.()
      }
    } catch (error) {
      setMessage(errorText(error))
      if (error instanceof ApiClientError && error.code === 'REDEMPTION_CODE_UNAVAILABLE') setPending(undefined)
    } finally {
      setBusy(false)
      onPending?.(false)
    }
  }

  return <>
    <section className="data-section user-account-card redemption-section" aria-label="兑换订阅">
      <h2>兑换订阅</h2>
      <form className="sp-form-stack" onSubmit={(event) => { void submit(event) }}>
        {pending ? <>
          <dl className="key-value-rows">
            {!unified && <div><dt>订阅</dt><dd>{pending.preview.name}</dd></div>}
            <div><dt>有效期</dt><dd>{pending.preview.duration.value} {TERM_UNITS[pending.preview.duration.unit]}</dd></div>
            <div><dt>流量额度</dt><dd>{pending.preview.quotaBytes === null ? '不限' : `${pending.preview.quotaBytes / BYTES_PER_GIB} GiB`}</dd></div>
            <div><dt>节点策略</dt><dd>{policyLabels[pending.preview.nodePolicy]}</dd></div>
          </dl>
          {!unified && <p>确认后会新增一份独立订阅</p>}
        </> : <FormField label="兑换码" htmlFor="personal-redemption-code">
          <Input id="personal-redemption-code" required autoComplete="off" spellCheck={false}
            maxLength={100} value={code} disabled={busy} onChange={(event) => setCode(event.target.value)}
            onBlur={() => {
              const canonical = normalizeCode(code)
              if (canonical) setCode(formatCode(canonical))
            }} />
        </FormField>}
        {message ? <StatusMessage tone="error">{message}</StatusMessage> : null}
        <FormActions>
          <button type="submit" className="button primary" disabled={busy}>{busy ? '处理中' : pending ? '确认兑换' : '预览权益'}</button>
          {pending ? <button type="button" className="button secondary" disabled={busy}
            onClick={() => { setPending(undefined); setMessage('') }}>返回修改</button> : null}
        </FormActions>
      </form>
      {receipt ? <div className="redemption-actions"><StatusMessage tone="success">{unified ? '兑换成功' : `已兑换 ${receipt.name}`}</StatusMessage>{!unified && <Link to={receipt.templateId ? '/subscriptions' : `/subscriptions?subscription=${receipt.id}`}>查看订阅</Link>}</div> : null}
    </section>
    <section className="data-section user-account-card redemption-section" aria-label="兑换历史">
      <h2>兑换历史</h2>
      {history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : <DataTable
        rows={history.data?.items ?? []} rowKey={(row) => row.id} loadingLabel={history.loading ? '正在加载兑换历史' : undefined}
        empty="暂无兑换记录"
        pagination={history.data && history.data.total > history.data.pageSize ? {
          page: historyPage, pageCount: Math.ceil(history.data.total / history.data.pageSize), onPageChange: setHistoryPage, compact: true,
        } : undefined}
        columns={[
          ...(unified ? [] : [{ key: 'subscriptionName', header: '订阅', render: (row: RedemptionRecord) => row.hasSubscription
            ? <Link to={`/subscriptions?subscription=${row.subscriptionId}`}>{row.subscriptionName}</Link> : row.subscriptionName }]),
          { key: 'redeemedAt', header: '兑换时间', render: (row) => new Date(row.redeemedAt).toLocaleString() },
          { key: 'expiresAt', header: '发放时的到期时间', render: (row) => row.expiresAt === null ? '永久有效' : formatExpiryTime(row.expiresAt) },
        ]} />}
    </section>
  </>
}
