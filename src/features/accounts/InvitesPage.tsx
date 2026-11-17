import { PageHeader } from '../../ui/PageHeader'
import { InviteCodesSection } from '../system/InviteCodesSection'

export function InvitesPage() {
  return <div className="page-stack"><PageHeader title="用户管理" /><section className="data-section sys-section"><InviteCodesSection /></section></div>
}
