import { CheckCircle2, Copy, KeyRound, Plus, Trash2, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type UserSummary } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataHeader } from '../../ui/DataHeader'
import { PageHeader } from '../../ui/PageHeader'
import { ConfirmDialog } from '../../ui/ConfirmDialog'

type InviteSummary = {
  id: string
  username: string
  createdAt: string
  expiresAt: string
}

type BatchTarget = 'users' | 'invites'
type BatchActionKind = 'disable' | 'revoke'

export function UsersPage() {
  const [users, setUsers] = useState<UserSummary[]>([])
  const [invites, setInvites] = useState<InviteSummary[]>([])
  const [newLink, setNewLink] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [resetUser, setResetUser] = useState<UserSummary | null>(null)
  const [resetError, setResetError] = useState('')
  const [mutating, setMutating] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [selectedInvites, setSelectedInvites] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ target: BatchTarget; action: BatchActionKind } | null>(null)
  const [batchProgress, setBatchProgress] = useState('')
  const resetDialog = useRef<HTMLDialogElement>(null)

  const load = useCallback(async () => {
    const [userResult, inviteResult] = await Promise.all([
      api<{ users: UserSummary[] }>('/api/admin/users'),
      api<{ invites: InviteSummary[] }>('/api/admin/invites'),
    ])
    setUsers(userResult.users)
    setInvites(inviteResult.invites)
    setSelectedUsers((current) => new Set([...current].filter((id) => userResult.users.some((user) => user.id === id && user.role === 'user'))))
    setSelectedInvites((current) => new Set([...current].filter((id) => inviteResult.invites.some((invite) => invite.id === id))))
  }, [])

  useEffect(() => {
    load().catch((cause) => setError(cause instanceof ApiClientError ? cause.message : '加载用户失败'))
  }, [load])

  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mutating) return
    setError('')
    setMessage('')
    const form = event.currentTarget
    const data = new FormData(form)
    setMutating(true)
    try {
      const result = await api<{ invite: InviteSummary & { link: string } }>('/api/admin/invites', {
        method: 'POST',
        body: jsonBody({ username: data.get('username') }),
      })
      setNewLink(result.invite.link)
      setMessage('邀请已创建。链接只在本次显示。')
      form.reset()
      await load()
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '创建邀请失败')
    } finally {
      setMutating(false)
    }
  }

  const copyLink = async () => {
    try {
      await copyToClipboard(newLink)
      setMessage('邀请链接已复制。')
      setError('')
    } catch {
      setMessage('')
      setError('浏览器未允许复制，请手动选择链接。')
    }
  }

  const setEnabled = async (user: UserSummary, enabled: boolean) => {
    if (mutating) return
    setError('')
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
      setError(cause instanceof ApiClientError ? cause.message : '更新用户失败')
    } finally {
      setMutating(false)
    }
  }

  const revokeInvite = async (id: string) => {
    if (mutating) return
    setError('')
    setMutating(true)
    try {
      await api(`/api/admin/invites/${id}`, { method: 'DELETE' })
      setInvites((current) => current.filter((invite) => invite.id !== id))
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '撤销邀请失败')
    } finally {
      setMutating(false)
    }
  }

  const openPasswordReset = (user: UserSummary) => {
    setResetUser(user)
    setResetError('')
    resetDialog.current?.showModal()
  }

  const closePasswordReset = () => {
    if (!mutating) resetDialog.current?.close()
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
      setMessage(`${resetUser.username} 的密码已重置，旧会话已退出。`)
      resetDialog.current?.close()
      form.reset()
    } catch (cause) {
      setResetError(cause instanceof ApiClientError ? cause.message : '重置密码失败')
    } finally {
      setMutating(false)
    }
  }

  const executeBatch = async (target: BatchTarget, action: BatchActionKind | 'enable') => {
    const ids = [...(target === 'users' ? selectedUsers : selectedInvites)]
    if (!ids.length || mutating) return
    setBatchConfirm(null)
    setMutating(true)
    setError('')
    setMessage('')
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
          if (!firstFailure) firstFailure = cause instanceof ApiClientError ? cause.message : '请求失败'
        }
      }
      await load()
      if (target === 'users') setSelectedUsers(failed)
      else setSelectedInvites(failed)
      if (firstFailure) setError(`${failed.size} 项未完成：${firstFailure}`)
      else setMessage(target === 'invites' ? '邀请已撤销' : '用户状态已更新')
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '批量操作失败')
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

  return (
    <div className="page-stack">
      <PageHeader title="用户与邀请" description={`${users.length} 个用户 · ${invites.length} 个有效邀请`} actions={<button className="button primary" type="submit" form="invite-form" disabled={mutating}><Plus aria-hidden="true" size={17} />创建邀请</button>} />

      {newLink ? (
        <section className="link-strip" aria-label="新邀请链接">
          <div><strong>邀请链接</strong><span>24 小时内有效</span></div>
          <input aria-label="邀请链接" value={newLink} readOnly />
          <button className="icon-button" type="button" aria-label="复制邀请链接" title="复制邀请链接" onClick={copyLink}>
            <Copy aria-hidden="true" size={17} />
          </button>
        </section>
      ) : null}
      {error ? <p className="form-message error" role="alert">{error}</p> : null}
      {message ? <p className="form-message success" role="status">{message}</p> : null}

      <section className="data-section" aria-labelledby="users-title">
        <DataHeader id="users-title" title="用户" filters={<form id="invite-form" className="invite-form" onSubmit={createInvite}><label className="sr-only" htmlFor="invite-username">邀请用户名</label><input id="invite-username" name="username" aria-label="邀请用户名" placeholder="输入用户名" minLength={3} maxLength={32} required /></form>} actions={<BatchToolbar selectedCount={selectedUsers.size} totalCount={users.filter((user) => user.role === 'user').length} onSelectAll={() => setSelectedUsers(new Set(users.filter((user) => user.role === 'user').map((user) => user.id)))} onClear={() => setSelectedUsers(new Set())} actions={userActions} busy={mutating} progress={batchProgress} />} />
        <div className="table-scroll">
          <table>
            <thead><tr><th className="check-cell"><input type="checkbox" aria-label="选择全部用户" checked={users.some((user) => user.role === 'user') && selectedUsers.size === users.filter((user) => user.role === 'user').length} disabled={mutating} onChange={(event) => setSelectedUsers(event.currentTarget.checked ? new Set(users.filter((user) => user.role === 'user').map((user) => user.id)) : new Set())} /></th><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th className="align-right">管理</th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="check-cell"><input type="checkbox" aria-label={`选择用户 ${user.username}`} checked={user.role === 'user' && selectedUsers.has(user.id)} disabled={user.role === 'admin' || mutating} onChange={() => setSelectedUsers((current) => { const next = new Set(current); if (next.has(user.id)) next.delete(user.id); else next.add(user.id); return next })} /></td>
                  <td><strong>{user.username}</strong></td>
                  <td>{user.role === 'admin' ? '管理员' : '用户'}</td>
                  <td><span className={`status ${user.enabled ? 'success' : 'muted'}`}><i />{user.enabled ? '正常' : '已停用'}</span></td>
                  <td>{user.createdAt ? new Date(user.createdAt).toLocaleString('zh-CN') : '-'}</td>
                  <td className="align-right">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="data-section" aria-labelledby="invites-title">
        <DataHeader id="invites-title" title="有效邀请" actions={<BatchToolbar selectedCount={selectedInvites.size} totalCount={invites.length} onSelectAll={() => setSelectedInvites(new Set(invites.map((invite) => invite.id)))} onClear={() => setSelectedInvites(new Set())} actions={inviteActions} busy={mutating} progress={batchProgress} />} />
        <div className="table-scroll">
          <table>
            <thead><tr><th className="check-cell"><input type="checkbox" aria-label="选择全部邀请" checked={invites.length > 0 && selectedInvites.size === invites.length} disabled={mutating} onChange={(event) => setSelectedInvites(event.currentTarget.checked ? new Set(invites.map((invite) => invite.id)) : new Set())} /></th><th>用户名</th><th>到期时间</th><th className="align-right">操作</th></tr></thead>
            <tbody>
              {invites.length ? invites.map((invite) => (
                <tr key={invite.id}>
                  <td className="check-cell"><input type="checkbox" aria-label={`选择邀请 ${invite.username}`} checked={selectedInvites.has(invite.id)} disabled={mutating} onChange={() => setSelectedInvites((current) => { const next = new Set(current); if (next.has(invite.id)) next.delete(invite.id); else next.add(invite.id); return next })} /></td>
                  <td><strong>{invite.username}</strong></td>
                  <td>{new Date(invite.expiresAt).toLocaleString('zh-CN')}</td>
                  <td className="align-right">
                    <button className="icon-button danger" type="button" disabled={mutating} aria-label={`撤销 ${invite.username} 的邀请`} title="撤销邀请" onClick={() => revokeInvite(invite.id)}>
                      <Trash2 aria-hidden="true" size={17} />
                    </button>
                  </td>
                </tr>
              )) : <tr><td colSpan={4} className="empty-row">暂无有效邀请</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <dialog
        ref={resetDialog}
        className="reset-dialog"
        aria-labelledby="reset-title"
        onCancel={(event) => { event.preventDefault(); closePasswordReset() }}
        onClose={() => setResetUser(null)}
        onPointerDown={(event) => { if (event.target === resetDialog.current) event.preventDefault() }}
      >
        <form className="form-stack" onSubmit={resetPassword}>
          <header className="dialog-heading">
            <div><h2 id="reset-title">重置用户密码</h2><p>{resetUser?.username}</p></div>
            <button className="icon-button" type="button" aria-label="关闭密码重置" onClick={closePasswordReset} disabled={mutating}>
              <X aria-hidden="true" size={18} />
            </button>
          </header>
          <label className="field"><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={mutating} required /></label>
          <label className="field"><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={mutating} required /></label>
          {resetError ? <p className="form-message error" role="alert">{resetError}</p> : null}
          <div className="dialog-actions">
            <button className="button secondary" type="button" onClick={closePasswordReset} disabled={mutating}>取消</button>
            <button className="button primary" type="submit" disabled={mutating}><KeyRound aria-hidden="true" size={17} />确认重置</button>
          </div>
        </form>
      </dialog>

      <ConfirmDialog
        open={batchConfirm !== null}
        title={batchConfirm?.target === 'invites' ? '撤销邀请' : '停用用户'}
        description={batchConfirm?.target === 'invites' ? `将撤销选中的 ${selectedInvites.size} 个邀请。` : `将停用选中的 ${selectedUsers.size} 个用户，现有会话会被撤销。`}
        confirmLabel={batchConfirm?.target === 'invites' ? '确认撤销' : '确认停用'}
        danger
        busy={mutating}
        onClose={() => setBatchConfirm(null)}
        onConfirm={() => executeBatch(batchConfirm?.target ?? 'invites', batchConfirm?.action ?? 'revoke')}
      />
    </div>
  )
}
