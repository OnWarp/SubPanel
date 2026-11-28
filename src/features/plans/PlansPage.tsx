import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, jsonBody } from '../../app/api'
import { AdminModuleTabs } from '../admin-resources/AdminModuleTabs'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { DetailList } from '../../ui/DetailList'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FormSelect } from '../../ui/Controls'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { RowActions } from '../../ui/RowActions'
import { SearchInput } from '../../ui/SearchInput'
import { DetailTabs } from '../../ui/SectionTabs'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'
import { AssignPlanDialog } from './AssignPlanDialog'
import { PlanEditor } from './PlanEditor'
import {
  errorText, formatDuration, formatInstant, groupSummary, instanceStatus, instanceStatusLabel, pageCountFor,
  planStatusLabel, sourceLabel, type PlanDefinition, type PlanInstance, type PlanStatus,
} from './model'

const PAGE_SIZE = 50

function statusTone(status: PlanStatus) {
  if (status === 'enabled') return 'success' as const
  if (status === 'archived') return 'warning' as const
  return 'muted' as const
}

function instanceTone(status: ReturnType<typeof instanceStatus>) {
  if (status === 'active') return 'success' as const
  if (status === 'pending') return 'info' as const
  if (status === 'paused' || status === 'plan_disabled') return 'warning' as const
  if (status === 'expired') return 'danger' as const
  return 'muted' as const
}

export function PlansPage() {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | PlanStatus>('all')
  const [page, setPage] = useState(1)
  const [plans, setPlans] = useState<PlanDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [editor, setEditor] = useState<PlanDefinition | 'create' | null>(null)
  const [pending, setPending] = useState<{ kind: 'disable' | 'archive'; plan: PlanDefinition } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
      if (query.trim()) params.set('search', query.trim())
      if (status !== 'all') params.set('status', status)
      setLoading(true)
      void api<{ plans: PlanDefinition[] }>(`/api/admin/plans?${params}`, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return
          setPlans(result.plans)
          setError('')
        })
        .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause, '加载套餐失败')) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [page, query, revision, status])

  const reload = () => setRevision((value) => value + 1)

  const run = async (plan: PlanDefinition, kind: 'enable' | 'disable' | 'archive' | 'duplicate') => {
    setBusy(true)
    try {
      if (kind === 'duplicate') {
        await api(`/api/admin/plans/${encodeURIComponent(plan.id)}/duplicate`, { method: 'POST', body: jsonBody({}) })
        toast.notify('套餐已复制')
      } else if (kind === 'archive') {
        await api(`/api/admin/plans/${encodeURIComponent(plan.id)}`, { method: 'DELETE', body: jsonBody({ version: plan.version }) })
        toast.notify('套餐已归档')
      } else {
        await api(`/api/admin/plans/${encodeURIComponent(plan.id)}`, {
          method: 'PATCH', body: jsonBody({ version: plan.version, enabled: kind === 'enable' }),
        })
        toast.notify(kind === 'enable' ? '套餐已启用' : '套餐已停用')
      }
      setPending(null)
      reload()
    } catch (cause) {
      toast.notifyError(errorText(cause, '操作失败'))
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<DataTableColumn<PlanDefinition>> = [
    { key: 'name', header: '名称', render: (plan) => <Link to={`/plans/${encodeURIComponent(plan.id)}`}>{plan.name}</Link> },
    { key: 'groups', header: '节点组', render: (plan) => groupSummary(plan) },
    { key: 'duration', header: '默认时长', render: (plan) => formatDuration(plan.duration_seconds) },
    { key: 'users', header: '用户数', render: (plan) => plan.userCount },
    { key: 'status', header: '状态', render: (plan) => <StatusBadge tone={statusTone(plan.status)} size="sm">{planStatusLabel(plan.status)}</StatusBadge> },
  ]

  return (
    <PageContainer width="list">
      <PageHeader placement="inline" id="plans-title" title="套餐管理" actions={<button className="button primary" type="button" onClick={() => setEditor('create')}><Plus aria-hidden="true" size={17} />新建套餐</button>} />
      <AdminModuleTabs />
      <FilterBar onReset={query || status !== 'all' ? () => { setQuery(''); setStatus('all'); setPage(1) } : undefined}>
        <SearchInput label="搜索套餐" placeholder="搜索名称、说明或备注" value={query} onChange={(value) => { setQuery(value); setPage(1) }} />
        <label className="filter-field">
          <span>状态</span>
          <FormSelect aria-label="套餐状态" value={status} onChange={(event) => { setStatus(event.currentTarget.value as typeof status); setPage(1) }}>
            <option value="all">全部状态</option>
            <option value="enabled">启用</option>
            <option value="disabled">停用</option>
            <option value="archived">已归档</option>
          </FormSelect>
        </label>
      </FilterBar>
      {error ? <ErrorState message={error} onRetry={reload} /> : (
        <DataTable
          columns={columns}
          rows={loading ? [] : plans}
          rowKey={(plan) => plan.id}
          loadingLabel={loading ? '正在加载套餐' : undefined}
          empty="暂无匹配套餐"
          summary={!loading ? `本页 ${plans.length} 个套餐` : undefined}
          pagination={!loading ? { compact: true, page, pageCount: pageCountFor(page, plans.length, PAGE_SIZE), onPageChange: setPage } : undefined}
          rowActions={(plan) => (
            <RowActions label={`${plan.name} 的操作`} actions={[
              { label: '编辑', disabled: busy, onClick: () => setEditor(plan) },
              { label: '复制', disabled: busy, onClick: () => void run(plan, 'duplicate') },
              ...(plan.status === 'archived' ? [] : [
                plan.status === 'enabled'
                  ? { label: '停用', disabled: busy, onClick: () => setPending({ kind: 'disable', plan }) }
                  : { label: '启用', disabled: busy, onClick: () => void run(plan, 'enable') },
                { label: '归档', danger: true, disabled: busy, onClick: () => setPending({ kind: 'archive', plan }) },
              ]),
            ]} />
          )}
        />
      )}
      {editor ? <PlanEditor plan={editor === 'create' ? null : editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); reload(); toast.notify(editor === 'create' ? '套餐已创建' : '套餐已保存') }} /> : null}
      <ConfirmDialog
        appearance="content"
        open={pending !== null}
        danger
        busy={busy}
        title={pending?.kind === 'archive' ? '归档套餐' : '停用套餐'}
        description={pending ? pending.kind === 'archive'
          ? `归档「${pending.plan.name}」后不能再分配。已有 ${pending.plan.instanceCount} 个未撤销实例会保留`
          : `停用「${pending.plan.name}」后，${pending.plan.instanceCount} 个未撤销实例会显示为套餐停用` : ''}
        confirmLabel={pending?.kind === 'archive' ? '归档套餐' : '停用套餐'}
        onClose={() => { if (!busy) setPending(null) }}
        onConfirm={() => { if (pending) void run(pending.plan, pending.kind) }}
      />
    </PageContainer>
  )
}

export function PlanDetailPage() {
  const { id = '' } = useParams()
  return <PlanDetail key={id} id={id} />
}

function PlanDetail({ id }: { id: string }) {
  const toast = useToast()
  const [params] = useSearchParams()
  const tab = params.get('tab') === 'groups' ? 'groups' : params.get('tab') === 'instances' ? 'instances' : 'overview'
  const [plan, setPlan] = useState<PlanDefinition | null>(null)
  const [instances, setInstances] = useState<PlanInstance[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const base = `/plans/${encodeURIComponent(id)}`
  const tabs = [
    { to: base, label: '概览' },
    { to: `${base}?tab=groups`, label: '节点组' },
    { to: `${base}?tab=instances`, label: '已分配' },
  ]

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void api<{ plan: PlanDefinition }>(`/api/admin/plans/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setPlan(result.plan); setError('') } })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause, '加载套餐失败')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [id, revision])

  useEffect(() => {
    if (tab !== 'instances') return
    const controller = new AbortController()
    void api<{ instances: PlanInstance[] }>(`/api/admin/plans/${encodeURIComponent(id)}/users?limit=50`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setInstances(result.instances) })
      .catch((cause) => { if (!controller.signal.aborted) toast.notifyError(errorText(cause, '加载实例失败')) })
    return () => controller.abort()
  }, [id, revision, tab, toast])

  const activeTo = tabs[tab === 'groups' ? 1 : tab === 'instances' ? 2 : 0].to
  return (
    <PageContainer width="detail">
      <PageHeader
        placement="inline"
        title={plan?.name || '套餐详情'}
        leading={<Link to="/plans">← 返回套餐管理</Link>}
        status={plan ? <StatusBadge tone={statusTone(plan.status)} size="sm">{planStatusLabel(plan.status)}</StatusBadge> : undefined}
        actions={plan ? <>
          <button className="button secondary" type="button" onClick={() => setEditing(true)}>编辑</button>
          <button className="button primary" type="button" disabled={plan.status !== 'enabled'} onClick={() => setAssigning(true)}>分配用户</button>
        </> : undefined}
      />
      {error ? <ErrorState message={error} onRetry={() => setRevision((value) => value + 1)} />
        : loading || !plan ? <p role="status">正在加载套餐</p> : <>
          <DetailTabs label="套餐详情" tabs={tabs} activeTo={activeTo} />
          {tab === 'groups' ? (
            <>
              {plan.nodeGroups.some((group) => group.empty) ? <StatusMessage tone="warning">{`有空节点组，去重后 ${plan.nodeCount} 个节点`}</StatusMessage> : null}
              <DataTable
                rows={plan.nodeGroups}
                rowKey={(group) => group.id}
                empty="未选择节点组"
                columns={[
                  { key: 'name', header: '节点组', render: (group) => group.name },
                  { key: 'nodes', header: '节点数', render: (group) => String(group.nodeCount) },
                  { key: 'empty', header: '状态', render: (group) => group.empty ? '空' : group.enabled ? '启用' : '停用' },
                ]}
              />
            </>
          ) : tab === 'instances' ? (
            <DataTable
              rows={instances}
              rowKey={(row) => row.id}
              empty="暂无分配"
              columns={[
                { key: 'user', header: '用户', render: (row) => <Link to={`/users/${encodeURIComponent(row.user_id)}?tab=subscription`}>{row.username || row.user_id}</Link> },
                { key: 'source', header: '来源', render: (row) => sourceLabel(row.source) },
                { key: 'start', header: '开始', render: (row) => formatInstant(row.starts_at) },
                { key: 'end', header: '到期', render: (row) => formatInstant(row.expires_at) },
                { key: 'status', header: '状态', render: (row) => { const current = instanceStatus(row); return <StatusBadge tone={instanceTone(current)} size="sm">{instanceStatusLabel(current)}</StatusBadge> } },
                { key: 'nodes', header: '节点数', render: (row) => row.nodeCount },
              ]}
            />
          ) : (
            <DetailList items={[
              { id: 'description', label: '说明', value: plan.description || '—' },
              { id: 'duration', label: '默认时长', value: formatDuration(plan.duration_seconds) },
              { id: 'nodes', label: '去重节点', value: plan.nodeCount },
              { id: 'users', label: '用户数', value: plan.userCount },
              { id: 'instances', label: '未撤销实例', value: plan.instanceCount },
              { id: 'note', label: '备注', value: plan.note || '—' },
            ]} />
          )}
        </>}
      {editing && plan ? <PlanEditor plan={plan} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setRevision((value) => value + 1); toast.notify('套餐已保存') }} /> : null}
      {assigning && plan ? <AssignPlanDialog fixedPlanId={plan.id} targets={[]} onClose={() => setAssigning(false)} onAssigned={() => setRevision((value) => value + 1)} /> : null}
    </PageContainer>
  )
}
