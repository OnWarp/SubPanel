import { useState } from 'react'
import { SubscriptionBatchJobs } from '../delivery/SubscriptionBatchJobs'
import { Button } from '../../ui/Button'
import { UserPlus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { adminDomains } from '../../app/navigation'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { ModuleTabs } from '../../ui/SectionTabs'
import { InvitesPage } from './InvitesPage'
import { UsersPage } from './UsersPage'

export function UserManagementPage() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState(false)
  const invite = pathname === '/invites'
  const trash = pathname === '/users/recycle-bin'
  const section = adminDomains.find((domain) => domain.to === '/users')?.section
  return (
    <PageContainer width="list">
      <PageHeader title="用户管理" />
      {section ? <ModuleTabs {...section} /> : null}
      <section className="content-stack" aria-label="用户管理">
        <div className="content-page-actions">
          <Button onClick={() => setJobs(true)}>批量任务</Button>
          <Button variant="primary" size="page" onClick={() => navigate(`/invites${search}`)}>
            <UserPlus aria-hidden="true" size={18} />
            邀请用户
          </Button>
        </div>
        {invite ? <InvitesPage /> : <UsersPage key={pathname} view={trash ? 'trash' : 'active'} />}
      </section>
      {jobs && <SubscriptionBatchJobs request={null} choosingPlan={false} plans={[]} platforms={{}}
        historyOpen onCloseHistory={() => setJobs(false)} onClear={() => undefined}
        onPreviewPlan={() => undefined} onChanged={() => undefined} />}
    </PageContainer>
  )
}
