import { FormSelect, Textarea } from '../../ui/Controls'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, peekApi, watchApi, jsonBody } from '../../app/api'
import { EditDrawer } from '../../ui/EditDrawer'
import { FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'
import { subscriptionPlanLabels, type SubscriptionPlanState, type Plan } from './plan-types'
export function UserSubscriptionPlan({ userId, username, showSummary = true, active = false, onActiveChange, onSave }: { userId: string; username: string; showSummary?: boolean; active?: boolean; onActiveChange?: (active: boolean) => void; onSave?: () => void }) {
  const path = `/api/admin/users/${userId}/subscription-plan`
  const [rights, setRights] = useState(() => peekApi<SubscriptionPlanState>(path) ?? null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState('grant')
  const [planId, setPlanId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { await watchApi<SubscriptionPlanState>(path, setRights); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载订阅计划失败') }
  }, [path])
  useEffect(() => { if (showSummary) void load() }, [load, showSummary])
  const edit = async () => {
    setOpen(true); setNote(''); setError('')
    try {
      const current = rights ?? await api<SubscriptionPlanState>(`/api/admin/users/${userId}/subscription-plan`)
      if (!rights) setRights(current)
      setAction(current.latest?.status === 'active' ? 'renew' : 'grant')
      const result = await api<{ plans: Plan[] }>('/api/admin/plans')
      setPlans(result.plans)
      setPlanId(result.plans.find((p) => p.enabled)?.id ?? '')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载计划失败') }
  }
  const editRef = useRef(edit)
  editRef.current = edit
  useEffect(() => {
    if (!active) return
    void editRef.current()
  }, [active, userId])
  const dismiss = () => { setOpen(false); onActiveChange?.(false) }
  const save = async () => {
    if (busy) return
    setBusy(true)
    try { setRights(await api<SubscriptionPlanState>(`/api/admin/users/${userId}/subscription-plan`,{ method: 'POST',body: jsonBody({ action,planId: planId || undefined,note }) })); setError(''); onSave?.(); dismiss() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }
  return <div>
    {showSummary ? <>
      {rights ? <><strong>{rights.latest?.plan.name ?? '—'}</strong><div>{subscriptionPlanLabels[rights.state]}</div>{rights.latest ? <small>{(rights.latest.expiresAt ? new Date(rights.latest.expiresAt).toLocaleString() : '永久有效')}</small> : null}</> : error ? <span role="alert">{error}</span> : <span>加载中</span>}
      <button className="button ghost" type="button" onClick={() => { void edit() }}>管理订阅计划</button>
    </> : null}
    <EditDrawer open={open} title={`${username} · 订阅计划`} onClose={dismiss} busy={busy}>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void save() }}>
        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
        {rights?.latest ? <p>{rights.latest.plan.name} · {(rights.latest.expiresAt ? new Date(rights.latest.expiresAt).toLocaleString() : '永久有效')} · {subscriptionPlanLabels[rights.state]}</p> : null}
        {rights?.latest ? <dl className="key-value-rows">
          <div><dt>流量额度</dt><dd>{rights.latest.plan.trafficGb ? `${rights.latest.plan.trafficGb} GB` : '不限'} · 配额定义／未强制执行</dd></div>
          <div><dt>限速</dt><dd>{rights.latest.plan.speedLimitMbps ? `${rights.latest.plan.speedLimitMbps} Mbps` : '不限'}</dd></div>
          <div><dt>设备数</dt><dd>{rights.latest.plan.deviceLimit || '不限'} · 配额定义／未强制执行</dd></div>
        </dl> : null}
        <FormField label="操作" htmlFor={`action-${userId}`}><FormSelect id={`action-${userId}`} value={action} onChange={(e) => setAction(e.target.value)}>{rights?.latest?.status === 'active' ? <><option value="renew">续期</option><option value="switch">换计划</option><option value="revoke">收回</option></> : <option value="grant">开通</option>}</FormSelect></FormField>
        {action === 'grant' || action === 'switch' ? <FormField label="计划" htmlFor={`plan-${userId}`}><FormSelect required id={`plan-${userId}`} value={planId} onChange={(e) => setPlanId(e.target.value)}><option value="">选择计划</option>{plans.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.durationDays} 天</option>)}</FormSelect></FormField> : null}
        <FormField label="备注" htmlFor={`note-${userId}`}><Textarea id={`note-${userId}`} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
        <p>{action === 'renew' ? '从当前到期日与现在的较晚时间起叠加计划天数。' : action === 'switch' ? '此订阅将立即使用新计划。' : action === 'revoke' ? '收回后订阅将返回空内容。' : '计划立即生效。'}</p>
        <button className={`button ${action === 'revoke' ? 'danger-fill' : 'primary'}`} disabled={busy}>确认{action === 'renew' ? '续期' : action === 'switch' ? '换计划' : action === 'revoke' ? '收回' : '开通'}</button>
      </form>
    </EditDrawer>
  </div>
}
