import { OperationsActions, OperationsFooter, OperationsHeading } from '../admin/OperationsCard'
import { StatusBadge } from '../../ui/StatusBadge'
import { FormSelect, Input, Textarea, Checkbox } from '../../ui/Controls'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, jsonBody } from '../../app/api'
import { PageHeader } from '../../ui/PageHeader'
import { EditDrawer } from '../../ui/EditDrawer'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { FormField } from '../../ui/FormField'
import { DataTable } from '../../ui/DataTable'
import { StatusMessage } from '../../ui/StatusMessage'
import { LoadingState } from '../../ui/LoadingState'
import { ErrorState } from '../../ui/ErrorState'
import type { Plan } from './plan-types'
const empty: Plan = { id: '', name: '', description: '', groupIds: [], durationDays: 30, trafficGb: 0, speedLimitMbps: 0, deviceLimit: 0, enabled: true, sortOrder: 0 }
export function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([])
  const [draft, setDraft] = useState<Plan | null>(null)
  const [remove, setRemove] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [trial, setTrial] = useState({ trialPlanId: null as string | null, trialDays: null as number | null })
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, g, t] = await Promise.all([api<{ plans: Plan[] }>('/api/admin/plans'),api<{ groups: Array<{ id: string; name: string }> }>('/api/admin/catalog'),api<typeof trial>('/api/admin/subscriptions/trial')])
      setPlans(p.plans); setGroups(g.groups); setTrial(t); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft || busy) return
    setBusy(true)
    try {
      await api(`/api/admin/plans${draft.id ? `/${draft.id}` : ''}`,{ method: draft.id ? 'PUT' : 'POST',body: jsonBody(draft) })
      setDraft(null); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setBusy(false) }
  }
  const deleteSelected = async () => {
    if (!remove || busy) return
    setBusy(true)
    try { await api(`/api/admin/plans/${remove.id}`,{ method: 'DELETE' }); setRemove(null); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败'); setRemove(null) }
    finally { setBusy(false) }
  }
  const saveTrial = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try { await api('/api/admin/subscriptions/trial',{ method: 'PUT',body: jsonBody(trial) }); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setBusy(false) }
  }
  return <div className="page-stack ops-page"><PageHeader title="订阅计划" /><section className="ops-card ops-table"><OperationsHeading title="订阅计划" action={<button className="button primary" onClick={() => { setError(''); setDraft({ ...empty }) }}>新增计划</button>} />
    {error && !draft ? <ErrorState message={error} onRetry={() => { void load() }} /> : null}
    {loading ? <LoadingState /> : <DataTable rows={plans} rowKey={(p) => p.id} empty="暂无计划" columns={[
      { key: 'name',header: '计划',render: (p) => <strong className="ops-main">{p.name}<span className="ops-meta">{p.description || p.id}</span></strong> },
      { key: 'duration',header: '天数',render: (p) => p.durationDays },
      { key: 'groups',header: '分组',render: (p) => p.groupIds.map((id) => groups.find((g) => g.id === id)?.name ?? id).join('、') || '—' },
      { key: 'traffic',header: '流量 GB',render: (p) => p.trafficGb || '不限' },
      { key: 'speed',header: 'Mbps',render: (p) => p.speedLimitMbps || '不限' },
      { key: 'enabled',header: '状态',render: (p) => <StatusBadge tone={p.enabled ? "success" : "muted"}>{p.enabled ? "启用" : "停用"}</StatusBadge> },
      { key: 'actions',header: '操作', align: 'right', render: (p) => <OperationsActions label={`管理计划 ${p.name}`}><button className="button ghost" onClick={() => { setError(''); setDraft({ ...p }) }}>编辑</button><button className="button ghost" onClick={() => setRemove(p)}>删除</button></OperationsActions> },
    ]} />}
    {!loading && <OperationsFooter total={plans.length} unit="个" />}
    </section>
    <section className="ops-card"><form className="form-stack" onSubmit={(e) => { void saveTrial(e) }}><h2>注册试用</h2>
      <FormField label="试用计划" htmlFor="trial-plan"><FormSelect id="trial-plan" value={trial.trialPlanId ?? ''} onChange={(e) => setTrial({ ...trial,trialPlanId: e.target.value || null })}><option value="">关闭</option>{plans.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</FormSelect></FormField>
      <FormField label="试用天数" htmlFor="trial-days"><Input id="trial-days" type="number" min="1" max="36500" value={trial.trialDays ?? ''} onChange={(e) => setTrial({ ...trial,trialDays: e.target.value ? Number(e.target.value) : null })} /></FormField><button className="button primary" disabled={busy}>保存试用设置</button>
    </form></section>
    <EditDrawer open={draft !== null} title={draft?.id ? '编辑计划' : '新增计划'} busy={busy} onClose={() => setDraft(null)}>
      {draft ? <form className="form-stack" onSubmit={(e) => { void save(e) }}>
        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
        <FormField label="名称" htmlFor="plan-name"><Input id="plan-name" required maxLength={128} value={draft.name} onChange={(e) => setDraft({ ...draft,name: e.target.value })} /></FormField>
        <FormField label="说明" htmlFor="plan-description"><Textarea id="plan-description" maxLength={2000} value={draft.description} onChange={(e) => setDraft({ ...draft,description: e.target.value })} /></FormField>
        {([['durationDays','有效天数'],['trafficGb','流量 GB（0 不限，仅展示）'],['speedLimitMbps','限速 Mbps（0 不限）'],['deviceLimit','设备数（0 不限，仅记录）'],['sortOrder','排序']] as const).map(([key,label]) => <FormField key={key} label={label} htmlFor={`plan-${key}`}><Input id={`plan-${key}`} type="number" required step={key === 'trafficGb' ? 'any' : 1} min={key === 'durationDays' ? 1 : key === 'sortOrder' ? -1000000 : 0} value={draft[key]} onChange={(e) => setDraft({ ...draft,[key]: Number(e.target.value) })} /></FormField>)}
        <fieldset><legend>绑定分组</legend>{groups.map((g) => <label key={g.id}><Checkbox type="checkbox" checked={draft.groupIds.includes(g.id)} onChange={(e) => setDraft({ ...draft,groupIds: e.target.checked ? [...draft.groupIds,g.id] : draft.groupIds.filter((id) => id !== g.id) })} />{g.name}</label>)}</fieldset>
        <label><Checkbox type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft,enabled: e.target.checked })} />启用</label>
        <button className="button primary" disabled={busy}>保存计划</button>
      </form> : null}
    </EditDrawer>
    <ConfirmDialog open={remove !== null} title="删除计划" description={`删除 ${remove?.name ?? ''}？已有订阅记录的计划请停用`} confirmLabel="删除" danger busy={busy} onClose={() => setRemove(null)} onConfirm={() => { void deleteSelected() }} />
  </div>
}
