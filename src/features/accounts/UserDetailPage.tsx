import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, type AdminUserDetail } from '../../app/api'
import { DataTable } from '../../ui/DataTable'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { DetailList } from '../../ui/DetailList'
import { PageContainer } from '../../ui/PageContainer'
import { DetailTabs } from '../../ui/SectionTabs'
import { PageHeader } from '../../ui/PageHeader'
import { StatusPill } from '../../ui/StatusPill'
import { useBindingDetails } from '../delivery/UserSubscriptionPlan'
import { UserPlansPanel } from '../plans/UserPlansPanel'

function UserDetail({ id }: { id: string }) {
  const [params] = useSearchParams()
  const [user, setUser] = useState<AdminUserDetail['user']>()
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const details = useBindingDetails(id)
  const tab = params.get('tab')
  const base = `/users/${encodeURIComponent(id)}`
  const tabs = [
    { to: base, label: '基本信息' },
    { to: `${base}?tab=subscription`, label: '套餐' },
    { to: `${base}?tab=logs`, label: '操作日志' },
  ]
  const activeTab = tabs[tab === 'subscription' ? 1 : tab === 'logs' ? 2 : 0].to
  useEffect(() => {
    const controller = new AbortController()
    void api<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setUser(result.user) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [id, revision])
  return <PageContainer width="detail">
    <PageHeader placement="inline" title={user?.email || user?.username || '用户详情'}
      leading={<Link to="/users">← 返回用户管理</Link>}
      status={user && <StatusPill tone={user.enabled ? 'success' : 'neutral'}>{user.enabled ? '正常' : '已停用'}</StatusPill>} />
    {error ? <ErrorState message="加载用户失败" onRetry={() => { setError(false); setRevision(value => value + 1) }} />
      : !user ? <LoadingState label="正在加载用户" /> : <>
        <DetailTabs label="用户详情" tabs={tabs} activeTo={activeTab} />
        {tab === 'subscription' ? <UserPlansPanel userId={user.id} username={user.username} />
          : tab === 'logs' ? details.error
            ? <ErrorState message={details.error} onRetry={() => void details.load()} />
            : details.legacy ? <Link to="/audit-logs">审计日志</Link>
              : !details.data ? <LoadingState label="正在加载操作日志" />
                : <DataTable rows={details.data.summary.logs} rowKey={row => row.id} empty="暂无操作日志"
                  columns={[{ key: 'action', header: '操作' }, { key: 'createdAt', header: '时间', render: row => new Date(row.createdAt).toLocaleString() }]} />
            : <DetailList items={[
              { id: 'username', label: '用户名', value: user.username },
              { id: 'email', label: '邮箱', value: user.email || '—' },
            ]} />}
      </>}
  </PageContainer>
}

export function UserDetailPage() {
  const { id = '' } = useParams()
  return <UserDetail key={id} id={id} />
}
