import { Settings } from 'lucide-react'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'

export function SystemPage() {
  return (
    <div className="page-stack">
      <PageHeader title="系统管理" />
      <EmptyState icon={Settings} title="暂无系统管理项" description="系统级设置会集中放在这里" />
    </div>
  )
}
