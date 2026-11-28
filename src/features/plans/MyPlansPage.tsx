import { ArrowLeft, ChevronRight, Ticket } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../app/api'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import {
  PLAN_PAGE_SIZE, errorText, formatPlanDate, formatPlanTime, isExpiringSoon, planStatusLabel, planStatusTone,
  type PlanFilter, type PlanListItem, type PlanListResponse, type PlanSummary,
} from '../plans/my-plan-model'
import { usePlanOverview } from '../plans/use-plan-overview'
import { RedeemPlanDialog } from '../plans/RedeemPlanDialog'

const filters: Array<{ value: PlanFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '有效' },
  { value: 'expired', label: '已过期' },
  { value: 'pending', label: '待生效' },
  { value: 'disabled', label: '已停用' },
]

// A filter tab is only offered once the account actually has that bucket, so
// the bar never leads to an empty list it cannot fill.
function visibleFilters(summary: PlanSummary | undefined): Array<{ value: PlanFilter; label: string }> {
  if (!summary) return filters.slice(0, 3)
  return filters.filter(item => item.value === 'all' || item.value === 'active' || item.value === 'expired'
    || (item.value === 'pending' && summary.pending > 0)
    || (item.value === 'disabled' && summary.disabled > 0))
}

function PlanStatsRow({ summary }: { summary: PlanSummary }) {
  return <dl className="upd-plans-stats" aria-label="套餐统计">
    <div><dt>全部套餐</dt><dd>{summary.total}</dd></div>
    <div><dt>有效套餐</dt><dd className="is-success">{summary.active}</dd></div>
    <div><dt>已过期</dt><dd className="is-muted">{summary.expired}</dd></div>
  </dl>
}

function PlanCard({ plan, now }: { plan: PlanListItem; now: number }) {
  const soon = plan.status === 'active' && isExpiringSoon(plan.expiresAt, now)
  const expiry = plan.expiresAt === null ? '长期有效'
    : plan.status === 'pending' ? `生效 ${formatPlanTime(plan.startsAt)}`
      : `到期 ${formatPlanDate(plan.expiresAt)}`
  const muted = plan.bucket === 'expired' || plan.bucket === 'disabled'
  return <Link className={`upd-plan-card${muted ? ' is-muted' : ''}`} to={`/me/plans/${encodeURIComponent(plan.instanceId)}`}
    aria-label={`${plan.name} ${planStatusLabel(plan.status)}`}>
    <div className="upd-plan-card-head">
      <strong>{plan.name}</strong>
      <span className={`upd-plan-status is-${planStatusTone(plan.status)}`}>{planStatusLabel(plan.status)}</span>
    </div>
    <p className={`upd-plan-expiry${soon ? ' is-warning' : ''}`}>{expiry}</p>
    <div className="upd-plan-card-foot">
      <span>{plan.nodeGroupCount} 个节点组</span>
      <span className="upd-plan-detail-link">查看详情<ChevronRight size={15} aria-hidden="true" /></span>
    </div>
  </Link>
}

function PlansFrame({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <PageContainer width="list">
    <div className="page-stack upd-page upd-plans">
      <PageHeader title="我的套餐" placement="inline"
        leading={<Link className="upd-mine-back" to="/me"><ArrowLeft size={16} aria-hidden="true" />个人中心</Link>}
        actions={actions} />
      {children}
    </div>
  </PageContainer>
}

export function MyPlansPage() {
  const [params, setParams] = useSearchParams()
  const queryStatus = params.get('status')
  const status: PlanFilter = filters.some(item => item.value === queryStatus) ? queryStatus as PlanFilter : 'all'
  const [items, setItems] = useState<PlanListItem[]>([])
  const [summary, setSummary] = useState<PlanSummary>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [redeemOpen, setRedeemOpen] = useState(false)
  const overview = usePlanOverview()
  const listRef = useRef<HTMLDivElement>(null)

  const cursor = cursors[pageIndex] ?? null
  const path = `/api/me/plans?limit=${PLAN_PAGE_SIZE}&status=${status}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void api<PlanListResponse>(path, { signal: controller.signal, cache: 'no-store' })
      .then(result => {
        if (controller.signal.aborted) return
        setItems(result.items)
        setSummary(result.summary)
        setNextCursor(result.nextCursor)
        setError('')
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorText(cause, '加载套餐失败'))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [path, revision])

  const changeStatus = (next: PlanFilter) => {
    setPageIndex(0)
    setCursors([null])
    setItems([])
    setParams(next === 'all' ? {} : { status: next }, { replace: true })
  }

  const nextPage = () => {
    if (!nextCursor) return
    setCursors(prev => { const copy = prev.slice(0, pageIndex + 1); copy.push(nextCursor); return copy })
    setPageIndex(index => index + 1)
    listRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const previousPage = () => setPageIndex(index => Math.max(0, index - 1))

  const refresh = useCallback(() => {
    setRevision(value => value + 1)
    overview.reload()
  }, [overview])

  const now = Date.now()
  const tabs = visibleFilters(summary ?? (overview.state.kind === 'ready' ? overview.state.overview.plans : undefined))
  const stats = summary ?? (overview.state.kind === 'ready' ? overview.state.overview.plans : undefined)
  const filteredEmpty = status !== 'all' && items.length === 0 && !loading && !error
  const redeemAction = <Button variant="primary" onClick={() => setRedeemOpen(true)}><Ticket size={16} aria-hidden="true" />兑换套餐</Button>

  return <PlansFrame actions={redeemAction}>
    <div ref={listRef} />
    {stats ? <PlanStatsRow summary={stats} /> : null}
    <nav className="upd-plan-filters" aria-label="套餐筛选">
      {tabs.map(item => <button key={item.value} type="button" aria-pressed={status === item.value}
        className={status === item.value ? 'active' : undefined} onClick={() => changeStatus(item.value)}>{item.label}</button>)}
    </nav>
    {error ? <ErrorState message={error} onRetry={() => setRevision(value => value + 1)} />
      : loading && items.length === 0 ? <PlansSkeleton />
        : items.length === 0 ? (filteredEmpty
          ? <EmptyState title="当前筛选下没有套餐" description="可以返回全部查看">
            <Button variant="secondary" onClick={() => changeStatus('all')}>返回全部</Button>
          </EmptyState>
          : <EmptyState title="暂无套餐" description="兑换套餐后可在这里查看有效期和节点组">
            <Button variant="primary" onClick={() => setRedeemOpen(true)}>兑换套餐</Button>
          </EmptyState>)
          : <>
            <div className="upd-plan-list">
              {items.map(plan => <PlanCard key={plan.instanceId} plan={plan} now={now} />)}
            </div>
            {(pageIndex > 0 || nextCursor) ? <nav className="upd-plan-pager" aria-label="套餐分页">
              <button type="button" disabled={pageIndex === 0} onClick={previousPage}>上一页</button>
              <span>第 {pageIndex + 1} 页</span>
              <button type="button" disabled={!nextCursor} onClick={nextPage}>下一页</button>
            </nav> : null}
          </>}
    <RedeemPlanDialog open={redeemOpen} onClose={() => setRedeemOpen(false)} onRedeemed={() => { refresh() }} />
  </PlansFrame>
}

function PlansSkeleton() {
  return <div className="upd-plan-list upd-plan-skeleton" aria-busy="true" aria-label="正在加载套餐">
    {[0, 1].map(index => <div key={index} className="upd-plan-card is-skeleton"><LoadingState label={index === 0 ? '正在加载套餐' : ''} /></div>)}
  </div>
}
