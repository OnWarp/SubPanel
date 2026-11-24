import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, type AdminUserDetail } from '../../app/api'
import { DataTable } from '../../ui/DataTable'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusPill } from '../../ui/StatusPill'
import { useBindingDetails, UserSubscriptionPlan } from '../delivery/UserSubscriptionPlan'

function UserDetail({ id }: { id: string }) {
  const [params] = useSearchParams()
  const [user, setUser] = useState<AdminUserDetail['user']>()
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const details = useBindingDetails(id)
  const tab = params.get('tab')
  useEffect(() => {
    const controller = new AbortController()
    void api<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setUser(result.user) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [id, revision])
  return <div className="page-stack">
    <PageHeader title={user?.email || user?.username || '用户详情'}
      actions={<Link className="button secondary" to="/users">用户管理</Link>} />
    {error ? <ErrorState message="加载用户失败" onRetry={() => { setError(false); setRevision(value => value + 1) }} />
      : !user ? <LoadingState label="正在加载用户" /> : <>
        <nav className="upd-link-row" aria-label="用户详情">
          {[[null, '基本信息'], ['subscription', '订阅授权'], ['logs', '操作日志']].map(([value, label]) =>
            <Link className={`button ${tab === value ? 'primary' : 'ghost'}`} key={label}
              aria-current={tab === value ? 'page' : undefined} to={value ? `?tab=${value}` : '?'}>{label}</Link>)}
        </nav>
        <section className="data-section">
          {tab === 'subscription' ? <UserSubscriptionPlan user={user} details={details} />
            : tab === 'logs' ? details.error
              ? <ErrorState message={details.error} onRetry={() => void details.load()} />
              : details.legacy ? <Link to="/audit-logs">审计日志</Link>
                : !details.data ? <LoadingState label="正在加载操作日志" />
                  : <DataTable rows={details.data.summary.logs} rowKey={row => row.id} empty="暂无操作日志"
                    columns={[{ key: 'action', header: '操作' }, { key: 'createdAt', header: '时间', render: row => new Date(row.createdAt).toLocaleString() }]} />
              : <dl className="key-value-rows">
                <div><dt>用户名</dt><dd>{user.username}</dd></div>
                <div><dt>邮箱</dt><dd>{user.email || '—'}</dd></div>
                <div><dt>状态</dt><dd><StatusPill tone={user.enabled ? 'success' : 'neutral'}>{user.enabled ? '正常' : '已停用'}</StatusPill></dd></div>
              </dl>}
        </section>
      </>}
  </div>
}

export function UserDetailPage() {
  const { id = '' } = useParams()
  return <UserDetail key={id} id={id} />
}
