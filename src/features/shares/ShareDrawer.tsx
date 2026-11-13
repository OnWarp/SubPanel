import { useCallback, useEffect, useMemo, useState, type FormEvent, type RefObject } from 'react'
import { ApiClientError } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EditDrawer } from '../../ui/EditDrawer'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { SearchInput } from '../../ui/SearchInput'
import { Switch } from '../../ui/Switch'
import { StatusBadge, type StatusBadgeTone } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import {
  createShare,
  deleteShare,
  disableShare,
  enableShare,
  listShares,
  resetShareToken,
  type ShareStatus,
  type ShareView,
} from './api'
import { buildShareUrl, formatShareTime, readPublicBaseUrl } from './share-link'

const PAGE_SIZE = 8
const QUICK_DAYS = [7, 30, 90] as const

const STATUS_FILTERS: Array<{ value: 'all' | ShareStatus, label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '已禁用' },
  { value: 'revoked', label: '已撤销' },
]

type Notice = { tone: 'error' | 'success' | 'warning', text: string }
type Pending = { kind: 'disable' | 'delete' | 'reset', share: ShareView }
type ShareTarget = { id: string, name: string }

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function statusView(status: ShareStatus): { label: string, tone: StatusBadgeTone } {
  if (status === 'active') return { label: '启用', tone: 'success' }
  if (status === 'disabled') return { label: '已禁用', tone: 'warning' }
  return { label: '已撤销', tone: 'danger' }
}

function accessLabel(share: ShareView): string {
  if (share.maxAccessCount === null) return String(share.accessCount)
  return `${share.accessCount} / ${share.maxAccessCount}`
}

function shareLabel(share: ShareView): string {
  return share.remark.trim() || '未备注'
}

function ShareToggle({ label, checked, onChange, disabled }: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <FormField label={label}>
      <Switch checked={checked} disabled={disabled} onChange={onChange} ariaLabel={label} />
    </FormField>
  )
}

function CreateShareForm({ subscriptionId, onCancel, onPending, onCreated }: {
  subscriptionId: string
  onCancel: () => void
  onPending: (pending: boolean) => void
  onCreated: (share: ShareView, url: string) => void
}) {
  const [remark, setRemark] = useState('')
  const [days, setDays] = useState('')
  const [password, setPassword] = useState('')
  const [allowOriginalLink, setAllowOriginalLink] = useState(false)
  const [showSubscriptionName, setShowSubscriptionName] = useState(false)
  const [showGroups, setShowGroups] = useState(false)
  const [showExpiry, setShowExpiry] = useState(false)
  const [showNodeNames, setShowNodeNames] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    const trimmedDays = days.trim()
    let expiresAt: string | undefined
    if (trimmedDays !== '') {
      if (!/^[1-9]\d*$/u.test(trimmedDays)) {
        setError('请输入有效天数')
        return
      }
      expiresAt = new Date(Date.now() + Number(trimmedDays) * 86_400_000).toISOString()
    }
    const secret = password
    if (secret !== '' && (secret.length < 8 || secret.length > 128)) {
      setError('访问密码不符合要求')
      return
    }
    setError('')
    setSubmitting(true)
    onPending(true)
    try {
      const result = await createShare({
        subscriptionId,
        remark: remark.trim() || undefined,
        expiresAt,
        allowOriginalLink,
        showSubscriptionName,
        showGroups,
        showExpiry,
        showNodeNames,
        accessControl: secret === '' ? 'none' : 'password',
        password: secret === '' ? undefined : secret,
      })
      setPassword('')
      onCreated(result.share, buildShareUrl(result.token, readPublicBaseUrl(result)))
    } catch (cause) {
      setError(errorText(cause, '创建分享失败'))
    } finally {
      setSubmitting(false)
      onPending(false)
    }
  }

  return (
    <form className="form-stack sh-form" onSubmit={(event) => { submit(event).catch(() => undefined) }}>
      <FormField label="备注" htmlFor="share-remark">
        <input id="share-remark" value={remark} maxLength={200} disabled={submitting} onChange={(event) => setRemark(event.currentTarget.value)} />
      </FormField>
      <FormField label="有效期（天）" htmlFor="share-days">
        <input
          id="share-days"
          inputMode="numeric"
          value={days}
          disabled={submitting}
          placeholder="留空使用默认有效期"
          onChange={(event) => setDays(event.currentTarget.value)}
        />
      </FormField>
      <div className="sh-days" role="group" aria-label="快捷有效期">
        {QUICK_DAYS.map((day) => (
          <FilterChip key={day} active={days === String(day)} onClick={() => { if (!submitting) setDays(String(day)) }}>{day} 天</FilterChip>
        ))}
      </div>
      <FormField label="访问密码" htmlFor="share-password">
        <input
          id="share-password"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={password}
          disabled={submitting}
          placeholder="留空表示不设密码"
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
      </FormField>
      <ShareToggle label="允许查看原始链接" checked={allowOriginalLink} disabled={submitting} onChange={setAllowOriginalLink} />
      <fieldset className="sh-switches">
        <legend>展示内容</legend>
        <ShareToggle label="订阅名" checked={showSubscriptionName} disabled={submitting} onChange={setShowSubscriptionName} />
        <ShareToggle label="分组" checked={showGroups} disabled={submitting} onChange={setShowGroups} />
        <ShareToggle label="到期" checked={showExpiry} disabled={submitting} onChange={setShowExpiry} />
        <ShareToggle label="节点名" checked={showNodeNames} disabled={submitting} onChange={setShowNodeNames} />
      </fieldset>
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      <div className="dialog-actions">
        <button className="button secondary" type="button" onClick={onCancel} disabled={submitting}>取消</button>
        <button className="button primary" type="submit" disabled={submitting}>{submitting ? '正在创建' : '创建'}</button>
      </div>
    </form>
  )
}

export function ShareDrawer({ subscription, onClose, returnFocusRef }: {
  subscription: ShareTarget | null
  onClose: () => void
  returnFocusRef?: RefObject<HTMLButtonElement | null>
}) {
  const subscriptionId = subscription?.id ?? ''
  const [shares, setShares] = useState<ShareView[]>([])
  const [issued, setIssued] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | ShareStatus>('all')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [revealed, setRevealed] = useState<{ url: string, title: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await listShares()
      setShares(result.shares.filter((share) => share.subscriptionId === id))
    } catch (cause) {
      setLoadError(errorText(cause, '加载分享失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!subscriptionId) return
    setShares([])
    setCreating(false)
    setRevealed(null)
    setQuery('')
    setStatus('all')
    setPage(1)
    setNotice(null)
    load(subscriptionId).catch(() => undefined)
  }, [load, subscriptionId])

  useEffect(() => { setPage(1) }, [query, status])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return shares.filter((share) => {
      if (status !== 'all' && share.status !== status) return false
      if (!needle) return true
      return share.remark.toLowerCase().includes(needle)
    })
  }, [query, shares, status])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const rows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const copyIssued = async (share: ShareView) => {
    const url = issued[share.id]
    if (!url) {
      setNotice({ tone: 'warning', text: '完整链接只在创建或重置后出现' })
      return
    }
    try {
      await copyToClipboard(url)
      setNotice({ tone: 'success', text: '分享链接已复制' })
    } catch {
      setNotice({ tone: 'error', text: '浏览器未允许复制，请手动选择内容' })
    }
  }

  const enable = async (share: ShareView) => {
    setBusyId(share.id)
    setNotice(null)
    try {
      const result = await enableShare(share.id)
      setShares((current) => current.map((item) => item.id === result.share.id ? result.share : item))
      setNotice({ tone: 'success', text: '分享已启用' })
    } catch (cause) {
      setNotice({ tone: 'error', text: errorText(cause, '启用分享失败') })
    } finally {
      setBusyId('')
    }
  }

  const runPending = async () => {
    if (!pending) return
    const target = pending
    setBusyId(target.share.id)
    setNotice(null)
    try {
      if (target.kind === 'disable') {
        const result = await disableShare(target.share.id)
        setShares((current) => current.map((item) => item.id === result.share.id ? result.share : item))
        setNotice({ tone: 'success', text: '分享已禁用' })
      } else if (target.kind === 'delete') {
        await deleteShare(target.share.id)
        setShares((current) => current.filter((item) => item.id !== target.share.id))
        setIssued((current) => {
          const next = { ...current }
          delete next[target.share.id]
          return next
        })
        setNotice({ tone: 'success', text: '分享已删除' })
      } else {
        const result = await resetShareToken(target.share.id)
        const url = buildShareUrl(result.token, readPublicBaseUrl(result))
        setIssued((current) => ({ ...current, [result.share.id]: url }))
        setShares((current) => current.map((item) => item.id === result.share.id ? result.share : item))
        setRevealed({ url, title: '新的分享链接' })
        setNotice({ tone: 'success', text: '分享链接已重置' })
      }
      setPending(null)
    } catch (cause) {
      setNotice({ tone: 'error', text: errorText(cause, '操作失败') })
      setPending(null)
    } finally {
      setBusyId('')
    }
  }

  const columns: Array<DataTableColumn<ShareView>> = [
    {
      key: 'remark',
      header: '备注',
      render: (share) => share.remark.trim() || '无备注',
    },
    {
      key: 'status',
      header: '状态',
      render: (share) => {
        const view = statusView(share.status)
        return <StatusBadge tone={view.tone} size="sm">{view.label}</StatusBadge>
      },
    },
    {
      key: 'expiresAt',
      header: '到期',
      render: (share) => formatShareTime(share.expiresAt),
    },
    {
      key: 'accessCount',
      header: '访问次数',
      render: (share) => accessLabel(share),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (share) => formatShareTime(share.createdAt),
    },
    {
      key: 'actions',
      header: '操作',
      render: (share) => {
        const label = shareLabel(share)
        const locked = busyId !== ''
        return (
          <div className="sh-row-actions">
            <button className="button secondary" type="button" disabled={locked} aria-label={`复制${label}的分享链接`} onClick={() => { copyIssued(share).catch(() => undefined) }}>复制</button>
            {share.status === 'active' ? <button className="button secondary" type="button" disabled={locked} aria-label={`禁用${label}`} onClick={() => setPending({ kind: 'disable', share })}>禁用</button> : null}
            {share.status === 'disabled' ? <button className="button secondary" type="button" disabled={locked} aria-label={`启用${label}`} onClick={() => { enable(share).catch(() => undefined) }}>启用</button> : null}
            {share.status !== 'revoked' ? <button className="button secondary" type="button" disabled={locked} aria-label={`重置${label}的链接`} onClick={() => setPending({ kind: 'reset', share })}>重置</button> : null}
            <button className="button danger" type="button" disabled={locked} aria-label={`删除${label}`} onClick={() => setPending({ kind: 'delete', share })}>删除</button>
          </div>
        )
      },
    },
  ]

  const confirmCopy = pending?.kind === 'delete'
    ? { title: '删除分享', description: '删除后该分享链接会立即失效', confirmLabel: '确认删除' }
    : pending?.kind === 'reset'
      ? { title: '重置分享链接', description: '重置后旧链接会立即失效，新链接只显示一次', confirmLabel: '确认重置' }
      : { title: '禁用分享', description: '禁用后访问者将无法打开该链接', confirmLabel: '确认禁用' }

  return (
    <>
      <EditDrawer
        open={subscription !== null}
        title={subscription ? `${subscription.name} 的分享` : '分享'}
        size="large"
        busy={createBusy || busyId !== ''}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
      >
        <div className="sh-drawer">
          {notice ? <StatusMessage tone={notice.tone}>{notice.text}</StatusMessage> : null}
          {revealed ? (
            <section className="sh-reveal" aria-live="polite" aria-label={revealed.title}>
              <strong>{revealed.title}</strong>
              <p>请立即复制分享链接，离开页面前仍可在列表中复制</p>
              <div className="sh-reveal-line">
                <input aria-label="分享链接" value={revealed.url} readOnly />
                <button className="button secondary" type="button" onClick={() => { copyToClipboard(revealed.url).then(() => setNotice({ tone: 'success', text: '分享链接已复制' })).catch(() => setNotice({ tone: 'error', text: '浏览器未允许复制，请手动选择内容' })) }}>复制链接</button>
              </div>
              <button className="button secondary" type="button" onClick={() => setRevealed(null)}>完成</button>
            </section>
          ) : null}
          {creating && subscription ? (
            <CreateShareForm
              subscriptionId={subscription.id}
              onCancel={() => { if (!createBusy) setCreating(false) }}
              onPending={setCreateBusy}
              onCreated={(share, url) => {
                setIssued((current) => ({ ...current, [share.id]: url }))
                setRevealed({ url, title: '分享链接' })
                setCreating(false)
                setShares((current) => [share, ...current.filter((item) => item.id !== share.id)])
                setNotice({ tone: 'success', text: '分享已创建' })
              }}
            />
          ) : (
            <div className="sh-drawer-lead">
              <button className="button primary" type="button" onClick={() => setCreating(true)} disabled={!subscription || loading}>创建分享</button>
            </div>
          )}

          {loading ? <div className="sh-state"><LoadingState label="正在加载分享" /></div> : null}
          {!loading && loadError ? <div className="sh-state"><ErrorState message={loadError} onRetry={() => { if (subscriptionId) load(subscriptionId).catch(() => undefined) }} /></div> : null}
          {!loading && !loadError && shares.length === 0 ? <div className="sh-state"><EmptyState title="还没有分享" description="创建后可以把链接发给别人" /></div> : null}
          {!loading && !loadError && shares.length > 0 ? (
            <div className="sh-list">
              <h3 className="sh-list-title">分享列表</h3>
              <FilterBar className="sh-filters">
                <SearchInput label="搜索备注" placeholder="搜索备注" value={query} onChange={setQuery} />
                <div className="sh-chips" role="group" aria-label="分享状态">
                  {STATUS_FILTERS.map((item) => (
                    <FilterChip key={item.value} active={status === item.value} onClick={() => setStatus(item.value)}>{item.label}</FilterChip>
                  ))}
                </div>
              </FilterBar>
              {filtered.length === 0 ? <div className="sh-state"><EmptyState title="没有匹配的分享" description="换一个关键词或状态" /></div> : (
                <DataTable
                  className="sh-share-table"
                  columns={columns}
                  rows={rows}
                  rowKey={(share) => share.id}
                  pagination={pageCount > 1 ? { page: currentPage, pageCount, onPageChange: setPage } : undefined}
                />
              )}
            </div>
          ) : null}
        </div>
      </EditDrawer>
      <ConfirmDialog
        open={pending !== null}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.confirmLabel}
        danger
        busy={busyId !== ''}
        onClose={() => { if (busyId === '') setPending(null) }}
        onConfirm={() => { runPending().catch(() => undefined) }}
      />
    </>
  )
}
