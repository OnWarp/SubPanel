import { Dialog } from '../../ui/Dialog'
import { Checkbox, Input, DateTimeInput } from '../../ui/Controls'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { Trash2 } from 'lucide-react'
import { BatchToolbar } from '../../ui/BatchToolbar'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { ErrorState } from '../../ui/ErrorState'
import { FilterChip } from '../../ui/FilterChip'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { StatusBadge } from '../../ui/StatusBadge'
import { useToast } from '../../ui/Toast'
import { formatDate } from '../catalog/catalog-utils'

type InviteCodeItem = {
  id: string
  prefix: string
  type: 'multi' | 'single'
  maxUses: number | null
  usedCount: number
  remaining: number | null
  expiresAt: string | null
  disabled: boolean
  createdAt: string
}

type CreatedInviteCode = {
  link: string
  id: string
  code: string
  prefix: string
  type: 'multi' | 'single'
  maxUses: number | null
  expiresAt: string | null
  createdAt: string
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function InviteCodesSection() {
  const [items, setItems] = useState<InviteCodeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [createError, setCreateError] = useState('')
  const [kind, setKind] = useState<'multi' | 'batch'>('multi')
  const [maxUses, setMaxUses] = useState('')
  const [count, setCount] = useState('10')
  const [expiresAt, setExpiresAt] = useState('')
  const [created, setCreated] = useState<CreatedInviteCode[] | null>(null)
  const [pendingDelete, setPendingDelete] = useState<InviteCodeItem | null>(null)
  const [pendingDisable, setPendingDisable] = useState<InviteCodeItem[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState('')
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<{ invitations: InviteCodeItem[] }>('/api/admin/invitations')
      setItems(result.invitations)
      setSelected((current) => new Set([...current].filter((id) => result.invitations.some((item) => item.id === id && !item.disabled))))
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载邀请码失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const body: { type: 'multi' | 'batch'; maxUses?: number | null; count?: number; expiresAt: string | null } = {
      type: kind,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    }
    if (kind === 'multi') {
      const parsed = Number.parseInt(maxUses, 10)
      body.maxUses = maxUses.trim() === '' || Number.isNaN(parsed) ? null : parsed
    } else {
      const parsed = Number.parseInt(count, 10)
      body.count = Number.isNaN(parsed) ? 1 : Math.min(Math.max(parsed, 1), 200)
    }
    setBusy(true)
    try {
      const result = await api<{ invitations: CreatedInviteCode[] }>('/api/admin/invitations', {
        method: 'POST',
        body: jsonBody(body),
      })
      setCreated(result.invitations)
      toast.notify(kind === 'multi' ? '邀请码已生成' : `已生成 ${result.invitations.length} 个邀请码`)
      await load()
    } catch (cause) {
      setCreateError(errorMessage(cause, '生成邀请码失败'))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!pendingDisable || busy) return
    setBusy(true)
    const failed = new Set<string>()
    let failure = ''
    try {
      for (const [index, item] of pendingDisable.entries()) {
        setProgress(`正在处理 ${index + 1}/${pendingDisable.length}`)
        try { await api(`/api/admin/invitations/${item.id}`, { method: 'DELETE' }) }
        catch (cause) { failed.add(item.id); failure ||= errorMessage(cause, '停用邀请码失败') }
      }
      setSelected(failed)
      setPendingDisable(null)
      if (failure) toast.notifyError(`${failed.size} 项未完成：${failure}`)
      else toast.notify('邀请码已停用')
      await load()
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const remove = async () => {
    if (!pendingDelete || busy) return
    setBusy(true)
    try {
      await api(`/api/admin/invitations/${pendingDelete.id}/delete`, { method: 'POST', body: '{}' })
      setPendingDelete(null)
      toast.notify('邀请码已删除')
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '删除邀请码失败'))
    } finally {
      setBusy(false)
    }
  }

  const selectable = items.filter((item) => !item.disabled)

  return (
    <div className="sys-subsection">
      <h3 className="sys-subtitle">注册邀请码</h3>
      <button className="button primary" type="button" disabled={busy || loading || !!loadError} onClick={() => {
        setCreated(null)
        setCreateError('')
        setKind('multi')
        setMaxUses('')
        setCount('10')
        setExpiresAt('')
        setOpen(true)
      }}>创建邀请码</button>
      <p className="sys-hint">邀请注册无需邮箱验证码</p>
      {loading ? <LoadingState label="正在加载邀请码" /> : null}
      {!loading && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !loadError ? (
        <>
          <BatchToolbar selectedCount={selected.size} totalCount={selectable.length}
            onSelectAll={() => setSelected(new Set(selectable.map((item) => item.id)))}
            onClear={() => setSelected(new Set())}
            actions={[{ key: 'disable', label: '停用', icon: Trash2, tone: 'danger', onClick: () => setPendingDisable(items.filter((item) => selected.has(item.id))) }]}
            busy={busy} progress={progress} />
          {items.length === 0 ? <p className="sys-hint">暂无邀请码</p> : (
            <ul className="sys-domain-list">
              {items.map((item) => (
                <li key={item.id} className="sys-domain-item">
                  <Checkbox type="checkbox" aria-label={`选择邀请码 ${item.prefix}`} checked={selected.has(item.id)} disabled={busy || item.disabled}
                    onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} />
                  <div className="sys-invite-main">
                    <span className="sys-invite-code">{item.prefix}…</span>
                    <span className="sys-invite-meta">
                      {item.type === 'multi' ? '多次使用' : '单次使用'}
                      {` · 已用 ${item.usedCount}${item.maxUses === null ? ' 次（不限次数）' : ` / ${item.maxUses} 次`}`}
                      {item.expiresAt ? ` · ${formatDate(item.expiresAt)} 过期` : ' · 不过期'}
                      {` · 创建于 ${formatDate(item.createdAt)}`}
                    </span>
                  </div>
                  {!item.disabled ? <StatusBadge tone={item.expiresAt && Date.parse(item.expiresAt) <= Date.now() ? 'muted' : item.remaining === 0 ? 'warning' : 'success'} size="sm">
                    {item.expiresAt && Date.parse(item.expiresAt) <= Date.now() ? '已过期' : item.remaining === 0 ? '已用完' : '可使用'}
                  </StatusBadge> : null}
                  {item.disabled
                    ? <><StatusBadge tone="muted" size="sm">已停用</StatusBadge>{item.usedCount === 0 ? <button className="button ghost" type="button" disabled={busy} onClick={() => setPendingDelete(item)}>删除</button> : null}</>
                    : <button className="button ghost" type="button" disabled={busy} onClick={() => setPendingDisable([item])}>停用</button>}
                </li>
              ))}
            </ul>
          )}

        </>
      ) : null}
      <Dialog open={open} title={created ? '邀请码已生成' : '创建邀请码'} size="m" busy={busy} focusStep={created ? 'result' : 'form'}
        dirty={!created && (kind !== 'multi' || maxUses !== '' || count !== '10' || expiresAt !== '')}
        sensitive={created !== null} onClose={() => { setOpen(false); setCreated(null) }}
        footer={(cancel) => created ? <button className="button primary" type="button" data-dialog-initial-focus onClick={cancel}>完成</button> : <>
          <button className="button secondary" type="button" disabled={busy} onClick={cancel}>取消</button>
          <button className="button primary" form="invite-editor" type="submit" disabled={busy}>生成邀请码</button>
        </>}>
          {created ? (
            <div className="sys-invite-created">
              <p className="sys-hint">新邀请码明文只显示这一次，请立即保存</p>
              <ul className="sys-domain-list">
                {created.map((entry) => (
                  <li key={entry.id} className="sys-domain-item">
                    <span className="sys-invite-code">{entry.code}</span>
                    <CopyButton value={entry.code} />
                    <CopyButton label="复制链接" value={entry.link} />
                  </li>
                ))}
              </ul>
              {created.length > 1 ? (
                <div className="sys-actions">
                  <CopyButton variant="secondary" label="复制全部" value={created.map((entry) => entry.code).join('\n')} />
                </div>
              ) : null}
            </div>
          ) : <form id="invite-editor" className="form-stack" onSubmit={create}>
            <div role="group" aria-label="邀请码类型">
              <FilterChip active={kind === 'multi'} onClick={() => setKind('multi')}>多次使用</FilterChip>
              <FilterChip active={kind === 'batch'} onClick={() => setKind('batch')}>批量单次</FilterChip>
            </div>
            <div className="sys-invite-fields">
              {kind === 'multi' ? (
                <FormField label="可用次数（留空不限）" htmlFor="sys-invite-max-uses">
                  <Input
                    id="sys-invite-max-uses"
                    type="number"
                    min={1}
                    max={100000}
                    step={1}
                    inputMode="numeric"
                    value={maxUses}
                    disabled={busy}
                    onChange={(event) => setMaxUses(event.currentTarget.value)}
                  />
                </FormField>
              ) : (
                <FormField label="生成数量" htmlFor="sys-invite-count">
                  <Input
                    id="sys-invite-count"
                    type="number"
                    min={1}
                    max={200}
                    step={1}
                    inputMode="numeric"
                    value={count}
                    disabled={busy}
                    onChange={(event) => setCount(event.currentTarget.value)}
                  />
                </FormField>
              )}
              <FormField label="过期时间（可空）" htmlFor="sys-invite-expires">
                <DateTimeInput
                  id="sys-invite-expires"
                  type="datetime-local"
                  value={expiresAt}
                  disabled={busy}
                  onChange={(event) => setExpiresAt(event.currentTarget.value)}
                />
              </FormField>
            </div>
            {createError && <p role="alert">{createError}</p>}
          </form>}
      </Dialog>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除邀请码"
        description="删除后邀请码无法恢复，已使用的邀请码保留消费记录"
        confirmLabel="删除"
        danger
        busy={busy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { remove().catch(() => undefined) }}
      />
      <ConfirmDialog
        open={pendingDisable !== null}
        title="停用邀请码"
        description={`将停用 ${pendingDisable?.length ?? 0} 个邀请码，已注册的用户不受影响`}
        confirmLabel="停用"
        danger
        busy={busy}
        onClose={() => setPendingDisable(null)}
        onConfirm={() => { disable().catch(() => undefined) }}
      />
    </div>
  )
}
