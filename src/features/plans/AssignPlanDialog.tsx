import { useEffect, useState } from 'react'
import { api, jsonBody, type AdminUsersResponse, type UserSummary } from '../../app/api'
import { FormSelect, Input, Textarea } from '../../ui/Controls'
import { Dialog } from '../../ui/Dialog'
import { FormField } from '../../ui/FormField'
import { SearchInput } from '../../ui/SearchInput'
import { StatusMessage } from '../../ui/StatusMessage'
import { DAY_SECONDS, errorText, type PlanDefinition } from './model'

type Target = { id: string; label: string }
type DurationMode = 'inherit' | 'custom' | 'permanent'
type RowResult = { ok: boolean; message: string }

export function AssignPlanDialog({
  targets, fixedPlanId, onClose, onAssigned,
}: {
  targets: Target[]
  fixedPlanId?: string
  onClose: () => void
  onAssigned: () => void
}) {
  const [plans, setPlans] = useState<PlanDefinition[]>([])
  const [planId, setPlanId] = useState(fixedPlanId ?? '')
  const [mode, setMode] = useState<DurationMode>('inherit')
  const [days, setDays] = useState('30')
  const [note, setNote] = useState('')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<UserSummary[]>([])
  const [picked, setPicked] = useState<Target[]>([])
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = targets.length ? targets : picked
  const targetKey = targets.map((target) => target.id).join('\0')

  useEffect(() => {
    const ids = targetKey ? targetKey.split('\0') : []
    setKeys((current) => {
      const next = { ...current }
      for (const id of ids) if (!next[id]) next[id] = crypto.randomUUID()
      return next
    })
  }, [targetKey])

  useEffect(() => {
    if (fixedPlanId) return
    const controller = new AbortController()
    void api<{ plans: PlanDefinition[] }>('/api/admin/plans?limit=200&status=enabled', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setPlans(result.plans) })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause, '加载套餐失败')) })
    return () => controller.abort()
  }, [fixedPlanId])

  useEffect(() => {
    if (targets.length) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: '1', pageSize: '20', deleted: 'active' })
      if (query.trim()) params.set('q', query.trim())
      void api<AdminUsersResponse>(`/api/admin/users?${params}`, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setFound(result.users) })
        .catch(() => { if (!controller.signal.aborted) setFound([]) })
    }, 250)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query, targets.length])

  const addUser = (user: UserSummary) => {
    setPicked((current) => current.some((item) => item.id === user.id) ? current : [...current, { id: user.id, label: user.username }])
    setKeys((current) => current[user.id] ? current : { ...current, [user.id]: crypto.randomUUID() })
  }

  const submit = async () => {
    const pending = chosen.filter((target) => !results[target.id]?.ok)
    const customDays = Number(days)
    if (!planId) {
      setError('请选择套餐')
      return
    }
    if (!pending.length) return
    if (mode === 'custom' && (!Number.isInteger(customDays) || customDays <= 0)) {
      setError('请填写大于 0 的天数')
      return
    }
    setBusy(true)
    setError('')
    let failed = false
    for (const target of pending) {
      const body: Record<string, unknown> = {
        planId, durationMode: mode, idempotencyKey: keys[target.id] ?? crypto.randomUUID(), remark: note.trim() || null,
      }
      if (mode === 'custom') body.durationSeconds = customDays * DAY_SECONDS
      try {
        await api(`/api/admin/users/${encodeURIComponent(target.id)}/plans`, { method: 'POST', body: jsonBody(body) })
        setResults((current) => ({ ...current, [target.id]: { ok: true, message: '已分配' } }))
      } catch (cause) {
        failed = true
        setResults((current) => ({ ...current, [target.id]: { ok: false, message: errorText(cause, '分配失败') } }))
      }
    }
    setBusy(false)
    onAssigned()
    if (!failed) onClose()
  }

  return (
    <Dialog
      appearance="content"
      open
      size="l"
      busy={busy}
      dirty={note !== '' || picked.length > 0 || (!fixedPlanId && planId !== '') || mode !== 'inherit' || days !== '30'}
      title="分配套餐"
      onClose={onClose}
      footer={(cancel) => <>
        <button className="button secondary" type="button" disabled={busy} onClick={cancel}>关闭</button>
        <button className="button primary" type="button" disabled={busy || !chosen.length} onClick={() => void submit()}>{busy ? '分配中' : '分配套餐'}</button>
      </>}
    >
      <div className="form-stack">
        {fixedPlanId ? null : (
          <FormField label="套餐">
            <FormSelect aria-label="选择套餐" value={planId} onChange={(event) => setPlanId(event.currentTarget.value)}>
              <option value="">选择套餐</option>
              {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
            </FormSelect>
          </FormField>
        )}
        <FormField label="时长" hintTip="沿用套餐默认时长，或为这一次分配单独指定天数。再次分配会新建一条实例">
          <FormSelect aria-label="分配时长" value={mode} onChange={(event) => setMode(event.currentTarget.value as DurationMode)}>
            <option value="inherit">套餐默认时长</option>
            <option value="custom">自定义天数</option>
            <option value="permanent">永久</option>
          </FormSelect>
          {mode === 'custom' ? <Input aria-label="分配天数" inputMode="numeric" value={days} onChange={(event) => setDays(event.currentTarget.value)} /> : null}
        </FormField>
        <FormField label="备注" htmlFor="assign-note">
          <Textarea id="assign-note" aria-label="分配备注" value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.currentTarget.value)} />
        </FormField>
        {targets.length ? <p>将分配给 {targets.map((target) => target.label).join('、')}</p> : (
          <FormField label="用户">
            <SearchInput label="搜索用户" placeholder="搜索用户名或邮箱" value={query} onChange={setQuery} />
            <div className="choice-list" aria-label="搜索结果">
              {found.map((user) => (
                <button key={user.id} className="button ghost" type="button" onClick={() => addUser(user)}>{user.username}</button>
              ))}
              {!found.length ? <p className="dialog-note">暂无匹配用户</p> : null}
            </div>
          </FormField>
        )}
        {chosen.length ? (
          <ul aria-label="分配结果">
            {chosen.map((target) => (
              <li key={target.id}>{target.label}{results[target.id] ? ` · ${results[target.id].message}` : ''}</li>
            ))}
          </ul>
        ) : null}
        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      </div>
    </Dialog>
  )
}
