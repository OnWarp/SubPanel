import { PageHeader } from '../../ui/PageHeader'
import { InviteCodesSection } from '../system/InviteCodesSection'

export function InvitesPage() {
  return <div className="page-stack"><PageHeader title="邀请" /><section className="data-section sys-section"><InviteCodesSection /></section></div>
}
