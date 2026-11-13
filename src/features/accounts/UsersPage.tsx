import { CheckCircle2, Copy, Crown, KeyRound, Mail, Plus, RotateCcw, Trash2, Users, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type AdminSubscription, type AdminUsersResponse, type UserSummary } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'
import { EXPIRY_BADGE, formatExpiryTime, formatRemaining, getExpiryState } from '../delivery/expiry'

type InviteSummary = {
  id: string
  username: string
  createdAt: string
  expiresAt: string
}

type BatchTarget = 'users' | 'invites'
type BatchActionKind = 'disable' | 'revoke'
type StatusFilter = 'all' | 'enabled' | 'disabled'
type UsersView = 'active' | 'trash'
type ConfirmKind = 'promote' | 'soft-delete' | 'purge'

const PAGE_SIZE = 20

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '正常' },
  { value: 'disabled', label: '已停用' },
]

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function formatDate(value?: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN')
}

function UserSubscriptionList({ items }: { items: AdminSubscription[] }) {
  return (
    <details className="exp-user-subs">
      <summary>{items.length} 个订阅</summary>
      <ul>
        {items.map((subscription) => {
          const state = getExpiryState(subscription)
          const badge = EXPIRY_BADGE[state.kind]
          return (
            <li className="exp-user-sub" key={subscription.id}>
              <strong>{subscription.name}</strong>
              <StatusBadge tone={badge.tone} size="sm">{badge.label}</StatusBadge>
              <span>{state.expiresAt === null ? '永久有效' : `到期 ${formatExpiryTime(state.expiresAt)}`}</span>
              {state.kind === 'pending' ? <span>{`将于 ${formatExpiryTime(state.startsAt)} 生效`}</span> : null}
              {state.expiresAt !== null ? <span>{`剩余 ${formatRemaining(state.remainingDays ?? 0)}`}</span> : null}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

function toggleId(current: Set<string>, id: string) {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function UsersPage() {
  const [users, setUsers] = useState<UserSummary[]>([])
  const [total, setTotal] = useState(0)
  const [invites, setInvites] = useState<InviteSummary[]>([])
  const [newLink, setNewLink] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [resetUser, setResetUser] = useState<UserSummary | null>(null)
  const [resetError, setResetError] = useState('')
  const [tempPassword, setTempPassword] = useState('')
  const [mutating, setMutating] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [selectedInvites, setSelectedInvites] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ target: BatchTarget; action: BatchActionKind } | null>(null)
  const [batchProgress, setBatchProgress] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [view, setView] = useState<UsersView>('active')
  const [page, setPage] = useState(1)
  const [confirmAction, setConfirmAction] = useState<{ kind: ConfirmKind; user: UserSummary } | null>(null)
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [subscriptionsReady, setSubscriptionsReady] = useState(false)
  const [subscriptionNote, setSubscriptionNote] = useState('')
  const toast = useToast()
  const usersRequestSeq = useRef(0)

  const loadUsers = useCallback(async () => {
    const params = new URLSearchParams({
      deleted: view === 'trash' ? 'only' : 'active',
      page: String(page),
      pageSize: String(PAGE_SIZE),
    })
    const needle = query.trim()
    if (needle) params.set('q', needle)
    if (statusFilter !== 'all') params.set('status', statusFilter)
    const seq = ++usersRequestSeq.current
    const result = await api<AdminUsersResponse>(`/api/admin/users?${params.toString()}`)
    if (seq !== usersRequestSeq.current) return
    setUsers(result.users)
    setTotal(result.total)
    setSelectedUsers((current) => new Set([...current].filter((id) => result.users.some((user) => user.id === id && user.role === 'user'))))
  }, [page, query, statusFilter, view])

  const load = useCallback(async () => {
    const [, inviteResult] = await Promise.all([
      loadUsers(),
      api<{ invites: InviteSummary[] }>('/api/admin/invites'),
    ])
    setInvites(inviteResult.invites)
    setSelectedInvites((current) => new Set([...current].filter((id) => inviteResult.invites.some((invite) => invite.id === id))))
    setLoadError('')
    try {
      const subscriptionResult = await api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions')
      setSubscriptions(subscriptionResult.subscriptions)
      setSubscriptionsReady(true)
      setSubscriptionNote('')
    } catch (cause) {
      setSubscriptionNote(errorMessage(cause, '订阅时效加载失败'))
    }
  }, [loadUsers])

  useEffect(() => {
    setLoading(true)
    load()
      .catch((cause) => setLoadError(errorMessage(cause, '加载用户失败')))
      .finally(() => setLoading(false))
    // Mount-only: parameter changes reload through loadUsers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paramsFirstRun = useRef(true)
  useEffect(() => {
    if (paramsFirstRun.current) {
      paramsFirstRun.current = false
      return
    }
    loadUsers().catch((cause) => toast.notifyError(errorMessage(cause, '刷新用户列表失败')))
  }, [loadUsers, toast])

  const selectableUsers = useMemo(
    () => users.filter((user) => user.role === 'user'),
    [users],
  )
  const subscriptionsByUser = useMemo(() => {
    const grouped = new Map<string, AdminSubscription[]>()
    for (const subscription of subscriptions) {
      const owned = grouped.get(subscription.userId) ?? []
      owned.push(subscription)
      grouped.set(subscription.userId, owned)
    }
    return grouped
  }, [subscriptions])

  useEffect(() => {
    const visible = new Set(selectableUsers.map((user) => user.id))
    setSelectedUsers((current) => {
      const next = [...current].filter((id) => visible.has(id))
      return next.length === current.size ? current : new Set(next)
    })
  }, [selectableUsers])

  const retry = () => {
    setLoading(true)
    setLoadError('')
    load()
      .catch((cause) => setLoadError(errorMessage(cause, '加载用户失败')))
      .finally(() => setLoading(false))
  }

  const refreshUsers = async () => {
    try {
      await loadUsers()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '刷新用户列表失败'))
    }
  }

  const switchView = (next: UsersView) => {
    if (next === view) return
    setView(next)
    setPage(1)
    setSelectedUsers(new Set())
  }

  const changeQuery = (value: string) => {
    setQuery(value)
    setPage(1)
  }

  const changeStatusFilter = (value: StatusFilter) => {
    setStatusFilter(value)
    setPage(1)
  }

  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mutating) return
    const form = event.currentTarget
    const data = new FormData(form)
    setMutating(true)
    try {
      const result = await api<{ invite: InviteSummary & { link: string } }>('/api/admin/invites', {
        method: 'POST',
        body: jsonBody({ username: data.get('username') }),
      })
      setNewLink(result.invite.link)
      toast.notify('邀请已创建。链接只在本次显示')
      form.reset()
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '创建邀请失败'))
    } finally {
      setMutating(false)
    }
  }

  const copyLink = async () => {
    try {
      await copyToClipboard(newLink)
      toast.notify('邀请链接已复制')
    } catch {
      toast.notifyError('浏览器未允许复制，请手动选择链接')
    }
  }

  const copyTempPassword = async () => {
    try {
      await copyToClipboard(tempPassword)
      toast.notify('临时密码已复制')
    } catch {
      toast.notifyError('浏览器未允许复制，请手动选择密码')
    }
  }

  const setEnabled = async (user: UserSummary, enabled: boolean) => {
    if (mutating) return
    setMutating(true)
    setUsers((current) => current.map((candidate) => candidate.id === user.id ? { ...candidate, enabled } : candidate))
    try {
      const result = await api<{ user: UserSummary }>(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: jsonBody({ enabled }),
      })
      setUsers((current) => current.map((candidate) => candidate.id === user.id ? result.user : candidate))
    } catch (cause) {
      setUsers((current) => current.map((candidate) => candidate.id === user.id ? { ...candidate, enabled: user.enabled } : candidate))
      toast.notifyError(errorMessage(cause, '更新用户失败'))
    } finally {
      setMutating(false)
    }
  }

  const revokeInvite = async (id: string) => {
    if (mutating) return
    setMutating(true)
    try {
      await api(`/api/admin/invites/${id}`, { method: 'DELETE' })
      setInvites((current) => current.filter((invite) => invite.id !== id))
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '撤销邀请失败'))
    } finally {
      setMutating(false)
    }
  }

  const openPasswordReset = (user: UserSummary) => {
    setResetUser(user)
    setResetError('')
    setTempPassword('')
  }

  const closePasswordReset = () => {
    if (mutating) return
    setResetUser(null)
    setResetError('')
    setTempPassword('')
  }

  const resetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!resetUser || mutating) return
    const form = event.currentTarget
    const data = new FormData(form)
    const newPassword = String(data.get('newPassword'))
    if (newPassword !== String(data.get('confirmPassword'))) {
      setResetError('两次输入的新密码不一致')
      return
    }
    setMutating(true)
    try {
      const result = await api<{ user: UserSummary; temporaryPassword: string }>(`/api/admin/users/${resetUser.id}/reset-password`, {
        method: 'POST',
        body: jsonBody({ newPassword }),
      })
      setUsers((current) => current.map((candidate) => candidate.id === resetUser.id ? result.user : candidate))
      // The temporary password is revealed exactly once, in this dialog.
      setTempPassword(result.temporaryPassword)
      setResetError('')
      form.reset()
    } catch (cause) {
      setResetError(errorMessage(cause, '重置密码失败'))
    } finally {
      setMutating(false)
    }
  }

  const executeConfirmAction = async () => {
    if (!confirmAction || mutating) return
    const { kind, user } = confirmAction
    setConfirmAction(null)
    setMutating(true)
    try {
      if (kind === 'promote') {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: jsonBody({ role: 'admin' }) })
        toast.notify(`管理员已转给 ${user.username}，双方现有会话已退出，请重新登录`)
      } else if (kind === 'soft-delete') {
        await api(`/api/admin/users/${user.id}`, { method: 'DELETE' })
        toast.notify(`${user.username} 已移入回收站`)
      } else {
        await api(`/api/admin/users/${user.id}/purge`, { method: 'POST', body: jsonBody({}) })
        toast.notify(`${user.username} 已永久删除`)
      }
      await refreshUsers()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '操作失败'))
    } finally {
      setMutating(false)
    }
  }

  const restoreUser = async (user: UserSummary) => {
    if (mutating) return
    setMutating(true)
    try {
      await api(`/api/admin/users/${user.id}/restore`, { method: 'POST', body: jsonBody({}) })
      toast.notify(`${user.username} 已恢复`)
      await refreshUsers()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '恢复用户失败'))
    } finally {
      setMutating(false)
    }
  }

  const executeBatch = async (target: BatchTarget, action: BatchActionKind | 'enable') => {
    const ids = [...(target === 'users' ? selectedUsers : selectedInvites)]
    if (!ids.length || mutating) return
    setBatchConfirm(null)
    setMutating(true)
    let firstFailure = ''
    const failed = new Set<string>()
    try {
      for (const [index, id] of ids.entries()) {
        setBatchProgress(`正在处理 ${index + 1}/${ids.length}`)
        try {
          if (target === 'users') {
            await api(`/api/admin/users/${id}`, { method: 'PATCH', body: jsonBody({ enabled: action === 'enable' }) })
          } else {
            await api(`/api/admin/invites/${id}`, { method: 'DELETE' })
          }
        } catch (cause) {
          failed.add(id)
          if (!firstFailure) firstFailure = errorMessage(cause, '请求失败')
        }
      }
      await load()
      if (target === 'users') setSelectedUsers(failed)
      else setSelectedInvites(failed)
      if (firstFailure) toast.notifyError(`${failed.size} 项未完成：${firstFailure}`)
      else toast.notify(target === 'invites' ? '邀请已撤销' : '用户状态已更新')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '批量操作失败'))
    } finally {
      setMutating(false)
      setBatchProgress('')
    }
  }

  const userActions: BatchAction[] = [
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => executeBatch('users', 'enable') },
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => setBatchConfirm({ target: 'users', action: 'disable' }) },
  ]
  const inviteActions: BatchAction[] = [
    { key: 'revoke', label: '撤销', icon: Trash2, tone: 'danger', onClick: () => setBatchConfirm({ target: 'invites', action: 'revoke' }) },
  ]

  const userColumns: Array<DataTableColumn<UserSummary>> = [
    {
      key: 'select',
      header: '选择',
      width: 52,
      render: (user) => (
        <input
          type="checkbox"
          aria-label={`选择用户 ${user.username}`}
          checked={user.role === 'user' && selectedUsers.has(user.id)}
          disabled={user.role === 'admin' || mutating}
          onChange={() => setSelectedUsers((current) => toggleId(current, user.id))}
        />
      ),
    },
    { key: 'id', header: '用户 ID', render: (user) => <span className="usr-id">{user.id}</span> },
    { key: 'username', header: '用户名', render: (user) => <strong className="usr-name">{user.username}</strong> },
    { key: 'email', header: '邮箱', render: (user) => <span className="usr-email">{user.email ?? '—'}</span> },
    { key: 'role', header: '角色', render: (user) => user.role === 'admin' ? '管理员' : '用户' },
    {
      key: 'status',
      header: '状态',
      render: (user) => <StatusBadge tone={user.enabled ? 'success' : 'muted'} size="sm">{user.enabled ? '正常' : '已停用'}</StatusBadge>,
    },
    { key: 'createdAt', header: '创建时间', render: (user) => <span className="usr-time">{formatDate(user.createdAt)}</span> },
    {
      key: 'subscriptions',
      header: '订阅',
      render: (user) => {
        if (!subscriptionsReady) return <span className="exp-user-none">—</span>
        const owned = subscriptionsByUser.get(user.id) ?? []
        if (owned.length === 0) return <span className="exp-user-none">—</span>
        return <UserSubscriptionList items={owned} />
      },
    },
    {
      key: 'actions',
      header: '管理',
      align: 'right',
      render: (user) => (
        <span className="row-actions">
          {user.role === 'user' ? (
            <>
              <button className="icon-button" type="button" disabled={mutating} aria-label={`重置 ${user.username} 的密码`} title="重置密码" onClick={() => openPasswordReset(user)}>
                <KeyRound aria-hidden="true" size={16} />
              </button>
              <button className="icon-button" type="button" disabled={mutating} aria-label={`将 ${user.username} 设为管理员`} title="设为管理员" onClick={() => setConfirmAction({ kind: 'promote', user })}>
                <Crown aria-hidden="true" size={16} />
              </button>
              <button className="icon-button danger" type="button" disabled={mutating} aria-label={`删除 ${user.username}`} title="移入回收站" onClick={() => setConfirmAction({ kind: 'soft-delete', user })}>
                <Trash2 aria-hidden="true" size={16} />
              </button>
            </>
          ) : null}
          <input
            type="checkbox"
            checked={user.enabled}
            disabled={user.role === 'admin' || mutating}
            aria-label={`启用 ${user.username}`}
            onChange={(event) => setEnabled(user, event.currentTarget.checked)}
          />
        </span>
      ),
    },
  ]

  const trashColumns: Array<DataTableColumn<UserSummary>> = [
    { key: 'id', header: '用户 ID', render: (user) => <span className="usr-id">{user.id}</span> },
    { key: 'username', header: '用户名', render: (user) => <strong className="usr-name">{user.username}</strong> },
    { key: 'email', header: '邮箱', render: (user) => <span className="usr-email">{user.email ?? '—'}</span> },
    { key: 'role', header: '角色', render: (user) => user.role === 'admin' ? '管理员' : '用户' },
    {
      key: 'status',
      header: '状态',
      render: () => <StatusBadge tone="danger" size="sm">已删除</StatusBadge>,
    },
    { key: 'deletedAt', header: '删除时间', render: (user) => <span className="usr-time">{formatDate(user.deletedAt ?? undefined)}</span> },
    {
      key: 'subscriptions',
      header: '订阅',
      render: (user) => <span>{user.subscriptionCount ?? 0} 个</span>,
    },
    {
      key: 'actions',
      header: '管理',
      align: 'right',
      render: (user) => (
        <span className="row-actions">
          <button className="icon-button" type="button" disabled={mutating} aria-label={`恢复 ${user.username}`} title="恢复" onClick={() => restoreUser(user)}>
            <RotateCcw aria-hidden="true" size={16} />
          </button>
          <button className="icon-button danger" type="button" disabled={mutating} aria-label={`永久删除 ${user.username}`} title="永久删除" onClick={() => setConfirmAction({ kind: 'purge', user })}>
            <Trash2 aria-hidden="true" size={16} />
          </button>
        </span>
      ),
    },
  ]

  const inviteColumns: Array<DataTableColumn<InviteSummary>> = [
    {
      key: 'select',
      header: '选择',
      width: 52,
      render: (invite) => (
        <input
          type="checkbox"
          aria-label={`选择邀请 ${invite.username}`}
          checked={selectedInvites.has(invite.id)}
          disabled={mutating}
          onChange={() => setSelectedInvites((current) => toggleId(current, invite.id))}
        />
      ),
    },
    { key: 'username', header: '用户名', render: (invite) => <strong className="usr-name">{invite.username}</strong> },
    { key: 'expiresAt', header: '到期时间', render: (invite) => <span className="usr-time">{formatDate(invite.expiresAt)}</span> },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (invite) => (
        <button className="icon-button danger" type="button" disabled={mutating} aria-label={`撤销 ${invite.username} 的邀请`} title="撤销邀请" onClick={() => revokeInvite(invite.id)}>
          <Trash2 aria-hidden="true" size={17} />
        </button>
      ),
    },
  ]

  const usersAllSelected = selectableUsers.length > 0 && selectableUsers.every((user) => selectedUsers.has(user.id))
  const invitesAllSelected = invites.length > 0 && selectedInvites.size === invites.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const confirmCopy = confirmAction
    ? {
        promote: {
          title: '设为管理员',
          description: `管理员只能有一位。将把管理员身份转给 ${confirmAction.user.username}，当前管理员降为普通用户，双方现有会话都会退出`,
          confirmLabel: '确认转移',
        },
        'soft-delete': {
          title: '移入回收站',
          description: `删除后 ${confirmAction.user.username} 将立即无法登录，其订阅也会停止下发；数据保留在回收站，可随时恢复`,
          confirmLabel: '移入回收站',
        },
        purge: {
          title: '永久删除',
          description: `将永久删除 ${confirmAction.user.username} 及其全部订阅、分享与邀请消费记录，用户名与邮箱随即释放，此操作不可恢复`,
          confirmLabel: '永久删除',
        },
      }[confirmAction.kind]
    : null

  return (
    <div className="page-stack usr-page">
      <PageHeader
        title="用户与邀请"
        description={`${total} 个用户 · ${invites.length} 个有效邀请`}
        actions={<button className="button primary" type="submit" form="invite-form" disabled={mutating}><Plus aria-hidden="true" size={17} />创建邀请</button>}
      />

      {newLink ? (
        <section className="link-strip usr-link-strip" aria-label="新邀请链接">
          <div><strong>邀请链接</strong><span>24 小时内有效</span></div>
          <input aria-label="邀请链接" value={newLink} readOnly />
          <button className="icon-button" type="button" aria-label="复制邀请链接" title="复制邀请链接" onClick={copyLink}>
            <Copy aria-hidden="true" size={17} />
          </button>
        </section>
      ) : null}

      {loading ? <div className="usr-state"><LoadingState label="正在加载用户与邀请" /></div> : null}
      {!loading && loadError ? <ErrorState message={loadError} onRetry={retry} /> : null}

      {!loading && !loadError ? (
        <>
          <section className="data-section usr-section" aria-labelledby="users-title">
            <DataHeader
              id="users-title"
              title={view === 'trash' ? '回收站' : '用户'}
              filters={(
                <form id="invite-form" className="invite-form usr-invite-form" onSubmit={createInvite}>
                  <FormField label="邀请用户名" htmlFor="invite-username">
                    <input id="invite-username" name="username" placeholder="输入用户名" minLength={3} maxLength={32} required />
                  </FormField>
                </form>
              )}
              actions={view === 'active'
                ? <BatchToolbar selectedCount={selectedUsers.size} totalCount={selectableUsers.length} onSelectAll={() => setSelectedUsers(new Set(selectableUsers.map((user) => user.id)))} onClear={() => setSelectedUsers(new Set())} actions={userActions} busy={mutating} progress={batchProgress} />
                : undefined}
            />
            {subscriptionNote ? <StatusMessage tone="warning">{subscriptionNote}</StatusMessage> : null}
            <FilterBar className="usr-filters">
              <div className="usr-chips" role="group" aria-label="用户视图">
                <FilterChip active={view === 'active'} onClick={() => switchView('active')}>用户</FilterChip>
                <FilterChip active={view === 'trash'} onClick={() => switchView('trash')}>回收站</FilterChip>
              </div>
              <SearchInput className="usr-search" label="搜索用户" placeholder="搜索用户名或邮箱" value={query} onChange={changeQuery} />
              <div className="usr-chips" role="group" aria-label="用户状态">
                {STATUS_FILTERS.map((item) => (
                  <FilterChip key={item.value} active={statusFilter === item.value} onClick={() => changeStatusFilter(item.value)}>{item.label}</FilterChip>
                ))}
              </div>
            </FilterBar>
            {total === 0 ? (
              <div className="usr-empty"><EmptyState icon={Users} title={view === 'trash' ? '回收站是空的' : '暂无用户'} description={view === 'trash' ? '移入回收站的用户会显示在这里' : '创建邀请并完成注册后，用户会显示在这里'} /></div>
            ) : (
              <>
                {view === 'active' ? (
                  <div className="usr-tools">
                    <label className="usr-select-all">
                      <input
                        type="checkbox"
                        aria-label="选择全部用户"
                        checked={usersAllSelected}
                        disabled={mutating}
                        onChange={(event) => setSelectedUsers(event.currentTarget.checked ? new Set(selectableUsers.map((user) => user.id)) : new Set())}
                      />
                      <span>全选</span>
                    </label>
                  </div>
                ) : null}
                <DataTable
                  className="usr-table"
                  columns={view === 'trash' ? trashColumns : userColumns}
                  rows={users}
                  rowKey={(user) => user.id}
                  empty="暂无匹配用户"
                />
                {pageCount > 1 ? <Pagination page={page} pageCount={pageCount} onPageChange={setPage} /> : null}
              </>
            )}
          </section>

          <section className="data-section usr-section" aria-labelledby="invites-title">
            <DataHeader
              id="invites-title"
              title="有效邀请"
              actions={<BatchToolbar selectedCount={selectedInvites.size} totalCount={invites.length} onSelectAll={() => setSelectedInvites(new Set(invites.map((invite) => invite.id)))} onClear={() => setSelectedInvites(new Set())} actions={inviteActions} busy={mutating} progress={batchProgress} />}
            />
            {invites.length === 0 ? (
              <div className="usr-empty"><EmptyState icon={Mail} title="暂无有效邀请" /></div>
            ) : (
              <>
                <div className="usr-tools">
                  <label className="usr-select-all">
                    <input
                      type="checkbox"
                      aria-label="选择全部邀请"
                      checked={invitesAllSelected}
                      disabled={mutating}
                      onChange={(event) => setSelectedInvites(event.currentTarget.checked ? new Set(invites.map((invite) => invite.id)) : new Set())}
                    />
                    <span>全选</span>
                  </label>
                </div>
                <DataTable className="usr-table" columns={inviteColumns} rows={invites} rowKey={(invite) => invite.id} empty="暂无有效邀请" />
              </>
            )}
          </section>
        </>
      ) : null}

      <Dialog
        open={resetUser !== null}
        onClose={closePasswordReset}
        title="重置用户密码"
        footer={tempPassword
          ? (
              <button className="button primary" type="button" onClick={closePasswordReset} disabled={mutating}>完成</button>
            )
          : (
              <>
                <button className="button secondary" type="button" onClick={closePasswordReset} disabled={mutating}>取消</button>
                <button className="button primary" type="submit" form="reset-password-form" disabled={mutating}><KeyRound aria-hidden="true" size={17} />确认重置</button>
              </>
            )}
      >
        {tempPassword ? (
          <div className="form-stack usr-reset-form">
            <p className="usr-reset-user">{resetUser?.username}</p>
            <StatusMessage tone="success">密码已重置，旧会话已退出。临时密码只显示这一次，请复制后交给用户</StatusMessage>
            <div className="link-strip usr-link-strip">
              <input aria-label="临时密码" value={tempPassword} readOnly />
              <button className="icon-button" type="button" aria-label="复制临时密码" title="复制临时密码" onClick={copyTempPassword}>
                <Copy aria-hidden="true" size={17} />
              </button>
            </div>
          </div>
        ) : (
          <form id="reset-password-form" className="form-stack usr-reset-form" onSubmit={resetPassword}>
            {resetUser ? <p className="usr-reset-user">{resetUser.username}</p> : null}
            <FormField label="新密码" htmlFor="reset-new-password">
              <input id="reset-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={mutating} required />
            </FormField>
            <FormField label="确认新密码" htmlFor="reset-confirm-password">
              <input id="reset-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={mutating} required />
            </FormField>
            {resetError ? <StatusMessage tone="error">{resetError}</StatusMessage> : null}
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={confirmCopy !== null}
        title={confirmCopy?.title ?? ''}
        description={confirmCopy?.description ?? ''}
        confirmLabel={confirmCopy?.confirmLabel ?? ''}
        danger={confirmAction?.kind !== 'promote'}
        busy={mutating}
        onClose={() => setConfirmAction(null)}
        onConfirm={executeConfirmAction}
      />

      <ConfirmDialog
        open={batchConfirm !== null}
        title={batchConfirm?.target === 'invites' ? '撤销邀请' : '停用用户'}
        description={batchConfirm?.target === 'invites' ? `将撤销选中的 ${selectedInvites.size} 个邀请` : `将停用选中的 ${selectedUsers.size} 个用户，现有会话会被撤销`}
        confirmLabel={batchConfirm?.target === 'invites' ? '确认撤销' : '确认停用'}
        danger
        busy={mutating}
        onClose={() => setBatchConfirm(null)}
        onConfirm={() => executeBatch(batchConfirm?.target ?? 'invites', batchConfirm?.action ?? 'revoke')}
      />
    </div>
  )
}
