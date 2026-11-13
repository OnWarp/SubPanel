import { Ban, Share2, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiClientError, type AdminSubscription, type UserSummary } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge, type StatusBadgeTone } from '../../ui/StatusBadge'
import { useToast } from '../../ui/Toast'
import { formatDate, matchesText } from '../catalog/catalog-utils'

type ShareStatus = 'active' | 'disabled' | 'revoked'
type EffectiveStatus = ShareStatus | 'expired'
type StatusFilter = 'all' | EffectiveStatus
type PendingAction = 'disable' | 'revoke'

type AdminShare = {
  id: string
  ownerUserId: string
  subscriptionId: string
  tokenPrefix: string
  remark: string
  status: ShareStatus
  expiresAt: string
  accessCount: number
  maxAccessCount: number | null
  createdAt: string
}

const PAGE_SIZE = 20
const EMPTY_SHARES: AdminShare[] = []
const EMPTY_USERS: UserSummary[] = []
const EMPTY_SUBSCRIPTIONS: AdminSubscription[] = []

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '有效' },
  { value: 'disabled', label: '已停用' },
  { value: 'revoked', label: '已撤销' },
  { value: 'expired', label: '已过期' },
]

const STATUS_META: Record<EffectiveStatus, { label: string; tone: StatusBadgeTone }> = {
  active: { label: '有效', tone: 'success' },
  disabled: { label: '已停用', tone: 'muted' },
  revoked: { label: '已撤销', tone: 'danger' },
  expired: { label: '已过期', tone: 'warning' },
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function effectiveStatus(share: AdminShare, now: number): EffectiveStatus {
  return share.status === 'active' && Date.parse(share.expiresAt) <= now ? 'expired' : share.status
}

export function AdminSharesPage() {
  const [shares, setShares] = useState<AdminShare[]>(EMPTY_SHARES)
  const [users, setUsers] = useState<UserSummary[]>(EMPTY_USERS)
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>(EMPTY_SUBSCRIPTIONS)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [userId, setUserId] = useState('')
  const [subscriptionId, setSubscriptionId] = useState('')
  const [page, setPage] = useState(1)
  const [sharesLoading, setSharesLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ share: AdminShare; action: PendingAction } | null>(null)
  const requestId = useRef(0)
  const toast = useToast()

  const loadShares = useCallback(async () => {
    const current = ++requestId.current
    setSharesLoading(true)
    setLoadError('')
    const params = new URLSearchParams()
    if (userId) params.set('user', userId)
    if (subscriptionId) params.set('subscription', subscriptionId)
    if (statusFilter === 'active' || statusFilter === 'expired') params.set('status', 'active')
    else if (statusFilter !== 'all') params.set('status', statusFilter)
    const suffix = params.toString()
    try {
      const result = await api<{ shares: AdminShare[] }>(`/api/admin/shares${suffix ? `?${suffix}` : ''}`)
      if (current !== requestId.current) return
      setShares(result.shares)
    } catch (cause) {
      if (current !== requestId.current) return
      setLoadError(errorMessage(cause, '加载分享失败'))
    } finally {
      if (current === requestId.current) setSharesLoading(false)
    }
  }, [statusFilter, subscriptionId, userId])


  useEffect(() => { loadShares().catch(() => undefined) }, [loadShares])


  useEffect(() => {
    let active = true
    Promise.all([
      api<{ users: UserSummary[] }>('/api/admin/users'),
      api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions'),
    ]).then(([userResult, subscriptionResult]) => {
      if (!active) return
      setUsers(userResult.users)
      setSubscriptions(subscriptionResult.subscriptions)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => { setPage(1) }, [query, statusFilter, subscriptionId, userId])

  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users])
  const subscriptionNames = useMemo(() => new Map(subscriptions.map((subscription) => [subscription.id, subscription.name])), [subscriptions])

  const filtered = useMemo(() => {
    const now = Date.now()
    const needle = query.trim()
    return shares.filter((share) => {
      if (statusFilter !== 'all' && effectiveStatus(share, now) !== statusFilter) return false
      if (!needle) return true
      const owner = userNames.get(share.ownerUserId) ?? share.ownerUserId
      const subscription = subscriptionNames.get(share.subscriptionId) ?? share.subscriptionId
      return [share.remark, share.tokenPrefix, share.id, owner, subscription].some((value) => matchesText(value, needle))
    })
  }, [query, shares, statusFilter, subscriptionNames, userNames])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])
  const currentPage = Math.min(page, pageCount)
  const visibleRows = useMemo(() => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [currentPage, filtered])
  const activeCount = shares.filter((share) => effectiveStatus(share, Date.now()) === 'active').length

  const confirmAction = async () => {
    if (!pending || busy) return
    const { share, action } = pending
    setPending(null)
    setBusy(true)
    try {
      await api(`/api/admin/shares/${share.id}/${action}`, { method: 'POST', body: '{}' })
      toast.notify(action === 'revoke' ? '分享已撤销' : '分享已禁用')
      await loadShares()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, action === 'revoke' ? '撤销分享失败' : '禁用分享失败'))
      await loadShares()
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<Array<DataTableColumn<AdminShare>>>(() => [
    {
      key: 'owner',
      header: '所属用户',
      render: (share) => {
        const username = userNames.get(share.ownerUserId)
        return (
          <span className="ashr-cell">
            <strong>{username ?? share.ownerUserId}</strong>
            {username ? <span className="ashr-cell-note">{share.ownerUserId}</span> : null}
          </span>
        )
      },
    },
    {
      key: 'subscription',
      header: '关联订阅',
      render: (share) => {
        const name = subscriptionNames.get(share.subscriptionId)
        return (
          <span className="ashr-cell">
            <strong>{name ?? share.subscriptionId}</strong>
            {name ? <span className="ashr-cell-note">{share.subscriptionId}</span> : null}
          </span>
        )
      },
    },
    {
      key: 'remark',
      header: '备注',
      render: (share) => (
        <span className="ashr-cell">
          <strong className="ashr-remark">{share.remark.trim() || '未填写'}</strong>
          <span className="ashr-cell-note">{share.id} · {share.tokenPrefix}…</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 100,
      render: (share) => {
        const meta = STATUS_META[effectiveStatus(share, Date.now())]
        return <StatusBadge tone={meta.tone} size="sm">{meta.label}</StatusBadge>
      },
    },
    {
      key: 'accessCount',
      header: '访问次数',
      width: 104,
      render: (share) => (
        <span className="ashr-count">
          <strong>{share.accessCount}</strong>
          {share.maxAccessCount !== null ? <span className="ashr-cell-note">上限 {share.maxAccessCount}</span> : null}
        </span>
      ),
    },
    { key: 'expiresAt', header: '到期时间', width: 160, render: (share) => <span className="ashr-time">{formatDate(share.expiresAt)}</span> },
    { key: 'createdAt', header: '创建时间', width: 160, render: (share) => <span className="ashr-time">{formatDate(share.createdAt)}</span> },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      width: 104,
      render: (share) => (
        <span className="row-actions">
          {share.status === 'active' ? (
            <button
              className="icon-button"
              type="button"
              aria-label={`禁用分享 ${share.remark || share.id}`}
              title="禁用"
              disabled={busy}
              onClick={() => setPending({ share, action: 'disable' })}
            >
              <Ban aria-hidden="true" size={16} />
            </button>
          ) : null}
          {share.status !== 'revoked' ? (
            <button
              className="icon-button danger"
              type="button"
              aria-label={`撤销分享 ${share.remark || share.id}`}
              title="撤销"
              disabled={busy}
              onClick={() => setPending({ share, action: 'revoke' })}
            >
              <Trash2 aria-hidden="true" size={16} />
            </button>
          ) : null}
          {share.status === 'revoked' ? <span className="ashr-cell-note">—</span> : null}
        </span>
      ),
    },
  ], [busy, subscriptionNames, userNames])

  return (
    <div className="page-stack ashr-page">
      <PageHeader title="分享管理" description={`${shares.length} 个分享 · ${activeCount} 个有效`} />

      <section className="data-section ashr-list" aria-labelledby="ashr-shares-title">
        <DataHeader
          id="ashr-shares-title"
          title="全站分享"
          filters={(
            <FilterBar className="ashr-filters">
              <SearchInput className="ashr-search" label="搜索分享" placeholder="搜索备注、前缀或用户" value={query} onChange={setQuery} />
              <div className="ashr-chips" role="group" aria-label="分享状态">
                {STATUS_FILTERS.map((filter) => (
                  <FilterChip key={filter.value} active={statusFilter === filter.value} onClick={() => setStatusFilter(filter.value)}>{filter.label}</FilterChip>
                ))}
              </div>
              <label className="ashr-filter-field">
                <span>用户</span>
                <select aria-label="按用户筛选" value={userId} onChange={(event) => setUserId(event.currentTarget.value)}>
                  <option value="">全部</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
                </select>
              </label>
              <label className="ashr-filter-field">
                <span>订阅</span>
                <select aria-label="按订阅筛选" value={subscriptionId} onChange={(event) => setSubscriptionId(event.currentTarget.value)}>
                  <option value="">全部</option>
                  {subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.name}</option>)}
                </select>
              </label>
            </FilterBar>
          )}
        />
        {loadError ? <div className="ashr-state"><ErrorState message={loadError} onRetry={() => { loadShares().catch(() => undefined) }} /></div> : null}
        {sharesLoading && shares.length === 0 ? <LoadingState label="正在加载分享" /> : null}
        {!sharesLoading && !loadError && shares.length === 0 ? (
          <div className="ashr-empty"><EmptyState icon={Share2} title="暂无分享" description="用户创建分享后会在这里显示" /></div>
        ) : null}
        {shares.length > 0 && filtered.length === 0 ? (
          <div className="ashr-empty"><EmptyState title="没有符合条件的分享" /></div>
        ) : null}
        {filtered.length > 0 ? (
          <>
            <div className="ashr-list-meta">
              <span>{filtered.length} 个分享符合当前筛选</span>
              <span>第 {currentPage} / {pageCount} 页</span>
            </div>
            <DataTable
              className="ashr-table"
              columns={columns}
              rows={visibleRows}
              rowKey={(share) => share.id}
              empty="暂无匹配分享"
              pagination={{ page: currentPage, pageCount, onPageChange: setPage }}
            />
          </>
        ) : null}
      </section>

      <section className="data-section ashr-settings" aria-labelledby="ashr-settings-title">
        <DataHeader id="ashr-settings-title" title="全局策略" />
        <div className="ashr-settings-form">
          <p className="ashr-settings-hint">分享策略已迁至系统管理页统一维护</p>
          <div className="ashr-actions">
            <Link className="button" to="/system">前往系统管理</Link>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.action === 'revoke' ? '撤销分享' : '禁用分享'}
        description={pending
          ? `将${pending.action === 'revoke' ? '撤销' : '禁用'}分享「${pending.share.remark.trim() || pending.share.id}」${pending.action === 'revoke' ? '，撤销后不可恢复' : '，已发放的链接会暂停访问'}`
          : ''}
        confirmLabel={pending?.action === 'revoke' ? '确认撤销' : '确认禁用'}
        danger
        busy={busy}
        onClose={() => { if (!busy) setPending(null) }}
        onConfirm={() => { confirmAction().catch(() => undefined) }}
      />
    </div>
  )
}
