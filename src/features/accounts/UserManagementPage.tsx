import { useState } from 'react'
import { SubscriptionBatchJobs } from '../delivery/SubscriptionBatchJobs'
import { Button } from '../../ui/Button'
import { UserPlus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { OperationsHeading } from '../admin/OperationsCard'
import { PageHeader } from '../../ui/PageHeader'
import { InvitesPage } from './InvitesPage'
import { UsersPage } from './UsersPage'

export function UserManagementPage() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState(false)
  const invite = pathname === '/invites'
  const trash = pathname === '/users/recycle-bin'
  return (
    <div className="page-stack">
      <PageHeader title="用户管理" />
      <section className="data-section" aria-label="用户管理">
        <OperationsHeading action={
          <><Button onClick={() => setJobs(true)}>批量任务</Button><Button variant="primary" size="page" onClick={() => navigate(`/invites${search}`)}>
            <UserPlus aria-hidden="true" size={18} />
            邀请用户
          </Button></>
        } />
        {invite ? <InvitesPage /> : <UsersPage key={pathname} view={trash ? 'trash' : 'active'} />}
      </section>
      {jobs && <SubscriptionBatchJobs request={null} choosingPlan={false} plans={[]} platforms={{}}
        historyOpen onCloseHistory={() => setJobs(false)} onClear={() => undefined}
        onPreviewPlan={() => undefined} onChanged={() => undefined} />}
    </div>
  )
}
