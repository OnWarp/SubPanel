import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
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
  const [kind, setKind] = useState<'multi' | 'batch'>('multi')
  const [maxUses, setMaxUses] = useState('')
  const [count, setCount] = useState('10')
  const [expiresAt, setExpiresAt] = useState('')
  const [created, setCreated] = useState<CreatedInviteCode[] | null>(null)
  const [pendingDisable, setPendingDisable] = useState<InviteCodeItem | null>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<{ invitations: InviteCodeItem[] }>('/api/admin/invitations')
      setItems(result.invitations)
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
      toast.notifyError(errorMessage(cause, '生成邀请码失败'))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!pendingDisable || busy) return
    setBusy(true)
    try {
      await api(`/api/admin/invitations/${pendingDisable.id}`, { method: 'DELETE' })
      toast.notify('邀请码已停用')
      setPendingDisable(null)
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '停用邀请码失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sys-subsection">
      <h3 className="sys-subtitle">注册邀请码</h3>
      <p className="sys-hint">邀请注册模式下，新用户凭邀请码完成注册；这里的邀请码与「用户与邀请」页的邀请链接是两套独立机制</p>
      {loading ? <LoadingState label="正在加载邀请码" /> : null}
      {!loading && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !loadError ? (
        <>
          {items.length === 0 ? <p className="sys-hint">暂无邀请码</p> : (
            <ul className="sys-domain-list">
              {items.map((item) => (
                <li key={item.id} className="sys-domain-item">
                  <div className="sys-invite-main">
                    <span className="sys-invite-code">{item.prefix}…</span>
                    <span className="sys-invite-meta">
                      {item.type === 'multi' ? '多次使用' : '单次使用'}
                      {` · 已用 ${item.usedCount}${item.maxUses === null ? ' 次（不限次数）' : ` / ${item.maxUses} 次`}`}
                      {item.expiresAt ? ` · ${formatDate(item.expiresAt)} 过期` : ' · 不过期'}
                      {` · 创建于 ${formatDate(item.createdAt)}`}
                    </span>
                  </div>
                  {item.disabled
                    ? <StatusBadge tone="muted" size="sm">已停用</StatusBadge>
                    : <button className="button ghost" type="button" disabled={busy} onClick={() => setPendingDisable(item)}>停用</button>}
                </li>
              ))}
            </ul>
          )}
          {created ? (
            <div className="sys-invite-created">
              <p className="sys-hint">新邀请码明文只显示这一次，请立即保存</p>
              <ul className="sys-domain-list">
                {created.map((entry) => (
                  <li key={entry.id} className="sys-domain-item">
                    <span className="sys-invite-code">{entry.code}</span>
                    <CopyButton value={entry.code} />
                  </li>
                ))}
              </ul>
              {created.length > 1 ? (
                <div className="sys-actions">
                  <CopyButton variant="secondary" label="复制全部" value={created.map((entry) => entry.code).join('\n')} />
                </div>
              ) : null}
            </div>
          ) : null}
          <form className="sys-form sys-invite-form" onSubmit={create}>
            <div role="group" aria-label="邀请码类型">
              <FilterChip active={kind === 'multi'} onClick={() => setKind('multi')}>多次使用</FilterChip>
              <FilterChip active={kind === 'batch'} onClick={() => setKind('batch')}>批量单次</FilterChip>
            </div>
            <div className="sys-invite-fields">
              {kind === 'multi' ? (
                <FormField label="可用次数（留空不限）" htmlFor="sys-invite-max-uses">
                  <input
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
                  <input
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
                <input
                  id="sys-invite-expires"
                  type="datetime-local"
                  value={expiresAt}
                  disabled={busy}
                  onChange={(event) => setExpiresAt(event.currentTarget.value)}
                />
              </FormField>
              <button className="button primary" type="submit" disabled={busy}>生成邀请码</button>
            </div>
          </form>
        </>
      ) : null}
      <ConfirmDialog
        open={pendingDisable !== null}
        title="停用邀请码"
        description="停用后，尚未使用的该邀请码将立即失效，已注册的用户不受影响"
        confirmLabel="停用"
        danger
        busy={busy}
        onClose={() => setPendingDisable(null)}
        onConfirm={() => { disable().catch(() => undefined) }}
      />
    </div>
  )
}
