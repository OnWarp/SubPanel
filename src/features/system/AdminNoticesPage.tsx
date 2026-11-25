import { adminDomains } from '../../app/navigation'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { ModuleTabs } from '../../ui/SectionTabs'
import { NoticesSection } from './NoticesSection'

const opsNav = adminDomains.find((domain) => domain.to === '/delivery/tickets')?.section

export function AdminNoticesPage() {
  return (
    <PageContainer width="list">
      <PageHeader title="公告" />
      {opsNav ? <ModuleTabs {...opsNav} /> : null}
      <NoticesSection />
    </PageContainer>
  )
}
