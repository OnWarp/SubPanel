import { ResourceFooter, ResourceHeading, ResourceRowActions, ResourceSelectAll } from '../admin-resources/ResourceCard'
import { CreateShareForm } from '../shares/ShareDrawer'
import type { Plan } from './plan-types'
import { Checkbox, Input, FormSelect, DateTimeInput } from '../../ui/Controls'
import { TemplateBinding } from '../system/TemplateBinding'
import { versionLabel } from '../system/template-display'
import { CheckCircle2, Plus, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { loadAdminUserOptions, peekAdminUserOptions, api, peekApi, readData, watchApi, ApiClientError, jsonBody, loadSubscriptionTemplates, subscriptionTemplatesPath, type SubscriptionTemplate, type SubscriptionTemplateBinding, type TemplateBinding as Binding, type AdminSubscription, type CatalogGroup, type CatalogResponse, type UserSummary } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { CopyButton } from '../../ui/CopyButton'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FormField, FormGroup } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { SearchInput } from '../../ui/SearchInput'
import { Switch } from '../../ui/Switch'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { SubscriptionDetailRows } from './SubscriptionDetailRows'
import { formatDate } from '../catalog/catalog-utils'
import {
  EXPIRY_BADGE,
  addExpiryDays,
  formatExpiryTime,
  formatRemaining,
  fromDatetimeLocal,
  getExpiryState,
  toDatetimeLocal,
  type ExpiryKind,
} from './expiry'

type SubscriptionForm = {
  userId: string
  planId: string
  name: string
  groupIds: string[]
  defaultClient: string
  enabled: boolean
  startsAt: string
  expiresAt: string
  templateBinding?: SubscriptionTemplateBinding
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
  { key: 'soon', label: '即将到期' },
  { key: 'expired', label: '已过期' },
  { key: 'permanent', label: '永久有效' },
  { key: 'disabled', label: '已停用' },
]

const BINDING_MODE_LABELS: Record<Binding['mode'], string> = {
  inherit: '继承默认',
  base: '基础配置',
  specific: '指定模板',
}

const INHERITED_TEMPLATE_BINDING: SubscriptionTemplateBinding = { mode: 'inherit', expectedRevision: 1 }

const EMPTY_FORM: SubscriptionForm = { userId: '', planId: '', name: '', groupIds: [], defaultClient: 'mihomo', enabled: true, startsAt: '', expiresAt: '' }

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

const EMPTY_SUBSCRIPTIONS: AdminSubscription[] = []
const PAGE_SIZE = 20
const EMPTY_GROUPS: CatalogGroup[] = []

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function toggle(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id]
}

export function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>(EMPTY_SUBSCRIPTIONS)
  const [plans, setPlans] = useState<Plan[]>(() => peekApi<{ plans: Plan[] }>('/api/admin/plans')?.plans ?? [])
  const [users, setUsers] = useState<UserSummary[]>(() => peekAdminUserOptions()?.users ?? [])
  const [catalog, setCatalog] = useState<CatalogResponse | null>(() => peekApi<CatalogResponse>('/api/admin/catalog') ?? null)
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
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const listRequestSeq = useRef(0)
  const detailsTrigger = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [selectedClient, setSelectedClient] = useState('')
  const [detailsBinding, setDetailsBinding] = useState<Binding>()
  const [detailsBindingError, setDetailsBindingError] = useState('')
  const [form, setForm] = useState<SubscriptionForm>(EMPTY_FORM)
  const [formBaseline, setFormBaseline] = useState<SubscriptionForm>(EMPTY_FORM)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [drawerError, setDrawerError] = useState('')
  const [bindingData, setBindingData] = useState<{ initial: SubscriptionTemplateBinding; options: SubscriptionTemplate[]; effective: Binding['effectiveTemplate'] }>()
  const [bindingError, setBindingError] = useState('')
  const [bindingLoading, setBindingLoading] = useState(false)
  const [bindingAttempt, setBindingAttempt] = useState(0)
  const editing = drawer === 'create' || (drawer !== null && drawer.kind === 'edit')

  useEffect(() => {
    if (drawer === null || (drawer !== 'create' && drawer.kind !== 'edit')) return
    const abort = new AbortController()
    setBindingLoading(true)
    setBindingError('')
    void readData((read) => Promise.all([
      loadSubscriptionTemplates(false, read),
      drawer === 'create' ? undefined : read<Binding>(
        `${subscriptionTemplatesPath}/bindings/${encodeURIComponent(drawer.subscription.id)}`, { signal: abort.signal },
      ),
    ]), ([templates, binding]) => {
      if (abort.signal.aborted) return
      const initial: SubscriptionTemplateBinding = binding?.mode === 'specific'
        ? { mode: 'specific', templateId: binding.templateId ?? '', expectedRevision: binding.revision }
        : { mode: binding?.mode ?? 'inherit', expectedRevision: binding?.revision ?? 1 }
      const defaultRow = templates.templates.find((row) => row.id === templates.defaultId)
      const effective = binding ? binding.effectiveTemplate : defaultRow?.publishedVersionId ? {
        templateId: defaultRow.id, templateName: defaultRow.name, versionId: defaultRow.publishedVersionId,
        sequence: defaultRow.publishedSequence ?? 1,
      } : null
      setBindingLoading(false)
      setBindingData({ initial, options: templates.templates.filter((row) => row.publishedVersionId), effective })
    }).catch((cause) => { if (!abort.signal.aborted) setBindingError(errorMessage(cause, '加载附加配置失败')) })
      .finally(() => { if (!abort.signal.aborted) setBindingLoading(false) })
    return () => abort.abort()
  }, [drawer, bindingAttempt])

  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [progress, setProgress] = useState('')
  const [transfer, setTransfer] = useState<AdminSubscription | null>(null)
  const [targetUser, setTargetUser] = useState('')
  const [sharing, setSharing] = useState<AdminSubscription | null>(null)
  const [shareUrl, setShareUrl] = useState('')
  const [qr, setQr] = useState<{ client: string; link: string; dataUrl: string; loading: boolean } | null>(null)

  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    const needle = query.trim()
    if (needle) params.set('q', needle)
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (expiryFilter !== 'all') params.set('expiry', expiryFilter)
    if (enabledOnly) params.set('enabled', '1')
    const seq = ++listRequestSeq.current
    const result = await api<{ subscriptions: AdminSubscription[]; total: number }>(`/api/admin/subscriptions?${params.toString()}`)
    if (seq !== listRequestSeq.current) return
    setSubscriptions(result.subscriptions)
    setTotal(result.total)
    setSelected((current) => new Set([...current].filter((id) => result.subscriptions.some((subscription) => subscription.id === id))))
  }, [enabledOnly, expiryFilter, page, query, statusFilter])

  const loadMeta = useCallback(() => readData((read) => Promise.all([
    loadAdminUserOptions(read),
    read<CatalogResponse>('/api/admin/catalog'),
    read<{ plans: Plan[] }>('/api/admin/plans'),
  ]), ([userResult, nextCatalog, planResult]) => {
    setPlans(planResult.plans)
    setUsers(userResult.users)
    setCatalog(nextCatalog)
  }), [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    setError('')
    try {
      await Promise.all([loadList(), loadMeta()])
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载订阅失败'))
    } finally {
      setLoading(false)
    }
  }, [loadList, loadMeta])

  useEffect(() => {
    load().catch(() => undefined)
    // Mount-only: parameter changes reload through loadList below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paramsFirstRun = useRef(true)
  useEffect(() => {
    if (paramsFirstRun.current) {
      paramsFirstRun.current = false
      return
    }
    loadList().catch((cause) => setError(errorMessage(cause, '刷新订阅列表失败')))
  }, [loadList])

  const groups = catalog?.groups ?? EMPTY_GROUPS
  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users])
  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups])
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtersActive = query.trim() !== '' || statusFilter !== 'all' || expiryFilter !== 'all' || enabledOnly

  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])
  const changeQuery = (value: string) => {
    setQuery(value)
    setPage(1)
  }

  const selectExpiry = (filter: ExpiryFilter) => {
    setPage(1)
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
        ? 'soon'
        : expiryFilter
  const selectUnified = (key: UnifiedFilter) => {
    if (key === 'all') { setStatusFilter('all'); selectExpiry('all'); return }
    if (key === 'disabled') { setStatusFilter('disabled'); selectExpiry('all'); return }
    setStatusFilter('enabled')
    selectExpiry(key)
  }

  const openCreate = () => {
    setBindingData(undefined)
    setBindingError('')
    setBindingLoading(true)
    const next = { ...EMPTY_FORM }
    setForm(next)
    setFormBaseline(next)
    setFieldErrors({})
    setDrawerError('')
    setDrawer('create')
  }

  const openEdit = (subscription: AdminSubscription) => {
    setBindingData(undefined)
    setBindingError('')
    setBindingLoading(true)
    const next = {
      userId: subscription.userId ?? '',
      name: subscription.name,
      planId: subscription.planId ?? '',
      groupIds: [...subscription.groupIds],
      defaultClient: subscription.defaultClient,
      enabled: subscription.enabled,
      startsAt: toDatetimeLocal(subscription.startsAt),
      expiresAt: toDatetimeLocal(subscription.expiresAt),
    }
    setForm(next)
    setFormBaseline(next)
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
    if (!form.name.trim()) {
      setDrawerError('请填写订阅名称')
      return
    }
    const windowErrors = validateWindow(form.startsAt, form.expiresAt)
    if (windowErrors.startsAt || windowErrors.expiresAt) {
      setFieldErrors(windowErrors)
      return
    }
    const templateBinding = form.templateBinding
    if (templateBinding?.mode === 'specific' && !templateBinding.templateId) {
      setDrawerError('请选择已发布模板')
      return
    }
    const bindingChanged = templateBinding && (templateBinding.mode !== bindingData?.initial.mode ||
      templateBinding.templateId !== bindingData?.initial.templateId)
    const startsAt = fromDatetimeLocal(form.startsAt)
    const expiresAt = fromDatetimeLocal(form.expiresAt)
    setBusy(true)
    try {
      if (drawer === 'create') {
        const result = await api<{ subscription: AdminSubscription; token: string; warning: string }>('/api/admin/subscriptions', {
          method: 'POST',
          body: jsonBody({ userId: form.userId || null, name: form.name, planId: form.planId || null, groupIds: form.groupIds, defaultClient: form.defaultClient, enabled: form.enabled, startsAt, expiresAt, templateBinding: bindingChanged ? templateBinding : undefined }),
        })
        setTokenNotice({ name: result.subscription.name, token: result.token, warning: result.warning })
        setMessage('订阅已添加')
      } else if (drawer.kind === 'edit') {
        const result = await api<{ subscription: AdminSubscription; warning: string }>(`/api/admin/subscriptions/${drawer.subscription.id}`, {
          method: 'PATCH',
          body: jsonBody({ name: form.name, planId: form.planId || null, groupIds: form.groupIds, defaultClient: form.defaultClient, enabled: form.enabled, startsAt, expiresAt, templateBinding: bindingChanged ? templateBinding : undefined }),
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
      headerContent: <ResourceSelectAll label="选择当前页订阅" ids={subscriptions.map((row) => row.id)} selected={selected} disabled={busy} onChange={(checked) => setSelected(checked ? new Set(subscriptions.map((subscription) => subscription.id)) : new Set())} />,
      width: 64,
      render: (subscription) => (
        <Checkbox
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
        <span className="resource-card-name">
          <strong>{subscription.name}</strong>
          <span className="cell-note">{subscription.tokenPrefix}…</span>
        </span>
      ),
    },
    {
      key: 'user',
      header: '所属用户',
      render: (subscription) => subscription.userId ? `已分配 · ${userNames.get(subscription.userId) ?? subscription.userId}` : '未分配',
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
      render: (subscription) => (
        <ResourceRowActions actions={[
          { label: '查看详情', onClick: (trigger) => {
            detailsTrigger.current = trigger
            setDrawerError('')
            setSelectedClient(subscription.defaultClient)
            setDetailsBinding(undefined)
            setDetailsBindingError('')
            setDrawer({ kind: 'details', subscription })
          } },
          { label: '编辑', onClick: () => openEdit(subscription) },
          { label: '转移', onClick: () => { setTargetUser(subscription.userId ?? ''); setTransfer(subscription); setDrawerError('') } },
          { label: '临时分享', disabled: !subscription.userId || !subscription.enabled, onClick: () => { setSharing(subscription); setShareUrl('') } },
        ]} />
      ),
    },
  ], [busy, groupNames, selected, subscriptions, userNames])

  const details = drawer !== null && drawer !== 'create' && drawer.kind === 'details' ? drawer.subscription : null
  const detailsId = details?.id
  useEffect(() => {
    if (!detailsId) return
    const abort = new AbortController()
    void watchApi<Binding>(
      `${subscriptionTemplatesPath}/bindings/${encodeURIComponent(detailsId)}`, setDetailsBinding, { signal: abort.signal },
    ).catch((cause) => {
      if (!abort.signal.aborted) setDetailsBindingError(errorMessage(cause, '加载附加配置失败'))
    })
    return () => abort.abort()
  }, [detailsId])

  const linkEntries = Object.entries(details?.links ?? {})
  const [client = '', link = ''] = linkEntries.find(([key]) => key === selectedClient) ?? linkEntries[0] ?? []
  const effectiveTemplate = detailsBinding?.effectiveTemplate

  return (
    <div className="page-stack resource-pages del-admin-page">

      {tokenNotice ? <section className="token-strip" aria-label="新订阅令牌"><div><strong>{tokenNotice.name} 的新令牌</strong><span>{tokenNotice.warning}</span></div><Input aria-label="新订阅令牌" value={tokenNotice.token} readOnly /><CopyButton value={tokenNotice.token} iconOnly label="复制新订阅令牌" copiedLabel="令牌已复制" onCopied={() => setError('')} onError={() => setError('浏览器未允许复制，请手动选择内容')} /></section> : null}
      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><button className="button secondary" type="button" onClick={() => { load().catch(() => undefined) }}>重试</button></div> : null}
      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}

      <section className="data-section resource-card" aria-labelledby="subscriptions-title">
        <ResourceHeading id="subscriptions-title" title="订阅" action={<button className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加订阅</button>} />
        <FilterBar className="resource-card-filters">
          <SearchInput value={query} onChange={changeQuery} label="搜索订阅" placeholder="搜索名称、用户或分组" />
          <label className="filter-field"><span>状态</span><FormSelect aria-label="订阅状态" value={activeUnified} onChange={(event) => {
            const filter = UNIFIED_FILTERS.find((item) => item.key === event.currentTarget.value)
            if (filter) selectUnified(filter.key)
          }}>{UNIFIED_FILTERS.map((filter) => <option key={filter.key} value={filter.key}>{filter.label}</option>)}</FormSelect></label>
          {enabledOnly ? <span className="exp-enabled-note">仅启用中的订阅</span> : null}
        </FilterBar>
        <BatchToolbar selectedCount={selected.size} totalCount={total} onSelectAll={() => setSelected(new Set(subscriptions.map((subscription) => subscription.id)))} onClear={() => setSelected(new Set())} actions={actions} busy={busy} progress={progress} />
        {loading && subscriptions.length === 0 ? <LoadingState label="正在加载订阅" /> : null}
        {!loading && loadError && subscriptions.length === 0 ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {!loading && !loadError && total === 0 && !filtersActive ? <EmptyState title="暂无订阅" /> : null}
        {loadError && subscriptions.length > 0 ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {total === 0 && filtersActive ? <EmptyState title="没有符合条件的订阅" /> : null}
        {subscriptions.length > 0 ? <DataTable className="resource-card-table resource-card-selectable" columns={columns} rows={subscriptions} rowKey={(subscription) => subscription.id} /> : null}
        <ResourceFooter count={total} unit="个订阅" pagination={{ page, pageCount, onPageChange: setPage }} />
      </section>

      <EditDrawer open={editing} title={drawer === 'create' ? '添加订阅' : '编辑订阅'} busy={busy} dirty={editing && JSON.stringify(form) !== JSON.stringify(formBaseline)} onClose={closeDrawer} footer={<>
        <button className="button secondary" type="button" onClick={closeDrawer} disabled={busy}>取消</button>
        <button className="button primary" type="submit" form="subscription-edit-form" disabled={busy}>{busy ? '保存中' : drawer === 'create' ? '保存订阅' : '保存修改'}</button>
      </>}>
        <form id="subscription-edit-form" className="form-stack sp-form-stack" onSubmit={saveSubscription}>
          <FormGroup title="基本信息" id="subscription-edit-basic">
            {editing && <TemplateBinding value={form.templateBinding ?? bindingData?.initial ?? INHERITED_TEMPLATE_BINDING}
              onChange={(templateBinding) => setForm((current) => ({ ...current, templateBinding }))}
              options={bindingData?.options ?? []} effective={bindingData?.effective ?? null} busy={busy || bindingLoading}
              error={bindingError} onRetry={() => setBindingAttempt((attempt) => attempt + 1)} />}
            <FormField label="订阅名称" htmlFor="subscription-name">
              <Input id="subscription-name" aria-label="订阅名称" value={form.name} maxLength={128} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required />
            </FormField>
            <FormField label="所属用户" htmlFor="subscription-user">
              <FormSelect id="subscription-user" aria-label="所属用户" value={form.userId} onChange={(event) => setForm({ ...form, userId: event.currentTarget.value })} disabled={drawer !== 'create'}><option value="">未分配</option>{users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</FormSelect>
            </FormField>
            <FormField label="订阅计划" htmlFor="subscription-plan">
              <FormSelect id="subscription-plan" value={form.planId} onChange={event => {
                const plan = plans.find(item => item.id === event.currentTarget.value)
                setForm(current => ({
                  ...current, planId: plan?.id ?? '',
                  groupIds: plan ? [...plan.groupIds] : current.groupIds,
                  expiresAt: plan && drawer === 'create'
                    ? toDatetimeLocal(addExpiryDays(fromDatetimeLocal(current.startsAt), plan.durationDays))
                    : current.expiresAt,
                }))
              }}>
                <option value="">未分配计划</option>
                {plans.filter(plan => plan.enabled || plan.id === form.planId).map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
              </FormSelect>
            </FormField>
            <fieldset className="choice-section"><legend>使用分组</legend>{groups.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选使用分组" onClick={() => setForm((current) => ({ ...current, groupIds: groups.map((group) => group.id) }))}>全选</button><button className="button secondary" type="button" aria-label="反选使用分组" onClick={() => setForm((current) => ({ ...current, groupIds: groups.map((group) => group.id).filter((id) => !current.groupIds.includes(id)) }))}>反选</button></div><div className="choice-list">{groups.map((group) => <label key={group.id} className="choice-row"><Checkbox type="checkbox" aria-label={`使用分组 ${group.name}`} checked={form.groupIds.includes(group.id)} onChange={() => setForm((current) => ({ ...current, groupIds: toggle(current.groupIds, group.id) }))} /><span>{group.name}</span></label>)}</div></> : <p className="drawer-note">请先创建分组</p>}</fieldset>
            <FormField label="默认客户端" htmlFor="subscription-client">
              <FormSelect id="subscription-client" aria-label="默认客户端" value={form.defaultClient} onChange={(event) => setForm({ ...form, defaultClient: event.currentTarget.value })}>{CLIENTS.map((client) => <option key={client} value={client}>{CLIENT_LABELS[client]}</option>)}</FormSelect>
            </FormField>
            <FormField label="启用订阅"><Switch checked={form.enabled} ariaLabel="启用订阅" onChange={(enabled) => setForm({ ...form, enabled })} /></FormField>
          </FormGroup>
          <FormGroup title="有效期" id="subscription-edit-expiry">
            <FormField label="生效时间" htmlFor="exp-starts-at" error={fieldErrors.startsAt}>
              <DateTimeInput id="exp-starts-at" className="exp-datetime" type="datetime-local" aria-label="生效时间" value={form.startsAt} onChange={(event) => {
                const startsAt = event.currentTarget.value
                setForm((current) => ({ ...current, startsAt }))
                setFieldErrors(validateWindow(startsAt, form.expiresAt))
              }} />
            </FormField>
            <FormField label="到期时间" htmlFor="exp-expires-at" error={fieldErrors.expiresAt}>
              <DateTimeInput id="exp-expires-at" className="exp-datetime" type="datetime-local" aria-label="到期时间" value={form.expiresAt} onChange={(event) => {
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
          </FormGroup>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
        </form>
      </EditDrawer>

      <EditDrawer
        open={details !== null}
        title={details?.name ?? '订阅详情'}
        headerStatus={details && <StatusBadge tone={details.enabled ? 'success' : 'muted'} size="sm">{details.enabled ? '正常' : '已停用'}</StatusBadge>}
        headerActions={details && <ResourceRowActions actions={[
          { label: '重置令牌', disabled: busy, onClick: () => resetToken(details) },
        ]} />}
        busy={busy}
        size="wide"
        onClose={closeDrawer}
        returnFocusRef={detailsTrigger}
      >
        {details ? <>
          <SubscriptionDetailRows
            user={details.userId ? userNames.get(details.userId) ?? details.userId : '未分配'}
            groups={details.groupIds.map((id) => groupNames.get(id) ?? id).join('、') || '未选择分组'}
            plan={details.planId ? {
              name: details.planName ?? '—',
              traffic: details.trafficGb ? `${details.trafficGb} GB` : '不限',
              speed: details.speedLimitMbps ? `${details.speedLimitMbps} Mbps` : '不限',
              devices: String(details.deviceLimit || '不限'),
            } : null}
            links={linkEntries.map(([key]) => ({ value: key, label: CLIENT_LABELS[key] ?? key }))}
            client={client}
            link={link}
            linkError={details.linkError || ''}
            onClient={setSelectedClient}
            onCopied={() => setError('')}
            onCopyError={() => setError('浏览器未允许复制，请手动选择内容')}
            onShowQr={() => { void showQr(client, link) }}
            bindingLabel={detailsBinding ? BINDING_MODE_LABELS[detailsBinding.mode] : '—'}
            templateName={effectiveTemplate?.templateName ?? '—'}
            version={versionLabel(effectiveTemplate?.sequence)}
            bindingError={detailsBindingError}
            bindingLoading={!detailsBinding && !detailsBindingError}
            diagnostics={Object.entries(details.diagnostics).map(([key, diagnostic]) => ({
              key,
              label: CLIENT_LABELS[key] ?? key,
              available: diagnostic.available,
              summary: `输入 ${diagnostic.inputNodes} · 输出 ${diagnostic.outputNodes} · 跳过 ${diagnostic.skippedNodes}`,
              items: diagnostic.diagnostics,
            }))}
          />
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
        </> : null}
      </EditDrawer>

      <EditDrawer open={transfer !== null} title="转移订阅" busy={busy} dirty={transfer !== null && targetUser !== (transfer.userId ?? '')} onClose={() => setTransfer(null)} footer={<button className="button primary" type="submit" form="subscription-transfer-form" disabled={busy}>确认转移</button>}>
        <form id="subscription-transfer-form" className="form-stack sp-form-stack" onSubmit={async event => {
          event.preventDefault()
          if (!transfer || busy) return
          setBusy(true)
          try {
            const result = await api<{ subscription: AdminSubscription; token: string; warning: string }>(`/api/admin/subscriptions/${transfer.id}/transfer`, { method: 'POST', body: jsonBody({ userId: targetUser || null }) })
            setTokenNotice({ name: result.subscription.name, token: result.token, warning: result.warning })
            setTransfer(null)
            await load()
          } catch (cause) { setDrawerError(errorMessage(cause, '转移失败')) } finally { setBusy(false) }
        }}>
          <FormField label="目标用户" htmlFor="subscription-transfer-user">
            <FormSelect id="subscription-transfer-user" aria-label="目标用户" value={targetUser} onChange={event => setTargetUser(event.currentTarget.value)}><option value="">未分配（回收进池）</option>{users.map(user => <option key={user.id} value={user.id}>{user.username}</option>)}</FormSelect>
          </FormField>
          <p>转移将轮换令牌，旧链接立即失效</p>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
        </form>
      </EditDrawer>
      <EditDrawer open={sharing !== null} title="临时分享" busy={busy} onClose={() => setSharing(null)}>
        {sharing ? <CreateShareForm key={sharing.id} admin subscriptionId={sharing.id} onCancel={() => setSharing(null)} onPending={setBusy} onCreated={(_share, url) => setShareUrl(url)} /> : null}
        {shareUrl ? <label className="field"><span>分享链接</span><Input aria-label="分享链接" readOnly value={shareUrl} /><CopyButton value={shareUrl} label="复制分享链接" /></label> : null}
      </EditDrawer>

      <ConfirmDialog open={qr !== null} title={qr ? `${CLIENT_LABELS[qr.client] ?? qr.client} 二维码` : '订阅二维码'} description={details?.name ?? ''} confirmLabel="复制链接" onClose={() => setQr(null)} onConfirm={() => { if (qr) { const link = qr.link; setQr(null); void copyToClipboard(link).then(() => setMessage('链接已复制')).catch(() => setError('浏览器未允许复制，请手动选择内容')) } }}>
        {qr?.loading ? <p className="qr-loading" role="status">正在生成二维码</p> : qr?.dataUrl ? <img className="qr-image" src={qr.dataUrl} alt={`${CLIENT_LABELS[qr.client] ?? qr.client} 订阅二维码`} /> : null}
      </ConfirmDialog>

      <ConfirmDialog open={confirmAction !== null} title={confirmAction === 'delete' ? '删除订阅' : '停用订阅'} description={confirmAction === 'delete' ? `将删除选中的 ${selected.size} 个订阅及其已编译内容` : `将停用选中的 ${selected.size} 个订阅，现有链接将停止提供内容`} confirmLabel={confirmAction === 'delete' ? '确认删除' : '确认停用'} danger busy={busy} onClose={() => setConfirmAction(null)} onConfirm={() => executeBatch(confirmAction ?? 'disable')} />
    </div>
  )
}