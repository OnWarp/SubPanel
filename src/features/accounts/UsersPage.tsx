import { Checkbox, FormSelect, Input } from '../../ui/Controls'
import { UserSubscriptionPlan } from '../delivery/UserSubscriptionPlan'
import { CheckCircle2, ChevronLeft, ChevronRight, Copy, Ellipsis, KeyRound, Trash2, Users, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody, type AdminUsersResponse, type UserSummary } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { SearchInput } from '../../ui/SearchInput'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'

type BatchKind = 'enable' | 'disable' | 'delete'
type StatusFilter = 'all' | 'enabled' | 'disabled'
type UsersView = 'active' | 'trash'
type ConfirmKind = 'promote' | 'soft-delete' | 'purge'
type DirectoryPhase = 'loading' | 'error' | 'ready'
type RowAction = 'edit-email' | 'reset-password' | 'promote' | 'enable' | 'disable' | 'subscription-plan' | 'soft-delete' | 'restore' | 'purge'
type MenuItem = { key: RowAction; label: string; danger?: boolean; disabled?: boolean; title?: string }

const PAGE_SIZE = 20

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function formatDate(value?: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN')
}

function userSecondary(user: UserSummary) {
  const email = user.email?.trim()
  return email ? email : user.id
}

function toggleId(current: Set<string>, id: string) {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function menuItems(user: UserSummary, view: UsersView): MenuItem[] {
  if (view === 'trash') {
    return [
      { key: 'restore', label: '恢复' },
      { key: 'purge', label: '永久删除', danger: true },
    ]
  }
  const items: MenuItem[] = [{ key: 'edit-email', label: '改邮箱' }]
  if (user.role === 'user') {
    items.push(
      { key: 'reset-password', label: '重置密码' },
      { key: 'promote', label: '设为管理员' },
    )
  }
  items.push(user.enabled
    ? { key: 'disable', label: '停用', danger: true, disabled: user.role === 'admin', title: user.role === 'admin' ? '管理员不能在这里启用或停用' : undefined }
    : { key: 'enable', label: '启用', disabled: user.role === 'admin', title: user.role === 'admin' ? '管理员不能在这里启用或停用' : undefined })
  items.push(
    { key: 'subscription-plan', label: '管理订阅计划' },
    { key: 'soft-delete', label: '移入回收站', danger: true },
  )
  return items
}

function RowMenu({ label, disabled, items, onSelect }: { label: string; disabled?: boolean; items: MenuItem[]; onSelect: (key: RowAction) => void }) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== 'Escape') return
    event.currentTarget.open = false
    event.currentTarget.querySelector('summary')?.focus()
  }
  const choose = (event: ReactMouseEvent<HTMLButtonElement>, key: RowAction) => {
    const menu = event.currentTarget.closest('details')
    if (menu) menu.open = false
    onSelect(key)
  }
  return (
    <details className="usr-menu" onKeyDown={onKeyDown} onToggle={(event) => { if (disabled) event.currentTarget.open = false }}>
      <summary className="icon-button" aria-label={label} aria-haspopup="menu" aria-disabled={disabled || undefined} title="操作" onClick={(event) => { if (disabled) event.preventDefault() }}>
        <Ellipsis aria-hidden="true" size={16} />
      </summary>
      <div className="usr-menu-panel" role="menu">
        {items.map((item) => (
          <button key={item.key} type="button" role="menuitem" className={item.danger ? 'danger' : undefined} disabled={disabled || item.disabled} title={item.title} onClick={(event) => choose(event, item.key)}>
            {item.label}
          </button>
        ))}
      </div>
    </details>
  )
}

export function UsersDirectory({
  phase,
  loadError,
  onRetry,
  view,
  users,
  total,
  page,
  pageCount,
  statusFilter,
  query,
  selectedIds,
  mutating,
  onStatusFilter,
  onQuery,
  onPage,
  onToggle,
  onToggleAll,
  onRowAction,
  onBatch,
  batchProgress,
}: {
  phase: DirectoryPhase
  loadError: string
  onRetry: () => void
  view: UsersView
  users: UserSummary[]
  total: number
  page: number
  pageCount: number
  statusFilter: StatusFilter
  query: string
  selectedIds: ReadonlySet<string>
  mutating: boolean
  onStatusFilter: (value: string) => void
  onQuery: (value: string) => void
  onPage: (page: number) => void
  onToggle: (id: string) => void
  onToggleAll: (checked: boolean) => void
  onRowAction: (action: RowAction, user: UserSummary) => void
  onBatch: (action: BatchKind) => void
  batchProgress?: string
}) {
  const allSelected = users.length > 0 && users.every((user) => selectedIds.has(user.id))
  const batchActions: BatchAction[] = [
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => onBatch('disable') },
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => onBatch('enable') },
    { key: 'delete', label: '移入回收站', icon: Trash2, tone: 'danger', onClick: () => onBatch('delete') },
  ]
  const columns: Array<DataTableColumn<UserSummary>> = [
    ...(view === 'active' ? [{
      key: 'select',
      header: (
        <Checkbox
          type="checkbox"
          aria-label="选择全部用户"
          checked={allSelected}
          disabled={mutating || users.length === 0}
          onChange={(event) => onToggleAll(event.currentTarget.checked)}
        />
      ),
      label: '选择',
      width: 52,
      render: (user: UserSummary) => (
        <Checkbox
          type="checkbox"
          aria-label={`选择用户 ${user.username}`}
          checked={selectedIds.has(user.id)}
          disabled={mutating}
          onChange={() => onToggle(user.id)}
        />
      ),
    } satisfies DataTableColumn<UserSummary>] : []),
    {
      key: 'user',
      header: '用户',
      render: (user) => (
        <div className="usr-person">
          <strong className="usr-name">{user.username}</strong>
          <span className="usr-meta">{userSecondary(user)}</span>
        </div>
      ),
    },
    { key: 'role', header: '角色', render: (user) => user.role === 'admin' ? '管理员' : '用户' },
    {
      key: 'status',
      header: '状态',
      render: (user) => {
        const tone = view === 'trash' ? 'danger' : user.enabled ? 'success' : 'muted'
        const label = view === 'trash' ? '已删除' : user.enabled ? '正常' : '已停用'
        return <span className={`usr-status usr-status-${tone}`}><i aria-hidden="true" />{label}</span>
      },
    },
    { key: 'subscriptions', header: '订阅', render: (user) => <span>{user.subscriptionCount ?? 0} 个</span> },
    ...(view === 'trash' ? [{
      key: 'deletedAt',
      header: '删除时间',
      render: (user: UserSummary) => <span>{formatDate(user.deletedAt ?? undefined)}</span>,
    } satisfies DataTableColumn<UserSummary>] : []),
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (user) => (
        <RowMenu
          label={`${user.username} 的操作`}
          disabled={mutating}
          items={menuItems(user, view)}
          onSelect={(action) => onRowAction(action, user)}
        />
      ),
    },
  ]

  return (
    <div className="usr-directory">
      <div className="usr-filter">
        <FormSelect aria-label="用户状态" value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}>
          <option value="all">全部状态</option>
          <option value="enabled">正常</option>
          <option value="disabled">已停用</option>
        </FormSelect>
        <SearchInput label="搜索用户" placeholder="搜索用户名或邮箱" value={query} onChange={onQuery} />
      </div>
      {phase === 'loading' ? <LoadingState label="正在加载用户" /> : null}
      {phase === 'error' ? <ErrorState message={loadError} onRetry={onRetry} /> : null}
      {phase === 'ready' ? (
        <>
          {view === 'active' && selectedIds.size > 0 ? (
            <div className="usr-batch">
              <BatchToolbar
                selectedCount={selectedIds.size}
                totalCount={users.length}
                onSelectAll={() => onToggleAll(true)}
                onClear={() => onToggleAll(false)}
                actions={batchActions}
                busy={mutating}
                progress={batchProgress}
              />
            </div>
          ) : null}
          {view === 'active' && users.length > 0 ? (
            <div className="usr-select-all-narrow">
              <Checkbox
                type="checkbox"
                aria-label="选择全部用户"
                checked={allSelected}
                disabled={mutating}
                onChange={(event) => onToggleAll(event.currentTarget.checked)}
              />
              <span>全选</span>
            </div>
          ) : null}
          {total === 0 ? (
            <EmptyState icon={Users} title={view === 'trash' ? '回收站是空的' : '暂无用户'} description={view === 'trash' ? '移入回收站的用户会显示在这里' : '创建邀请并完成注册后，用户会显示在这里'} />
          ) : (
            <DataTable className="usr-table" columns={columns} rows={users} rowKey={(user) => user.id} empty="暂无匹配用户" />
          )}
          <footer className="section-footer">
            <span>共 {total} 位用户</span>
            <div className="usr-pager">
              <button type="button" className="icon-button" aria-label="上一页" disabled={page <= 1 || mutating} onClick={() => onPage(page - 1)}>
                <ChevronLeft aria-hidden="true" size={16} />
              </button>
              <span>{page} / {pageCount} 页</span>
              <button type="button" className="icon-button" aria-label="下一页" disabled={page >= pageCount || mutating} onClick={() => onPage(page + 1)}>
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            </div>
          </footer>
        </>
      ) : null}
    </div>
  )
}

export function UsersPage({ view = 'active' }: { view?: UsersView }) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const params = new URLSearchParams({
    deleted: view === 'trash' ? 'only' : 'active',
    page: String(page),
    pageSize: String(PAGE_SIZE),
  })
  const needle = query.trim()
  if (needle) params.set('q', needle)
  if (statusFilter !== 'all') params.set('status', statusFilter)
  const usersPath = `/api/admin/users?${params.toString()}`
  const [users, setUsers] = useState<UserSummary[]>(() => peekApi<AdminUsersResponse>(usersPath)?.users ?? [])
  const [total, setTotal] = useState(() => peekApi<AdminUsersResponse>(usersPath)?.total ?? 0)
  const [loading, setLoading] = useState(() => peekApi(usersPath) === undefined)
  const [loadError, setLoadError] = useState('')
  const [editUser, setEditUser] = useState<UserSummary | null>(null)
  const [editEmail, setEditEmail] = useState('')
  const [editError, setEditError] = useState('')
  const [resetUser, setResetUser] = useState<UserSummary | null>(null)
  const [resetError, setResetError] = useState('')
  const [tempPassword, setTempPassword] = useState('')
  const [mutating, setMutating] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<Exclude<BatchKind, 'enable'> | null>(null)
  const [batchProgress, setBatchProgress] = useState('')
  const [confirmAction, setConfirmAction] = useState<{ kind: ConfirmKind; user: UserSummary } | null>(null)
  const [subscriptionPlanUser, setSubscriptionPlanUser] = useState<UserSummary | null>(null)
  const toast = useToast()
  const usersRequestSeq = useRef(0)

  const loadUsers = useCallback(async () => {
    const seq = ++usersRequestSeq.current
    await watchApi<AdminUsersResponse>(usersPath, (result) => {
      if (seq !== usersRequestSeq.current) return
      setUsers(result.users)
      setTotal(result.total)
      setLoadError('')
      setSelectedUsers((current) => {
        const retained = [...current].filter((id) => result.users.some((user) => user.id === id))
        return retained.length === current.size ? current : new Set(retained)
      })
    })
  }, [usersPath])

  const load = useCallback(async () => {
    await loadUsers()
    setLoadError('')
  }, [loadUsers])

  useEffect(() => {
    setLoading(peekApi(usersPath) === undefined)
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

  useEffect(() => {
    const visible = new Set(users.map((user) => user.id))
    setSelectedUsers((current) => {
      const next = [...current].filter((id) => visible.has(id))
      return next.length === current.size ? current : new Set(next)
    })
  }, [users])

  useEffect(() => {
    const nextCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
    if (page > nextCount) setPage(nextCount)
  }, [page, total])

  const retry = () => {
    setLoading(peekApi(usersPath) === undefined)
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

  const changeQuery = (value: string) => {
    setQuery(value)
    setPage(1)
  }

  const changeStatusFilter = (value: string) => {
    if (value !== 'all' && value !== 'enabled' && value !== 'disabled') return
    setStatusFilter(value)
    setPage(1)
  }

  const copyTempPassword = async () => {
    try {
      await copyToClipboard(tempPassword)
      toast.notify('临时密码已复制')
    } catch {
      toast.notifyError('浏览器未允许复制，请手动选择密码')
    }
  }

  const saveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editUser || mutating) return
    setMutating(true)
    setEditError('')
    try {
      await api(`/api/admin/users/${editUser.id}`, {
        method: 'PATCH', body: jsonBody({ email: editEmail }),
      })
      await loadUsers()
      setEditUser(null)
      toast.notify('邮箱已更新')
    } catch (cause) {
      setEditError(errorMessage(cause, '更新用户失败'))
    } finally {
      setMutating(false)
    }
  }

  const setEnabled = async (user: UserSummary, enabled: boolean) => {
    if (mutating || user.role === 'admin') return
    setMutating(true)
    setUsers((current) => current.map((candidate) => candidate.id === user.id ? { ...candidate, enabled } : candidate))
    try {
      const result = await api<{ user: UserSummary }>(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: jsonBody({ enabled }),
      })
      setUsers((current) => current.map((candidate) => candidate.id === user.id ? { ...candidate, ...result.user, subscriptionCount: candidate.subscriptionCount } : candidate))
    } catch (cause) {
      setUsers((current) => current.map((candidate) => candidate.id === user.id ? { ...candidate, enabled: user.enabled } : candidate))
      toast.notifyError(errorMessage(cause, '更新用户失败'))
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
      setUsers((current) => current.map((candidate) => candidate.id === resetUser.id ? { ...candidate, ...result.user, subscriptionCount: candidate.subscriptionCount } : candidate))
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
        toast.notify(`${user.username} 已设为管理员，其现有会话已退出`)
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

  const executeBatch = async (action: BatchKind) => {
    if (mutating) return
    const selectedRecords = users.filter((user) => selectedUsers.has(user.id))
    const targets = action === 'delete' ? selectedRecords : selectedRecords.filter((user) => user.role === 'user')
    if (!targets.length) {
      setBatchConfirm(null)
      toast.notifyError(action === 'delete' ? '请先选择用户' : '所选用户里没有可以启用或停用的普通用户')
      return
    }
    setBatchConfirm(null)
    setMutating(true)
    let firstFailure = ''
    const skipped = selectedRecords.filter((user) => !targets.some((target) => target.id === user.id)).map((user) => user.id)
    const failed = new Set<string>(skipped)
    try {
      for (const [index, user] of targets.entries()) {
        setBatchProgress(`正在处理 ${index + 1}/${targets.length}`)
        try {
          if (action === 'delete') await api(`/api/admin/users/${user.id}`, { method: 'DELETE' })
          else await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: jsonBody({ enabled: action === 'enable' }) })
        } catch (cause) {
          failed.add(user.id)
          if (!firstFailure) firstFailure = errorMessage(cause, '请求失败')
        }
      }
      await load()
      setSelectedUsers(failed)
      const requestFailures = failed.size - skipped.length
      if (firstFailure) toast.notifyError(`${requestFailures} 项未完成：${firstFailure}`)
      else if (action === 'delete') toast.notify('已移入回收站')
      else if (skipped.length) toast.notify('普通用户状态已更新，管理员状态未改')
      else toast.notify('用户状态已更新')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '批量操作失败'))
    } finally {
      setMutating(false)
      setBatchProgress('')
    }
  }

  const onRowAction = (action: RowAction, user: UserSummary) => {
    if (mutating) return
    if (action === 'edit-email') {
      setEditUser(user)
      setEditEmail(user.email ?? '')
      setEditError('')
    } else if (action === 'reset-password') openPasswordReset(user)
    else if (action === 'promote') setConfirmAction({ kind: 'promote', user })
    else if (action === 'enable') void setEnabled(user, true)
    else if (action === 'disable') void setEnabled(user, false)
    else if (action === 'subscription-plan') setSubscriptionPlanUser(user)
    else if (action === 'soft-delete') setConfirmAction({ kind: 'soft-delete', user })
    else if (action === 'restore') void restoreUser(user)
    else setConfirmAction({ kind: 'purge', user })
  }

  const requestBatch = (action: BatchKind) => {
    if (mutating || selectedUsers.size === 0) return
    if (action === 'enable') void executeBatch('enable')
    else setBatchConfirm(action)
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const confirmCopy = confirmAction
    ? {
        promote: {
          title: '设为管理员',
          description: `将 ${confirmAction.user.username} 设为管理员，对方现有会话会退出；已有管理员不受影响`,
          confirmLabel: '设为管理员',
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
  const batchCopy = batchConfirm === 'delete'
    ? {
        title: '移入回收站',
        description: `将把选中的 ${selectedUsers.size} 个用户移入回收站，他们将无法登录，订阅也会停止下发`,
        confirmLabel: '移入回收站',
      }
    : {
        title: '停用用户',
        description: `将停用选中的 ${selectedUsers.size} 个用户，现有会话会被撤销`,
        confirmLabel: '确认停用',
      }

  return (
    <>
      <UsersDirectory
        phase={loading ? 'loading' : loadError ? 'error' : 'ready'}
        loadError={loadError}
        onRetry={retry}
        view={view}
        users={users}
        total={total}
        page={page}
        pageCount={pageCount}
        statusFilter={statusFilter}
        query={query}
        selectedIds={selectedUsers}
        mutating={mutating}
        onStatusFilter={changeStatusFilter}
        onQuery={changeQuery}
        onPage={setPage}
        onToggle={(id) => setSelectedUsers((current) => toggleId(current, id))}
        onToggleAll={(checked) => setSelectedUsers(checked ? new Set(users.map((user) => user.id)) : new Set())}
        onRowAction={onRowAction}
        onBatch={requestBatch}
        batchProgress={batchProgress}
      />
      {subscriptionPlanUser ? (
        <UserSubscriptionPlan
          key={subscriptionPlanUser.id}
          userId={subscriptionPlanUser.id}
          username={subscriptionPlanUser.username}
          showSummary={false}
          active
          onSave={() => { void load() }}
          onActiveChange={(next) => { if (!next) setSubscriptionPlanUser(null) }}
        />
      ) : null}

      <Dialog
        open={editUser !== null}
        onClose={() => { if (!mutating) setEditUser(null) }}
        title="编辑用户"
        footer={<>
          <button className="button secondary" type="button" disabled={mutating} onClick={() => setEditUser(null)}>取消</button>
          <button className="button primary" type="submit" form="edit-user-form" disabled={mutating}>保存</button>
        </>}
      >
        <form id="edit-user-form" className="form-stack" onSubmit={saveUser}>
          <p>{editUser?.username}</p>
          <FormField label="邮箱" htmlFor="edit-user-email">
            <Input id="edit-user-email" name="email" type="email" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} disabled={mutating} required />
          </FormField>
          <StatusMessage tone="warning">保存后立即生效，无需验证码或确认邮件</StatusMessage>
          {editError ? <StatusMessage tone="error">{editError}</StatusMessage> : null}
        </form>
      </Dialog>

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
          <div className="form-stack">
            <p>{resetUser?.username}</p>
            <StatusMessage tone="success">密码已重置，旧会话已退出。临时密码只显示这一次，请复制后交给用户</StatusMessage>
            <div className="link-strip">
              <Input aria-label="临时密码" value={tempPassword} readOnly />
              <button className="icon-button" type="button" aria-label="复制临时密码" title="复制临时密码" onClick={copyTempPassword}>
                <Copy aria-hidden="true" size={17} />
              </button>
            </div>
          </div>
        ) : (
          <form id="reset-password-form" className="form-stack" onSubmit={resetPassword}>
            {resetUser ? <p>{resetUser.username}</p> : null}
            <FormField label="新密码" htmlFor="reset-new-password">
              <Input id="reset-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={mutating} required />
            </FormField>
            <FormField label="确认新密码" htmlFor="reset-confirm-password">
              <Input id="reset-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={mutating} required />
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
        title={batchCopy.title}
        description={batchCopy.description}
        confirmLabel={batchCopy.confirmLabel}
        danger
        busy={mutating}
        onClose={() => setBatchConfirm(null)}
        onConfirm={() => { if (batchConfirm) void executeBatch(batchConfirm) }}
      />
    </>
  )
}
