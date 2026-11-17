import { Link } from 'react-router-dom'
import { PageHero } from '../../ui/PageHero'
import { EntitlementInfo } from './EntitlementInfo'

export function MyEntitlementPage() {
  return <div className="page-stack"><PageHero title="我的权益" subtitle="查看当前计划与到期信息" actions={<Link className="button secondary" to="/tickets">联系支持</Link>} /><EntitlementInfo /></div>
}
