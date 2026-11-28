import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { DateTimeInput, Input } from '../../ui/Controls'
import { Dialog } from '../../ui/Dialog'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { RowActions } from '../../ui/RowActions'
import { StatusBadge } from '../../ui/StatusBadge'
import { useToast } from '../../ui/Toast'
import { AssignPlanDialog } from './AssignPlanDialog'
import {
  DAY_SECONDS, errorText, formatInstant, instanceStatus, instanceStatusLabel, sourceLabel,
  type AggregateSubscription, type InstanceStatus, type PlanInstance,
} from './model'

type LinkResult = { token: string; subscriptionUrl: string }
type ExpiryDraft = { instance: PlanInstance; permanent: boolean; local: string }

function tone(status: InstanceStatus) {
  if (status === 'active') return 'success' as const
  if (status === 'pending') return 'info' as const
  if (status === 'paused' || status === 'plan_disabled') return 'warning' as const
  if (status === 'expired') return 'danger' as const
  return 'muted' as const
}

function localInput(value: number | null) {
  if (value === null) return ''
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function UserPlansPanel({ userId, username }: { userId: string; username: string }) {
  const toast = useToast()
  const [aggregate, setAggregate] = useState<AggregateSubscription | null>(null)
  const [instances, setInstances] = useState<PlanInstance[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [assigning, setAssigning] = useState(false)
  const [link, setLink] = useState<LinkResult | null>(null)
  const [renewing, setRenewing] = useState<PlanInstance | null>(null)
  const [renewDays, setRenewDays] = useState('30')
  const [expiry, setExpiry] = useState<ExpiryDraft | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'reset' | 'reset-aggregate'; instance?: PlanInstance } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void api<{ aggregate: AggregateSubscription; instances: PlanInstance[] }>(`/api/admin/users/${encodeURIComponent(userId)}/plans?limit=50`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return
        setAggregate(result.aggregate)
        setInstances(result.instances)
        setError('')
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause, '加载套餐失败')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision, userId])

  const reload = () => setRevision((value) => value + 1)

  const reveal = async (path: string) => {
    setBusy(true)
    try {
      const result = await api<LinkResult>(path, { method: 'POST', body: jsonBody({}) })
      setLink(result)
      setConfirm(null)
      reload()
    } catch (cause) {
      toast.notifyError(errorText(cause, '获取链接失败'))
    } finally {
      setBusy(false)
    }
  }

  const mutate = async (instance: PlanInstance, path: string, body?: unknown, method = 'POST') => {
    setBusy(true)
    try {
      await api(`/api/admin/user-plans/${encodeURIComponent(instance.id)}${path}`, {
        method, body: body === undefined ? undefined : jsonBody(body),
      })
      toast.notify('已更新')
      setRenewing(null)
      setExpiry(null)
      setConfirm(null)
      reload()
    } catch (cause) {
      toast.notifyError(errorText(cause, '操作失败'))
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<DataTableColumn<PlanInstance>> = [
    { key: 'name', header: '套餐', render: (row) => <Link to={`/plans/${encodeURIComponent(row.plan_id)}`}>{row.name}</Link> },
    { key: 'source', header: '来源', render: (row) => sourceLabel(row.source) },
    { key: 'window', header: '开始 / 到期', render: (row) => `${formatInstant(row.starts_at)} / ${formatInstant(row.expires_at)}` },
    { key: 'status', header: '状态', render: (row) => { const current = instanceStatus(row); return <StatusBadge tone={tone(current)} size="sm">{instanceStatusLabel(current)}</StatusBadge> } },
    { key: 'nodes', header: '节点数', render: (row) => row.nodeCount },
  ]

  return (
    <div className="form-stack">
      {error ? <ErrorState message={error} onRetry={reload} /> : loading || !aggregate ? <p role="status">正在加载套餐</p> : <>
        <div className="content-toolbar-actions" aria-label="聚合订阅">
          <StatusBadge tone={aggregate.issued ? 'success' : 'muted'} size="sm">{aggregate.issued ? '已签发' : '未签发'}</StatusBadge>
          <span>节点 {aggregate.nodeCount}</span>
          <span>{aggregate.subscriptionUrl ?? '未配置订阅域名'}</span>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void reveal(`/api/admin/users/${encodeURIComponent(userId)}/aggregate-subscription-link`)}>复制链接</button>
          <button className="button ghost" type="button" disabled={busy} onClick={() => setConfirm({ kind: 'reset-aggregate' })}>重置链接</button>
        </div>
        <div className="content-toolbar-actions">
          <button className="button primary" type="button" onClick={() => setAssigning(true)}>添加套餐</button>
        </div>
        <DataTable
          columns={columns}
          rows={instances}
          rowKey={(row) => row.id}
          empty="暂无套餐"
          rowActions={(row) => {
            const current = instanceStatus(row)
            return (
              <RowActions label={`${row.name} 的操作`} actions={[
                { label: '复制链接', disabled: busy, onClick: () => void reveal(`/api/admin/user-plans/${encodeURIComponent(row.id)}/subscription-link`) },
                { label: '续期', disabled: busy || row.expires_at === null || current === 'revoked', onClick: () => { setRenewing(row); setRenewDays('30') } },
                current === 'paused'
                  ? { label: '恢复', disabled: busy, onClick: () => void mutate(row, '/resume') }
                  : { label: '暂停', disabled: busy || current === 'revoked', onClick: () => void mutate(row, '/pause') },
                { label: '改到期时间', disabled: busy || current === 'revoked', onClick: () => setExpiry({ instance: row, permanent: row.expires_at === null, local: localInput(row.expires_at) }) },
                { label: '重置链接', disabled: busy, onClick: () => setConfirm({ kind: 'reset', instance: row }) },
                { label: '撤销', danger: true, disabled: busy || current === 'revoked', onClick: () => setConfirm({ kind: 'revoke', instance: row }) },
              ]} />
            )
          }}
        />
      </>}
      {assigning ? <AssignPlanDialog targets={[{ id: userId, label: username }]} onClose={() => setAssigning(false)} onAssigned={reload} /> : null}
      <Dialog open={link !== null} title="订阅链接" appearance="content" size="m" onClose={() => setLink(null)} footer={(close) => <button className="button primary" type="button" onClick={close}>完成</button>}>
        {link ? <div className="form-stack"><p>链接只在这里完整显示</p><p>{link.subscriptionUrl}</p><CopyButton value={link.subscriptionUrl} label="复制链接" /></div> : null}
      </Dialog>
      <Dialog open={renewing !== null} title="续期" appearance="content" size="s" busy={busy} onClose={() => { if (!busy) setRenewing(null) }} footer={(close) => <>
        <button className="button secondary" type="button" disabled={busy} onClick={close}>取消</button>
        <button className="button primary" type="button" disabled={busy} onClick={() => {
          const days = Number(renewDays)
          if (!renewing || !Number.isInteger(days) || days <= 0) { toast.notifyError('请填写大于 0 的天数'); return }
          void mutate(renewing, '/renew', { durationSeconds: days * DAY_SECONDS, version: renewing.version })
        }}>续期</button>
      </>}>
        <FormField label="天数" htmlFor="renew-days"><Input id="renew-days" aria-label="续期天数" inputMode="numeric" value={renewDays} onChange={(event) => setRenewDays(event.currentTarget.value)} /></FormField>
      </Dialog>
      <Dialog open={expiry !== null} title="改到期时间" appearance="content" size="s" busy={busy} onClose={() => { if (!busy) setExpiry(null) }} footer={(close) => <>
        <button className="button secondary" type="button" disabled={busy} onClick={close}>取消</button>
        <button className="button primary" type="button" disabled={busy} onClick={() => {
          if (!expiry) return
          const expiresAt = expiry.permanent ? null : new Date(expiry.local).getTime()
          if (!expiry.permanent && !Number.isFinite(expiresAt)) { toast.notifyError('请选择到期时间'); return }
          void mutate(expiry.instance, '', { version: expiry.instance.version, expiresAt }, 'PATCH')
        }}>保存</button>
      </>}>
        {expiry ? <div className="form-stack">
          <label className="choice-row"><input type="checkbox" checked={expiry.permanent} onChange={(event) => setExpiry({ ...expiry, permanent: event.currentTarget.checked })} />永久</label>
          {expiry.permanent ? null : <DateTimeInput aria-label="到期时间" value={expiry.local} onChange={(event) => setExpiry({ ...expiry, local: event.currentTarget.value })} />}
        </div> : null}
      </Dialog>
      <ConfirmDialog
        appearance="content"
        open={confirm !== null}
        danger={confirm?.kind !== 'reset-aggregate'}
        busy={busy}
        title={confirm?.kind === 'revoke' ? '撤销套餐' : '重置链接'}
        description={confirm?.kind === 'revoke' ? '撤销后该实例停止下发，且不能恢复' : '重置后旧链接立即失效'}
        confirmLabel={confirm?.kind === 'revoke' ? '撤销' : '重置链接'}
        onClose={() => { if (!busy) setConfirm(null) }}
        onConfirm={() => {
          if (!confirm) return
          if (confirm.kind === 'revoke' && confirm.instance) void mutate(confirm.instance, '', undefined, 'DELETE')
          else if (confirm.kind === 'reset' && confirm.instance) void reveal(`/api/admin/user-plans/${encodeURIComponent(confirm.instance.id)}/reset-token`)
          else void reveal(`/api/admin/users/${encodeURIComponent(userId)}/reset-aggregate-token`)
        }}
      />
    </div>
  )
}
