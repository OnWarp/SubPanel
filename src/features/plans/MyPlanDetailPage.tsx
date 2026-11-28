import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../app/api'
import { DetailList } from '../../ui/DetailList'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import {
  errorText, formatPlanTime, planRangeText, planSourceLabel, planStatusLabel, planStatusTone,
  remainingSecondsText,
  type PlanDetail,
} from '../plans/my-plan-model'

// A non-active instance must not offer client import: the subscription output
// is empty for it, so the entry is disabled with the reason in place.
function importBlockedReason(plan: PlanDetail): string | null {
  if (plan.status === 'active') return null
  if (plan.status === 'pending') return '套餐尚未生效，暂不能导入客户端'
  if (plan.status === 'expired') return '套餐已过期，暂不能导入客户端'
  if (plan.status === 'paused') return '套餐已暂停，暂不能导入客户端'
  return '套餐已停用，暂不能导入客户端'
}

function DetailSkeleton() {
  return <section className="upd-plan-detail upd-plan-skeleton" aria-busy="true" aria-label="正在加载套餐详情">
    <LoadingState label="正在加载套餐" />
  </section>
}

export function MyPlanDetailPage() {
  const { instanceId = '' } = useParams()
  const [plan, setPlan] = useState<PlanDetail>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void api<{ plan: PlanDetail }>(`/api/me/plans/${encodeURIComponent(instanceId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(result => { if (!controller.signal.aborted) setPlan(result.plan) })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorText(cause, '加载套餐详情失败')) })
    return () => controller.abort()
  }, [instanceId, revision])

  const blocked = plan ? importBlockedReason(plan) : null

  return <PageContainer width="detail">
    <div className="page-stack upd-page upd-plans">
      <PageHeader title={plan?.name ?? '套餐详情'} placement="inline"
        leading={<Link className="upd-mine-back" to="/me/plans"><ArrowLeft size={16} aria-hidden="true" />我的套餐</Link>} />
      {error ? <ErrorState message={error} onRetry={() => setRevision(value => value + 1)} />
        : !plan ? <DetailSkeleton /> : <>
          <section className="upd-plan-detail" aria-label="套餐详情">
            <div className="upd-plan-card-head">
              <strong>{plan.name}</strong>
              <span className={`upd-plan-status is-${planStatusTone(plan.status)}`}>{planStatusLabel(plan.status)}</span>
            </div>
            <p className="upd-plan-range">{planRangeText(plan.startsAt, plan.expiresAt)}</p>
            {plan.description ? <p className="upd-plan-description">{plan.description}</p> : null}
            <DetailList items={[
              { id: 'startsAt', label: '生效时间', value: formatPlanTime(plan.startsAt) },
              { id: 'expiresAt', label: '到期时间', value: formatPlanTime(plan.expiresAt) },
              { id: 'remaining', label: '剩余有效期', value: remainingSecondsText(plan.remainingSeconds) ?? '—' },
              { id: 'source', label: '领取方式', value: planSourceLabel(plan.source) },
            ]} />
          </section>
          <section className="upd-plan-groups" aria-labelledby="plan-groups-title">
            <h2 id="plan-groups-title">包含节点组 ({plan.nodeGroupCount})</h2>
            {plan.nodeGroups.length === 0 ? <p className="upd-plan-empty">这个套餐没有关联节点组</p>
              : <ul className="upd-plan-group-list">
                {plan.nodeGroups.map(group => <li key={group.id}><span>{group.name}</span>{group.enabled ? null : <span className="upd-plan-group-off">已停用</span>}</li>)}
              </ul>}
          </section>
          <div className="upd-plan-actions">
            {blocked
              ? <p className="upd-plan-blocked" role="note">{blocked}</p>
              : <Link className="button primary" to={`/subscriptions?subscription=${encodeURIComponent(plan.instanceId)}`}>
                查看此套餐订阅<ChevronRight size={16} aria-hidden="true" />
              </Link>}
          </div>
        </>}
    </div>
  </PageContainer>
}
