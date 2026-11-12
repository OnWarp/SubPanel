import { CheckCircle2, Copy, KeyRound, Mail, Plus, Trash2, Users, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type AdminSubscription, type UserSummary } from '../../app/api'
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
  const [invites, setInvites] = useState<InviteSummary[]>([])
  const [newLink, setNewLink] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [resetUser, setResetUser] = useState<UserSummary | null>(null)
  const [resetError, setResetError] = useState('')
  const [mutating, setMutating] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [selectedInvites, setSelectedInvites] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ target: BatchTarget; action: BatchActionKind } | null>(null)
  const [batchProgress, setBatchProgress] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [subscriptionsReady, setSubscriptionsReady] = useState(false)
  const [subscriptionNote, setSubscriptionNote] = useState('')
  const toast = useToast()

  const load = useCallback(async () => {
    const [userResult, inviteResult] = await Promise.all([
      api<{ users: UserSummary[] }>('/api/admin/users'),
      api<{ invites: InviteSummary[] }>('/api/admin/invites'),
    ])
    setUsers(userResult.users)
    setInvites(inviteResult.invites)
    setSelectedUsers((current) => new Set([...current].filter((id) => userResult.users.some((user) => user.id === id && user.role === 'user'))))
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
  }, [])

  useEffect(() => {
    setLoading(true)
    load()
      .catch((cause) => setLoadError(errorMessage(cause, '加载用户失败')))
      .finally(() => setLoading(false))
  }, [load])

  const filteredUsers = useMemo(() => users.filter((user) => {
    if (statusFilter === 'enabled' && !user.enabled) return false
    if (statusFilter === 'disabled' && user.enabled) return false
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    return user.username.toLowerCase().includes(needle) || user.id.toLowerCase().includes(needle)
  }), [query, statusFilter, users])

  const selectableUsers = useMemo(
    () => filteredUsers.filter((user) => user.role === 'user'),
    [filteredUsers],
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
  }

  const closePasswordReset = () => {
    if (mutating) return
    setResetUser(null)
    setResetError('')
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
      const result = await api<{ user: UserSummary }>(`/api/admin/users/${resetUser.id}/password`, {
        method: 'POST',
        body: jsonBody({ newPassword }),
      })
      setUsers((current) => current.map((candidate) => candidate.id === resetUser.id ? result.user : candidate))
      toast.notify(`${resetUser.username} 的密码已重置，旧会话已退出`)
      setResetError('')
      setResetUser(null)
      form.reset()
    } catch (cause) {
      setResetError(errorMessage(cause, '重置密码失败'))
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
            <button className="icon-button" type="button" disabled={mutating} aria-label={`重置 ${user.username} 的密码`} title="重置密码" onClick={() => openPasswordReset(user)}>
              <KeyRound aria-hidden="true" size={16} />
            </button>
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

  return (
    <div className="page-stack usr-page">
      <PageHeader
        title="用户与邀请"
        description={`${users.length} 个用户 · ${invites.length} 个有效邀请`}
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
              title="用户"
              filters={(
                <form id="invite-form" className="invite-form usr-invite-form" onSubmit={createInvite}>
                  <FormField label="邀请用户名" htmlFor="invite-username">
                    <input id="invite-username" name="username" placeholder="输入用户名" minLength={3} maxLength={32} required />
                  </FormField>
                </form>
              )}
              actions={<BatchToolbar selectedCount={selectedUsers.size} totalCount={selectableUsers.length} onSelectAll={() => setSelectedUsers(new Set(selectableUsers.map((user) => user.id)))} onClear={() => setSelectedUsers(new Set())} actions={userActions} busy={mutating} progress={batchProgress} />}
            />
            {subscriptionNote ? <StatusMessage tone="warning">{subscriptionNote}</StatusMessage> : null}
            {users.length === 0 ? (
              <div className="usr-empty"><EmptyState icon={Users} title="暂无用户" description="创建邀请并完成注册后，用户会显示在这里" /></div>
            ) : (
              <>
                <FilterBar className="usr-filters">
                  <SearchInput className="usr-search" label="搜索用户" placeholder="搜索用户名或 ID" value={query} onChange={setQuery} />
                  <div className="usr-chips" role="group" aria-label="用户状态">
                    {STATUS_FILTERS.map((item) => (
                      <FilterChip key={item.value} active={statusFilter === item.value} onClick={() => setStatusFilter(item.value)}>{item.label}</FilterChip>
                    ))}
                  </div>
                </FilterBar>
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
                <DataTable className="usr-table" columns={userColumns} rows={filteredUsers} rowKey={(user) => user.id} empty="暂无匹配用户" />
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
        footer={(
          <>
            <button className="button secondary" type="button" onClick={closePasswordReset} disabled={mutating}>取消</button>
            <button className="button primary" type="submit" form="reset-password-form" disabled={mutating}><KeyRound aria-hidden="true" size={17} />确认重置</button>
          </>
        )}
      >
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
      </Dialog>

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
