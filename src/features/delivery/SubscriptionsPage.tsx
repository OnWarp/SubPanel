import { CheckCircle2, Copy, Eye, KeyRound, Pencil, Plus, QrCode, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiClientError, jsonBody, type AdminSubscription, type CatalogGroup, type CatalogResponse, type UserSummary } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { PageHeader } from '../../ui/PageHeader'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { DiagnosticList } from './DiagnosticList'
import { DIAGNOSTIC_HELP } from './diagnostics'
import { formatDate, matchesText } from '../catalog/catalog-utils'
import {
  EXPIRY_BADGE,
  addExpiryDays,
  formatExpiryTime,
  formatRemaining,
  fromDatetimeLocal,
  getExpiryState,
  isWithinExpiryDays,
  toDatetimeLocal,
  type ExpiryKind,
} from './expiry'

type SubscriptionForm = {
  userId: string
  name: string
  groupIds: string[]
  defaultClient: string
  enabled: boolean
  startsAt: string
  expiresAt: string
}

type ExpiryFilter = 'all' | ExpiryKind | '7' | '15' | '30'
type FieldErrors = { startsAt?: string; expiresAt?: string }

type DrawerState = 'create' | { kind: 'edit' | 'details'; subscription: AdminSubscription }
type ConfirmAction = 'disable' | 'delete'
type StatusFilter = 'all' | 'enabled' | 'disabled'

const CLIENTS = ['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'] as const
const CLIENT_LABELS: Record<string, string> = {
  auto: '自动识别',
  mihomo: 'Mihomo',
  clash: 'Clash',
  'clash-meta': 'Clash Meta',
  stash: 'Stash',
  singbox: 'sing-box',
  karing: 'Karing',
  surge: 'Surge',
  loon: 'Loon',
  quantumultx: 'Quantumult X',
  v2rayn: 'v2rayN',
  nekobox: 'NekoBox',
  shadowrocket: 'Shadowrocket',
  generic: '通用 URI',
}
const EXPIRY_FILTERS: Array<{ key: ExpiryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '正常' },
  { key: 'pending', label: '未生效' },
  { key: 'soon', label: '即将到期' },
  { key: 'expired', label: '已过期' },
  { key: 'permanent', label: '永久有效' },
]
type UnifiedFilter = 'all' | 'disabled' | Exclude<ExpiryFilter, 'all'>
const UNIFIED_FILTERS: Array<{ key: UnifiedFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '正常' },
  { key: 'pending', label: '未生效' },
  { key: 'expiring', label: '即将到期' },
  { key: 'expired', label: '已过期' },
  { key: 'permanent', label: '永久有效' },
  { key: 'disabled', label: '已停用' },
]

const EMPTY_FORM: SubscriptionForm = { userId: '', name: '', groupIds: [], defaultClient: 'mihomo', enabled: true, startsAt: '', expiresAt: '' }

const LEGACY_EXPIRY_WINDOWS: ExpiryFilter[] = ['7', '15', '30']

function parseExpiryFilter(value: string | null): ExpiryFilter {
  if (LEGACY_EXPIRY_WINDOWS.includes(value as ExpiryFilter)) return value as ExpiryFilter
  return EXPIRY_FILTERS.some((filter) => filter.key === value) ? value as ExpiryFilter : 'all'
}

function validateWindow(startsAt: string, expiresAt: string): FieldErrors {
  if (startsAt && fromDatetimeLocal(startsAt) === null) return { startsAt: '生效时间无效' }
  if (expiresAt && fromDatetimeLocal(expiresAt) === null) return { expiresAt: '到期时间无效' }
  const starts = fromDatetimeLocal(startsAt)
  const expires = fromDatetimeLocal(expiresAt)
  if (starts !== null && expires !== null && expires <= starts) return { expiresAt: '到期时间必须晚于生效时间' }
  return {}
}

function matchesExpiry(subscription: AdminSubscription, filter: ExpiryFilter, enabledOnly: boolean, now: number): boolean {
  if (enabledOnly && !subscription.enabled) return false
  if (filter === '7' || filter === '15' || filter === '30') return isWithinExpiryDays(subscription, Number(filter), now)
  if (filter === 'all') return true
  return getExpiryState(subscription, now).kind === filter
}
const EMPTY_SUBSCRIPTIONS: AdminSubscription[] = []
const EMPTY_GROUPS: CatalogGroup[] = []

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function toggle(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id]
}

export function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>(EMPTY_SUBSCRIPTIONS)
  const [users, setUsers] = useState<UserSummary[]>([])
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const expiryFilter = parseExpiryFilter(searchParams.get('expiry'))
  const enabledOnly = searchParams.get('enabled') === '1'
  const [tokenNotice, setTokenNotice] = useState<{ name: string; token: string; warning: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [form, setForm] = useState<SubscriptionForm>(EMPTY_FORM)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [drawerError, setDrawerError] = useState('')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [progress, setProgress] = useState('')
  const [qr, setQr] = useState<{ client: string; link: string; dataUrl: string; loading: boolean } | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    setError('')
    try {
      const [subscriptionResult, userResult, nextCatalog] = await Promise.all([
        api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions'),
        api<{ users: UserSummary[] }>('/api/admin/users'),
        api<CatalogResponse>('/api/admin/catalog'),
      ])
      setSubscriptions(subscriptionResult.subscriptions)
      setUsers(userResult.users)
      setCatalog(nextCatalog)
      setSelected((current) => new Set([...current].filter((id) => subscriptionResult.subscriptions.some((subscription) => subscription.id === id))))
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载订阅失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const groups = catalog?.groups ?? EMPTY_GROUPS
  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users])
  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups])
  const filtered = useMemo(() => {
    const now = Date.now()
    return subscriptions.filter((subscription) => {
      if (statusFilter === 'enabled' && !subscription.enabled) return false
      if (statusFilter === 'disabled' && subscription.enabled) return false
      if (!matchesExpiry(subscription, expiryFilter, enabledOnly, now)) return false
      if (!query.trim()) return true
      const user = userNames.get(subscription.userId) ?? subscription.userId
      const groupLabel = subscription.groupIds.map((id) => groupNames.get(id) ?? id).join(' ')
      return matchesText(subscription.name, query) || matchesText(user, query) || matchesText(groupLabel, query)
    })
  }, [enabledOnly, expiryFilter, groupNames, query, statusFilter, subscriptions, userNames])
  const allFilteredSelected = filtered.length > 0 && filtered.every((subscription) => selected.has(subscription.id))
  const someFilteredSelected = filtered.some((subscription) => selected.has(subscription.id))

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected
  }, [allFilteredSelected, someFilteredSelected])

  const selectExpiry = (filter: ExpiryFilter) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (filter === 'all') next.delete('expiry')
      else next.set('expiry', filter)
      next.delete('enabled')
      return next
    }, { replace: true })
  }

  const activeUnified: UnifiedFilter = statusFilter === 'disabled'
    ? 'disabled'
    : expiryFilter === 'all'
      ? 'all'
      : LEGACY_EXPIRY_WINDOWS.includes(expiryFilter)
        ? 'expiring'
        : expiryFilter
  const selectUnified = (key: UnifiedFilter) => {
    if (key === 'all') { setStatusFilter('all'); selectExpiry('all'); return }
    if (key === 'disabled') { setStatusFilter('disabled'); selectExpiry('all'); return }
    setStatusFilter('enabled')
    selectExpiry(key)
  }

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, userId: users[0]?.id ?? '' })
    setFieldErrors({})
    setDrawerError('')
    setDrawer('create')
  }

  const openEdit = (subscription: AdminSubscription) => {
    setForm({
      userId: subscription.userId,
      name: subscription.name,
      groupIds: [...subscription.groupIds],
      defaultClient: subscription.defaultClient,
      enabled: subscription.enabled,
      startsAt: toDatetimeLocal(subscription.startsAt),
      expiresAt: toDatetimeLocal(subscription.expiresAt),
    })
    setFieldErrors({})
    setDrawerError('')
    setDrawer({ kind: 'edit', subscription })
  }

  const shiftExpiry = (days: number) => {
    const expiresAt = toDatetimeLocal(addExpiryDays(fromDatetimeLocal(form.expiresAt), days))
    setForm((current) => ({ ...current, expiresAt }))
    setFieldErrors(validateWindow(form.startsAt, expiresAt))
  }

  const closeDrawer = () => {
    if (!busy) {
      setDrawer(null)
      setQr(null)
      setDrawerError('')
      setFieldErrors({})
    }
  }

  const showQr = async (client: string, link: string) => {
    setQr({ client, link, dataUrl: '', loading: true })
    try {
      const { default: QRCode } = await import('qrcode')
      const dataUrl = await QRCode.toDataURL(link, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      setQr({ client, link, dataUrl, loading: false })
    } catch {
      setQr(null)
      setDrawerError('二维码生成失败')
    }
  }

  const saveSubscription = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!drawer) return
    setDrawerError('')
    if (!form.userId || !form.name.trim()) {
      setDrawerError('请选择用户并填写订阅名称')
      return
    }
    const windowErrors = validateWindow(form.startsAt, form.expiresAt)
    if (windowErrors.startsAt || windowErrors.expiresAt) {
      setFieldErrors(windowErrors)
      return
    }
    const startsAt = fromDatetimeLocal(form.startsAt)
    const expiresAt = fromDatetimeLocal(form.expiresAt)
    setBusy(true)
    try {
      if (drawer === 'create') {
        const result = await api<{ subscription: AdminSubscription; token: string; warning: string }>('/api/admin/subscriptions', {
          method: 'POST',
          body: jsonBody({ userId: form.userId, name: form.name, groupIds: form.groupIds, defaultClient: form.defaultClient, enabled: form.enabled, startsAt, expiresAt }),
        })
        setTokenNotice({ name: result.subscription.name, token: result.token, warning: result.warning })
        setMessage('订阅已添加')
      } else if (drawer.kind === 'edit') {
        const result = await api<{ subscription: AdminSubscription; warning: string }>(`/api/admin/subscriptions/${drawer.subscription.id}`, {
          method: 'PATCH',
          body: jsonBody({ name: form.name, groupIds: form.groupIds, defaultClient: form.defaultClient, enabled: form.enabled, startsAt, expiresAt }),
        })
        setMessage(`订阅已更新。${result.warning}`)
      }
      setDrawer(null)
      await load()
    } catch (cause) {
      const message = errorMessage(cause, '保存订阅失败')
      if (cause instanceof ApiClientError && cause.code === 'SUBSCRIPTION_WINDOW_INVALID') setFieldErrors({ expiresAt: message })
      else setDrawerError(message)
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (value: string, success: string) => {
    try {
      await copyToClipboard(value)
      setMessage(success)
      setError('')
    } catch {
      setMessage('')
      setError('浏览器未允许复制，请手动选择内容')
    }
  }

  const resetToken = async (subscription: AdminSubscription) => {
    if (busy) return
    setBusy(true)
    setDrawerError('')
    try {
      const result = await api<{ subscription: AdminSubscription; token: string; warning: string }>(`/api/admin/subscriptions/${subscription.id}/token/reset`, { method: 'POST', body: '{}' })
      setTokenNotice({ name: result.subscription.name, token: result.token, warning: result.warning })
      setDrawer({ kind: 'details', subscription: result.subscription })
      setMessage('订阅令牌已重置')
      await load()
    } catch (cause) {
      setDrawerError(errorMessage(cause, '重置令牌失败'))
    } finally {
      setBusy(false)
    }
  }

  const executeBatch = async (action: ConfirmAction | 'enable') => {
    const ids = [...selected]
    if (!ids.length) return
    setConfirmAction(null)
    setBusy(true)
    setError('')
    setMessage('')
    const failed = new Set<string>()
    let firstFailure = ''
    try {
      for (const [index, id] of ids.entries()) {
        setProgress(`正在处理 ${index + 1}/${ids.length}`)
        try {
          if (action === 'delete') await api(`/api/admin/subscriptions/${id}`, { method: 'DELETE' })
          else await api(`/api/admin/subscriptions/${id}`, { method: 'PATCH', body: jsonBody({ enabled: action === 'enable' }) })
        } catch (cause) {
          failed.add(id)
          if (!firstFailure) firstFailure = errorMessage(cause, '请求失败')
        }
      }
      await load()
      setSelected(failed)
      if (firstFailure) setError(`${failed.size} 项未完成：${firstFailure}`)
      else setMessage(action === 'delete' ? '订阅已删除' : '批量操作已完成')
    } catch (cause) {
      setError(errorMessage(cause, '批量操作失败'))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const actions: BatchAction[] = [
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => executeBatch('enable') },
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => setConfirmAction('disable') },
    { key: 'delete', label: '删除', icon: Trash2, tone: 'danger', onClick: () => setConfirmAction('delete') },
  ]

  const columns = useMemo<Array<DataTableColumn<AdminSubscription>>>(() => [
    {
      key: 'select',
      header: '选择',
      width: 64,
      render: (subscription) => (
        <input
          type="checkbox"
          aria-label={`选择订阅 ${subscription.name}`}
          checked={selected.has(subscription.id)}
          disabled={busy}
          onChange={() => setSelected((current) => {
            const next = new Set(current)
            if (next.has(subscription.id)) next.delete(subscription.id)
            else next.add(subscription.id)
            return next
          })}
        />
      ),
    },
    {
      key: 'name',
      header: '名称',
      render: (subscription) => (
        <span className="del-name">
          <strong>{subscription.name}</strong>
          <span className="cell-note">{subscription.tokenPrefix}…</span>
        </span>
      ),
    },
    {
      key: 'user',
      header: '所属用户',
      render: (subscription) => userNames.get(subscription.userId) ?? subscription.userId,
    },
    {
      key: 'groups',
      header: '分组',
      render: (subscription) => subscription.groupIds.length
        ? subscription.groupIds.map((id) => groupNames.get(id) ?? id).join('、')
        : '未选择分组',
    },
    {
      key: 'status',
      header: '状态',
      width: 108,
      render: (subscription) => (
        <StatusBadge tone={subscription.enabled ? 'success' : 'muted'} size="sm">
          {subscription.enabled ? '正常' : '已停用'}
        </StatusBadge>
      ),
    },
    {
      key: 'times',
      header: '创建/更新时间',
      render: (subscription) => (
        <span className="del-times">
          <span>创建 {formatDate(subscription.createdAt)}</span>
          <span>更新 {formatDate(subscription.updatedAt)}</span>
        </span>
      ),
    },
    {
      key: 'expires',
      header: '到期时间',
      render: (subscription) => (
        <span className="exp-expiry">{subscription.expiresAt === null ? '—' : formatExpiryTime(subscription.expiresAt)}</span>
      ),
    },
    {
      key: 'remaining',
      header: '剩余',
      render: (subscription) => {
        const state = getExpiryState(subscription)
        const badge = EXPIRY_BADGE[state.kind]
        return (
          <span className="exp-remaining">
            <StatusBadge tone={badge.tone} size="sm">{badge.label}</StatusBadge>
            {state.remainingDays !== null ? <span>{formatRemaining(state.remainingDays)}</span> : null}
          </span>
        )
      },
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      width: 150,
      render: (subscription) => (
        <span className="row-actions">
          <button className="icon-button" type="button" aria-label="查看详情" title="查看详情" onClick={() => { setDrawerError(''); setDrawer({ kind: 'details', subscription }) }}><Eye aria-hidden="true" size={16} /></button>
          <button className="icon-button" type="button" aria-label="编辑" title="编辑" onClick={() => openEdit(subscription)}><Pencil aria-hidden="true" size={16} /></button>
          <button className="icon-button" type="button" aria-label="删除" title="删除" onClick={() => { setSelected(new Set([subscription.id])); setConfirmAction('delete') }}><Trash2 aria-hidden="true" size={16} /></button>
        </span>
      ),
    },
  ], [busy, groupNames, selected, userNames])

  const details = drawer !== null && drawer !== 'create' && drawer.kind === 'details' ? drawer.subscription : null
  const enabledCount = subscriptions.filter((subscription) => subscription.enabled).length

  return (
    <div className="page-stack del-admin-page">
      <PageHeader title="订阅" description={`${subscriptions.length} 个订阅 · ${enabledCount} 个启用`} actions={<button className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加订阅</button>} />

      {tokenNotice ? <section className="token-strip" aria-label="新订阅令牌"><div><strong>{tokenNotice.name} 的新令牌</strong><span>{tokenNotice.warning}</span></div><input aria-label="新订阅令牌" value={tokenNotice.token} readOnly /><button className="icon-button" type="button" aria-label="复制新订阅令牌" title="复制令牌" onClick={() => copyText(tokenNotice.token, '令牌已复制')}><Copy aria-hidden="true" size={17} /></button></section> : null}
      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><button className="button secondary" type="button" onClick={() => { load().catch(() => undefined) }}>重试</button></div> : null}
      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
      <section className="data-section del-admin" aria-labelledby="subscriptions-title">
        <DataHeader
          id="subscriptions-title"
          title="订阅列表"
          filters={subscriptions.length > 0 ? (
            <FilterBar className="del-filters">
              <SearchInput value={query} onChange={setQuery} label="搜索订阅" placeholder="搜索名称、用户或分组" />
              <div className="del-status-filters" role="group" aria-label="订阅状态">
                {UNIFIED_FILTERS.map((filter) => (
                  <FilterChip key={filter.key} active={activeUnified === filter.key} onClick={() => selectUnified(filter.key)}>{filter.label}</FilterChip>
                ))}
              </div>
              {enabledOnly ? <span className="exp-enabled-note">仅启用中的订阅</span> : null}
              <label className="del-select-all">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="选择全部订阅"
                  checked={allFilteredSelected}
                  disabled={busy || filtered.length === 0}
                  onChange={(event) => setSelected(event.currentTarget.checked ? new Set(filtered.map((subscription) => subscription.id)) : new Set())}
                />
                全选
              </label>
            </FilterBar>
          ) : undefined}
          actions={<BatchToolbar selectedCount={selected.size} totalCount={filtered.length} onSelectAll={() => setSelected(new Set(filtered.map((subscription) => subscription.id)))} onClear={() => setSelected(new Set())} actions={actions} busy={busy} progress={progress} />}
        />
        {loading && subscriptions.length === 0 ? <LoadingState label="正在加载订阅" /> : null}
        {!loading && loadError && subscriptions.length === 0 ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {!loading && !loadError && subscriptions.length === 0 ? <EmptyState title="暂无订阅" /> : null}
        {loadError && subscriptions.length > 0 ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {subscriptions.length > 0 && filtered.length === 0 ? <EmptyState title="没有符合条件的订阅" /> : null}
        {filtered.length > 0 ? <DataTable className="del-table" columns={columns} rows={filtered} rowKey={(subscription) => subscription.id} /> : null}
      </section>

      <EditDrawer open={drawer === 'create' || (drawer !== null && drawer.kind === 'edit')} title={drawer === 'create' ? '添加订阅' : '编辑订阅'} busy={busy} onClose={closeDrawer}>
        <form className="form-stack" onSubmit={saveSubscription}>
          <label className="field"><span>订阅名称</span><input aria-label="订阅名称" value={form.name} maxLength={128} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <label className="field"><span>所属用户</span><select aria-label="所属用户" value={form.userId} onChange={(event) => setForm({ ...form, userId: event.currentTarget.value })} disabled={drawer !== 'create'} required>{users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></label>
          <fieldset className="choice-section"><legend>使用分组</legend>{groups.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选使用分组" onClick={() => setForm((current) => ({ ...current, groupIds: groups.map((group) => group.id) }))}>全选</button><button className="button secondary" type="button" aria-label="反选使用分组" onClick={() => setForm((current) => ({ ...current, groupIds: groups.map((group) => group.id).filter((id) => !current.groupIds.includes(id)) }))}>反选</button></div><div className="choice-list">{groups.map((group) => <label key={group.id} className="choice-row"><input type="checkbox" aria-label={`使用分组 ${group.name}`} checked={form.groupIds.includes(group.id)} onChange={() => setForm((current) => ({ ...current, groupIds: toggle(current.groupIds, group.id) }))} /><span>{group.name}</span></label>)}</div></> : <p className="drawer-note">请先创建分组</p>}</fieldset>
          <label className="field"><span>默认客户端</span><select aria-label="默认客户端" value={form.defaultClient} onChange={(event) => setForm({ ...form, defaultClient: event.currentTarget.value })}>{CLIENTS.map((client) => <option key={client} value={client}>{CLIENT_LABELS[client]}</option>)}</select></label>
          <label className="toggle-field"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })} /><span>启用订阅</span></label>
          <FormField label="生效时间" htmlFor="exp-starts-at" error={fieldErrors.startsAt}>
            <input id="exp-starts-at" className="exp-datetime" type="datetime-local" aria-label="生效时间" value={form.startsAt} onChange={(event) => {
              const startsAt = event.currentTarget.value
              setForm((current) => ({ ...current, startsAt }))
              setFieldErrors(validateWindow(startsAt, form.expiresAt))
            }} />
          </FormField>
          <FormField label="到期时间" htmlFor="exp-expires-at" error={fieldErrors.expiresAt}>
            <input id="exp-expires-at" className="exp-datetime" type="datetime-local" aria-label="到期时间" value={form.expiresAt} onChange={(event) => {
              const expiresAt = event.currentTarget.value
              setForm((current) => ({ ...current, expiresAt }))
              setFieldErrors(validateWindow(form.startsAt, expiresAt))
            }} />
            <div className="exp-quick">
              <button className="button secondary" type="button" onClick={() => shiftExpiry(30)}>+30 天</button>
              <button className="button secondary" type="button" onClick={() => shiftExpiry(90)}>+90 天</button>
              <button className="button secondary" type="button" onClick={() => shiftExpiry(365)}>+365 天</button>
              <button className="button secondary" type="button" onClick={() => {
                setForm((current) => ({ ...current, expiresAt: '' }))
                setFieldErrors(validateWindow(form.startsAt, ''))
              }}>设为永久</button>
            </div>
          </FormField>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions"><button className="button secondary" type="button" onClick={closeDrawer} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy ? '保存中' : drawer === 'create' ? '保存订阅' : '保存修改'}</button></div>
        </form>
      </EditDrawer>

      <EditDrawer open={details !== null} title="订阅详情" busy={busy} size="large" onClose={closeDrawer}>
        {details ? <div className="subscription-details">
          <section><div className="detail-heading"><div><h3>{details.name}</h3><p>{userNames.get(details.userId) ?? details.userId} · {details.groupIds.map((id) => groupNames.get(id) ?? id).join('、') || '未选择分组'}</p></div><button className="button secondary" type="button" onClick={() => resetToken(details)} disabled={busy}><KeyRound aria-hidden="true" size={16} />重置令牌</button></div></section>
          <section><h3>客户端链接</h3><div className="link-list">{Object.entries(details.links).map(([client, link]) => <div key={client}><span>{CLIENT_LABELS[client] ?? client}</span><input aria-label={`${CLIENT_LABELS[client] ?? client} 链接`} value={link} readOnly /><span className="row-actions"><button className="icon-button" type="button" aria-label={`复制 ${CLIENT_LABELS[client] ?? client} 链接`} title="复制链接" onClick={() => copyText(link, `${CLIENT_LABELS[client] ?? client} 链接已复制`)}><Copy aria-hidden="true" size={16} /></button><button className="icon-button" type="button" aria-label={`显示 ${CLIENT_LABELS[client] ?? client} 二维码`} title="显示二维码" onClick={() => showQr(client, link)}><QrCode aria-hidden="true" size={16} /></button></span></div>)}</div></section>
          <details className="diagnostic-disclosure del-diagnostics"><summary>兼容诊断</summary>{Object.keys(details.diagnostics).length ? <div className="diagnostic-list"><p className="diagnostic-help">{DIAGNOSTIC_HELP}</p>{Object.entries(details.diagnostics).map(([client, diagnostic]) => <article key={client}><header><strong>{CLIENT_LABELS[client] ?? client}</strong><StatusBadge tone={diagnostic.available ? 'success' : 'warning'} size="sm">{diagnostic.available ? '可用' : '不可用'}</StatusBadge></header><p>输入 {diagnostic.inputNodes} · 输出 {diagnostic.outputNodes} · 跳过 {diagnostic.skippedNodes}</p>{diagnostic.diagnostics.length ? <DiagnosticList items={diagnostic.diagnostics} /> : null}</article>)}</div> : <p className="drawer-note">暂无编译诊断</p>}</details>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
        </div> : null}
      </EditDrawer>

      <ConfirmDialog open={qr !== null} title={qr ? `${CLIENT_LABELS[qr.client] ?? qr.client} 二维码` : '订阅二维码'} description={details?.name ?? ''} confirmLabel="复制链接" onClose={() => setQr(null)} onConfirm={() => { if (qr) { copyText(qr.link, '链接已复制').catch(() => undefined); setQr(null) } }}>
        {qr?.loading ? <p className="qr-loading" role="status">正在生成二维码</p> : qr?.dataUrl ? <img className="qr-image" src={qr.dataUrl} alt={`${CLIENT_LABELS[qr.client] ?? qr.client} 订阅二维码`} /> : null}
      </ConfirmDialog>

      <ConfirmDialog open={confirmAction !== null} title={confirmAction === 'delete' ? '删除订阅' : '停用订阅'} description={confirmAction === 'delete' ? `将删除选中的 ${selected.size} 个订阅及其已编译内容` : `将停用选中的 ${selected.size} 个订阅，现有链接将停止提供内容`} confirmLabel={confirmAction === 'delete' ? '确认删除' : '确认停用'} danger busy={busy} onClose={() => setConfirmAction(null)} onConfirm={() => executeBatch(confirmAction ?? 'disable')} />
    </div>
  )
}
