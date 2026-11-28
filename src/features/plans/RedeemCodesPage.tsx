import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, jsonBody } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { AdminModuleTabs } from '../admin-resources/AdminModuleTabs'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FormField } from '../../ui/FormField'
import { FormSelect, Input, Textarea } from '../../ui/Controls'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { RowActions } from '../../ui/RowActions'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'
import {
  DAY_SECONDS, errorText, formatInstant, formatStamp, pageCountFor, redeemDuration, redeemStatus, redeemStatusLabel,
  type CodeRedemption, type PlanDefinition, type RedeemCode, type RedeemStatus,
} from './model'

const PAGE_SIZE = 50
type DurationMode = 'snapshot' | 'inherit' | 'fixed' | 'permanent'
type IssuedCode = { id: string; code: string; tail: string }

function tone(status: RedeemStatus) {
  if (status === 'active') return 'success' as const
  if (status === 'exhausted') return 'warning' as const
  if (status === 'expired') return 'danger' as const
  return 'muted' as const
}

export function RedeemCodesPage() {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | RedeemStatus>('all')
  const [page, setPage] = useState(1)
  const [codes, setCodes] = useState<RedeemCode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [issued, setIssued] = useState<IssuedCode[] | null>(null)
  const [plans, setPlans] = useState<PlanDefinition[]>([])
  const [planId, setPlanId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [maxUses, setMaxUses] = useState('1')
  const [durationMode, setDurationMode] = useState<DurationMode>('snapshot')
  const [days, setDays] = useState('30')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<RedeemCode | null>(null)
  const [redemptions, setRedemptions] = useState<CodeRedemption[]>([])
  const [removing, setRemoving] = useState<RedeemCode | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
      if (query.trim()) params.set('search', query.trim())
      if (status !== 'all') params.set('status', status)
      setLoading(true)
      void api<{ codes: RedeemCode[] }>(`/api/admin/redeem-codes?${params}`, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) { setCodes(result.codes); setError('') } })
        .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause, '加载兑换码失败')) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [page, query, revision, status])

  const reload = () => setRevision((value) => value + 1)

  const openGenerate = () => {
    setGenerating(true)
    setIssued(null)
    setFormError('')
    void api<{ plans: PlanDefinition[] }>('/api/admin/plans?limit=200&status=enabled')
      .then((result) => setPlans(result.plans))
      .catch((cause) => setFormError(errorText(cause, '加载套餐失败')))
  }

  const generate = async () => {
    const count = Number(quantity)
    const uses = Number(maxUses)
    const customDays = Number(days)
    if (!planId) { setFormError('请选择套餐'); return }
    if (!Number.isInteger(count) || count < 1 || count > 100) { setFormError('数量为 1 到 100'); return }
    if (!Number.isInteger(uses) || uses < 1) { setFormError('请填写可用次数'); return }
    if (durationMode === 'fixed' && (!Number.isInteger(customDays) || customDays <= 0)) { setFormError('请填写大于 0 的天数'); return }
    setBusy(true)
    setFormError('')
    const body: Record<string, unknown> = { planId, quantity: count, maxUses: uses, durationMode, remark: note.trim() || null }
    if (durationMode === 'fixed') body.durationSeconds = customDays * DAY_SECONDS
    try {
      const result = await api<{ codes: IssuedCode[] }>('/api/admin/redeem-codes', { method: 'POST', body: jsonBody(body) })
      setIssued(result.codes)
      reload()
    } catch (cause) {
      setFormError(errorText(cause, '生成兑换码失败'))
    } finally {
      setBusy(false)
    }
  }

  const exportCodes = () => {
    if (!issued?.length) return
    const blob = new Blob([`${issued.map((code) => code.code).join('\n')}\n`], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'redeem-codes.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const toggle = async (code: RedeemCode) => {
    setBusy(true)
    try {
      await api(`/api/admin/redeem-codes/${encodeURIComponent(code.id)}`, { method: 'PATCH', body: jsonBody({ enabled: !code.enabled }) })
      toast.notify(code.enabled ? '兑换码已停用' : '兑换码已启用')
      reload()
    } catch (cause) {
      toast.notifyError(errorText(cause, '更新兑换码失败'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      const response = await api<{ archived?: boolean } | null>(`/api/admin/redeem-codes/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
      toast.notify(response && typeof response === 'object' && response.archived ? '已停用并保留记录' : '兑换码已删除')
      setRemoving(null)
      reload()
    } catch (cause) {
      toast.notifyError(errorText(cause, '删除兑换码失败'))
    } finally {
      setBusy(false)
    }
  }

  const openDetail = (code: RedeemCode) => {
    setDetail(code)
    setRedemptions([])
    void api<{ redemptions: CodeRedemption[] }>(`/api/admin/redeem-codes/${encodeURIComponent(code.id)}/redemptions?limit=50`)
      .then((result) => setRedemptions(result.redemptions))
      .catch((cause) => toast.notifyError(errorText(cause, '加载兑换记录失败')))
  }

  const columns: Array<DataTableColumn<RedeemCode>> = [
    { key: 'code', header: '兑换码', render: (code) => code.masked },
    { key: 'plan', header: '套餐', render: (code) => code.planName ? <Link to={`/plans/${encodeURIComponent(code.planId)}`}>{code.planName}</Link> : code.planId },
    { key: 'duration', header: '时长', render: (code) => redeemDuration(code) },
    { key: 'uses', header: '已用 / 总数', render: (code) => `${code.usedCount} / ${code.maxUses}` },
    { key: 'until', header: '兑换截止', render: (code) => code.validUntil === null ? '不限' : formatInstant(code.validUntil) },
    { key: 'status', header: '状态', render: (code) => { const current = redeemStatus(code); return <StatusBadge tone={tone(current)} size="sm">{redeemStatusLabel(current)}</StatusBadge> } },
  ]

  return (
    <PageContainer width="list">
      <PageHeader placement="inline" id="redeem-title" title="兑换码" actions={<button className="button primary" type="button" onClick={openGenerate}><Plus aria-hidden="true" size={17} />生成兑换码</button>} />
      <AdminModuleTabs />
      <FilterBar onReset={query || status !== 'all' ? () => { setQuery(''); setStatus('all'); setPage(1) } : undefined}>
        <SearchInput label="搜索兑换码" placeholder="搜索套餐、末四位或备注" value={query} onChange={(value) => { setQuery(value); setPage(1) }} />
        <label className="filter-field">
          <span>状态</span>
          <FormSelect aria-label="兑换码状态" value={status} onChange={(event) => { setStatus(event.currentTarget.value as typeof status); setPage(1) }}>
            <option value="all">全部状态</option>
            <option value="active">有效</option>
            <option value="disabled">停用</option>
            <option value="expired">已过期</option>
            <option value="exhausted">已用完</option>
          </FormSelect>
        </label>
      </FilterBar>
      {error ? <ErrorState message={error} onRetry={reload} /> : (
        <DataTable
          columns={columns}
          rows={loading ? [] : codes}
          rowKey={(code) => code.id}
          loadingLabel={loading ? '正在加载兑换码' : undefined}
          empty="暂无兑换码"
          summary={!loading ? `本页 ${codes.length} 个兑换码` : undefined}
          pagination={!loading ? { compact: true, page, pageCount: pageCountFor(page, codes.length, PAGE_SIZE), onPageChange: setPage } : undefined}
          rowActions={(code) => (
            <RowActions label={`${code.masked} 的操作`} actions={[
              { label: '兑换记录', disabled: busy, onClick: () => openDetail(code) },
              { label: code.enabled ? '停用' : '启用', disabled: busy, onClick: () => void toggle(code) },
              { label: '删除', danger: true, disabled: busy, onClick: () => setRemoving(code) },
            ]} />
          )}
        />
      )}
      <Dialog
        appearance="content"
        open={generating}
        size="l"
        busy={busy}
        title={issued ? '兑换码已生成' : '生成兑换码'}
        onClose={() => { if (!busy) setGenerating(false) }}
        footer={(close) => issued ? <button className="button primary" type="button" onClick={close}>完成</button> : <>
          <button className="button secondary" type="button" disabled={busy} onClick={close}>取消</button>
          <button className="button primary" type="button" disabled={busy} onClick={() => void generate()}>{busy ? '生成中' : '生成兑换码'}</button>
        </>}
      >
        {issued ? (
          <div className="form-stack">
            <StatusMessage tone="warning">明文只显示这一次，关闭后无法再查看</StatusMessage>
            <div className="content-toolbar-actions">
              <button className="button secondary" type="button" onClick={() => { void copyToClipboard(issued.map((code) => code.code).join('\n')).then(() => toast.notify('已复制')).catch(() => toast.notifyError('复制失败')) }}>复制全部</button>
              <button className="button secondary" type="button" onClick={exportCodes}>导出</button>
            </div>
            <ul aria-label="明文兑换码">{issued.map((code) => <li key={code.id}>{code.code} <CopyButton value={code.code} label="复制" /></li>)}</ul>
          </div>
        ) : (
          <div className="form-stack">
            <FormField label="套餐">
              <FormSelect aria-label="兑换套餐" value={planId} onChange={(event) => setPlanId(event.currentTarget.value)}>
                <option value="">选择套餐</option>
                {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
              </FormSelect>
            </FormField>
            <FormField label="数量" htmlFor="redeem-quantity"><Input id="redeem-quantity" aria-label="生成数量" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.currentTarget.value)} /></FormField>
            <FormField label="可用次数" htmlFor="redeem-uses" hintTip="每个兑换码可被使用的总次数。同一用户默认只能兑换一次"><Input id="redeem-uses" aria-label="可用次数" inputMode="numeric" value={maxUses} onChange={(event) => setMaxUses(event.currentTarget.value)} /></FormField>
            <FormField label="时长" hintTip="按当前默认时长会在生成时抄下套餐时长。兑换时读取则会使用兑换当时的套餐时长">
              <FormSelect aria-label="兑换时长" value={durationMode} onChange={(event) => setDurationMode(event.currentTarget.value as DurationMode)}>
                <option value="snapshot">按当前默认时长</option>
                <option value="inherit">兑换时读取默认时长</option>
                <option value="fixed">指定天数</option>
                <option value="permanent">永久</option>
              </FormSelect>
              {durationMode === 'fixed' ? <Input aria-label="指定天数" inputMode="numeric" value={days} onChange={(event) => setDays(event.currentTarget.value)} /> : null}
            </FormField>
            <FormField label="备注" htmlFor="redeem-note"><Textarea id="redeem-note" aria-label="兑换码备注" value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.currentTarget.value)} /></FormField>
            {formError ? <StatusMessage tone="error">{formError}</StatusMessage> : null}
          </div>
        )}
      </Dialog>
      <Dialog appearance="content" open={detail !== null} title="兑换记录" size="l" onClose={() => setDetail(null)}>
        {detail ? <p>{detail.planName || detail.planId} · {detail.masked}</p> : null}
        <DataTable
          rows={redemptions}
          rowKey={(row) => row.id}
          empty="暂无兑换记录"
          columns={[
            { key: 'user', header: '用户', render: (row) => row.username ? <Link to={`/users/${encodeURIComponent(row.userId)}?tab=subscription`}>{row.username}</Link> : row.userId },
            { key: 'plan', header: '套餐', render: (row) => row.planName || '—' },
            { key: 'status', header: '实例状态', render: (row) => row.instanceStatus || '—' },
            { key: 'expires', header: '到期', render: (row) => formatInstant(row.expiresAt) },
            { key: 'at', header: '兑换时间', render: (row) => formatStamp(row.redeemedAt) },
          ]}
        />
      </Dialog>
      <ConfirmDialog
        appearance="content"
        open={removing !== null}
        danger
        busy={busy}
        title="删除兑换码"
        description="没有兑换记录时会删除。已有记录时只停用并保留，已发出的套餐不受影响"
        confirmLabel="删除兑换码"
        onClose={() => { if (!busy) setRemoving(null) }}
        onConfirm={() => void remove()}
      />
    </PageContainer>
  )
}
