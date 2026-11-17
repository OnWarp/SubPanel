import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../app/api'
import { PageHeader } from '../../ui/PageHeader'
import { PlanCard } from '../../ui/PlanCard'
import { LoadingState } from '../../ui/LoadingState'
import { ErrorState } from '../../ui/ErrorState'
import { entitlementLabels, type EntitlementState, type PublicPlan } from './types'

function specs(plan: PublicPlan) {
  return [
    { key: 'duration', label: '有效天数', value: `${plan.durationDays} 天` },
    { key: 'traffic', label: '流量配额（仅展示）', value: plan.trafficGb ? `${plan.trafficGb} GB` : '不限' },
    { key: 'speed', label: '限速', value: plan.speedLimitMbps ? `${plan.speedLimitMbps} Mbps` : '不限' },
    { key: 'devices', label: '设备数（仅记录）', value: plan.deviceLimit || '不限' },
  ]
}

export function EntitlementsPage() {
  const [rights, setRights] = useState<EntitlementState | null>(null)
  const [plans, setPlans] = useState<PublicPlan[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setError('')
    try {
      const [rights, catalog] = await Promise.all([api<EntitlementState>('/api/account/entitlement'), api<{ plans: PublicPlan[] }>('/api/account/plans')])
      setRights(rights); setPlans(catalog.plans)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载权益失败') }
  }, [])
  useEffect(() => { void load() }, [load])
  const entitlement = rights?.current ?? rights?.latest
  const wallPlans = entitlement && !plans.some((plan) => plan.id === entitlement.planId) ? [entitlement.plan, ...plans] : plans
  return <div className="page-stack ui3-entitlements">
    <PageHeader title="我的权益" actions={<Link className="button secondary" to="/subscriptions">订阅详情</Link>} />
    {error ? <ErrorState message={error} onRetry={() => { void load() }} /> : !rights ? <LoadingState label="正在加载权益" /> : <>
      <section className="data-section ui3-current-rights" aria-label="当前权益">
        <h2>{rights.current?.plan.name ?? entitlementLabels[rights.state]}</h2>
        <dl className="sp-plan-specs">
          <div><dt>计划</dt><dd>{entitlement?.plan.name ?? '未开通'}</dd></div>
          <div><dt>到期时间</dt><dd>{entitlement ? new Date(entitlement.expiresAt).toLocaleString('zh-CN') : '—'}</dd></div>
          {entitlement ? specs(entitlement.plan).filter((spec) => spec.key !== 'duration').map((spec) => <div key={spec.key}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>) : null}
        </dl>
      </section>
      <section aria-label="权益计划" className="ui3-plan-wall">
        {wallPlans.map((plan) => <PlanCard key={plan.id} name={plan.name} specs={specs(plan)} highlighted={rights.current?.planId === plan.id} badge={entitlement?.planId === plan.id ? rights.current ? '使用中' : entitlementLabels[rights.state] : undefined} footer={plan.description || undefined} />)}
      </section>
      <p className="ui3-plan-hint">计划由管理员分配，如需开通或更换请联系管理员</p>
    </>}
  </div>
}
