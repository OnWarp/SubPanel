import { useEffect, useRef, useState } from 'react'
import { api, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { FormSelect, Input } from '../../ui/Controls'
import type { Plan } from './plan-types'
import { Dialog } from '../../ui/Dialog'
import { StatusMessage } from '../../ui/StatusMessage'

const path = '/api/admin/compile-jobs'
export type BatchOperation =
  | { action: 'assign' | 'renew' | 'pause' | 'revoke'; templateId: string; days?: number }
  | { action: 'enable' | 'disable' }
  | { action: 'plan'; planId: string }
  | { action: 'binding'; templateBinding: { mode: 'inherit' | 'base' } | { mode: 'specific'; templateId: string } }
type BatchInput = { ids: string[]; operation: BatchOperation }
type Preview = {
  previewId: string; fingerprint: string; selected: number; affected: number; missing: number
  platforms: string[]
  changes?: { userId: string; errorCode?: string; changes?: { before: { expires_at: number | null } | null; after: { expires_at: number | null; status: string } }[] }[]
}
type Job = {
  id: string; action: BatchOperation['action'] | 'copy' | null; total: number; processed: number; failures: number
  status: 'queued' | 'running' | 'failed' | 'cancelled' | 'completed'; busy: number
  errorCode: string | null
}
type Item = { id: string; outcome: 'applied' | 'failed' | null; errorCode: string | null; copyId: string | null }
const label = { assign: '绑定模板', renew: '续期授权', pause: '暂停授权', revoke: '撤销授权', copy: '已停用的批量操作', enable: '启用订阅', disable: '停用订阅', plan: '更换计划', binding: '更换配置' }
const status = { queued: '待执行', running: '执行中', failed: '有失败', cancelled: '已取消', completed: '已完成' }

type Props = {
  request: BatchInput | null
  choosingPlan: boolean
  plans: Plan[]
  onPreviewPlan: (planId: string) => void
  onClear: () => void
  historyOpen: boolean
  onCloseHistory: () => void
  onChanged: () => void
  platforms: Record<string, string>
}

export function SubscriptionBatchJobs({ request, choosingPlan, plans, onPreviewPlan, onClear, historyOpen, onCloseHistory, onChanged, platforms }: Props) {
  const [unified, setUnified] = useState(false)
  const [userIds, setUserIds] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [action, setAction] = useState<'assign' | 'renew' | 'pause' | 'revoke'>('assign')
  const [days, setDays] = useState('')
  const [planId, setPlanId] = useState('')
  const choosingTarget = choosingPlan && !request
  const [review, setReview] = useState<{ input: BatchInput; preview: Preview } | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const advancing = useRef(false)
  useEffect(() => () => { advancing.current = false }, [])
  const [error, setError] = useState('')
  const loadJobs = async () => setJobs((await api<{ jobs: Job[] }>(`${path}?kind=subscription-batch`)).jobs)
  const showError = (cause: unknown) => setError(cause instanceof Error ? cause.message : '请求失败，请重试')

  useEffect(() => {
    if (!request) return
    const abort = new AbortController()
    setError('')
    setReview(null)
    void api<Preview>(`${path}/batch/preview`, { method: 'POST', body: jsonBody(request), signal: abort.signal })
      .then(preview => { if (!abort.signal.aborted) setReview({ input: request, preview }) })
      .catch(cause => { if (!abort.signal.aborted) showError(cause) })
    return () => abort.abort()
  }, [request])

  useEffect(() => {
    if (!historyOpen || job || review) return
    void Promise.all([loadJobs(), api<{ unified: boolean }>(`${path}/batch/capabilities`)
      .then(result => setUnified(result.unified))]).catch(showError)
  }, [historyOpen, job, review])

  const perform = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await work() } catch (cause) { showError(cause) } finally { setBusy(false) }
  }
  const confirm = () => {
    if (busy) return
    if (choosingTarget) {
      if (planId) onPreviewPlan(planId)
      return
    }
    if (!review) return
    void perform(async () => {
      const { previewId, fingerprint } = review.preview
      const { job: queued } = await api<{ job: Job }>(`${path}/batch`, {
        method: 'POST', body: jsonBody({ ...review.input, previewId, fingerprint }),
      })
      onClear()
      setPlanId('')
      setReview(null)
      setItems([])
      setJob(queued)
    })
  }
  const viewJob = async (id: string) => {
    const [details, outcomes] = await Promise.all([
      api<{ job: Job }>(`${path}/${id}`),
      api<{ items: Item[] }>(`${path}/${id}/items`),
    ])
    setJob(details.job)
    setItems(outcomes.items)
  }
  const advance = (operation: 'run' | 'cancel') => {
    if (!job) return
    void perform(async () => {
      advancing.current = operation === 'run'
      try {
        let updated: Job
        do {
          const response = await api<{ job: Job }>(`${path}/${job.id}/${operation}`, { method: 'POST' })
          updated = response.job
          setJob(updated)
        } while (advancing.current && updated.status === 'running' && !updated.busy)
      } finally {
        advancing.current = false
        onChanged()
        await viewJob(job.id)
      }
    })
  }
  const retry = () => {
    if (!job) return
    void perform(async () => {
      const { input, ...preview } = await api<Preview & { input: BatchInput }>(`${path}/${job.id}/retry`, { method: 'POST' })
      setJob(null)
      setReview({ input, preview })
    })
  }
  const close = () => {
    setJob(null)
    setError('')
    onCloseHistory()
  }

  return <>
    <Dialog size="xl" open={(historyOpen || job !== null) && !review && !request && !choosingPlan} title="订阅批量任务" onClose={close} busy={busy}>
      <section aria-label="任务进度">
        <div className="form-stack">
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
          {job ? <>
            <p role="status">{job.action && label[job.action]} · {status[job.status]} · 已处理 {job.processed}/{job.total} · 失败 {job.failures}</p>
            {job.errorCode && <StatusMessage tone="error">{job.action === 'copy' ? job.errorCode : `${job.errorCode} · 可重新预览未完成项`}</StatusMessage>}
            <div className="data-header-actions">
              {(job.status === 'queued' || job.status === 'running') ? <>
                {job.action !== 'copy' && <button className="button primary" type="button" disabled={busy || Boolean(job.busy)} onClick={() => advance('run')}>执行任务</button>}
                {busy && job.action !== 'copy' && <button className="button secondary" type="button" onClick={() => { advancing.current = false }}>处理完本页后暂停</button>}
                <button className="button secondary" type="button" disabled={busy} onClick={() => advance('cancel')}>取消剩余项目</button>
              </> : job.action !== 'copy' && (job.status === 'cancelled' || job.status === 'failed') && job.processed - job.failures < job.total &&
                <button className="button primary" type="button" disabled={busy} onClick={retry}>重新预览未完成项</button>}
              <button className="button secondary" type="button" disabled={busy} onClick={() => void perform(() => viewJob(job.id))}>刷新进度</button>
            </div>
            {items.some(item => item.errorCode || item.copyId) && <ul>{items.filter(item => item.errorCode || item.copyId).map(item =>
              <li key={item.id}>{item.id} · {item.copyId ? `新订阅 ${item.copyId}` : item.errorCode}</li>,
            )}</ul>}
          </> : <>
            {unified && <form className="form-stack" onSubmit={event => {
              event.preventDefault()
              void perform(async () => {
                const input: BatchInput = { ids: userIds.trim().split(/[\s,，]+/u), operation: {
                  action, templateId: templateId.trim(), ...((action === 'assign' || action === 'renew') && days ? { days: Number(days) } : {}),
                } }
                const preview = await api<Preview>(`${path}/batch/preview`, { method: 'POST', body: jsonBody(input) })
                setReview({ input, preview })
              })
            }}>
              <Input aria-label="用户编号" placeholder="用户编号，逗号分隔" value={userIds} required onChange={event => setUserIds(event.currentTarget.value)} />
              <Input aria-label="授权模板编号" placeholder="授权模板编号" value={templateId} required onChange={event => setTemplateId(event.currentTarget.value)} />
              <FormSelect aria-label="授权操作" value={action} onChange={event => setAction(event.currentTarget.value as typeof action)}>
                {(['assign', 'renew', 'pause', 'revoke'] as const).map(value => <option key={value} value={value}>{label[value]}</option>)}
              </FormSelect>
              {(action === 'assign' || action === 'renew') && <Input aria-label="授权天数" placeholder="默认时长" type="number"
                min={1} max={36500} value={days} onChange={event => setDays(event.currentTarget.value)} />}
              <button className="button primary" disabled={busy}>预览授权</button>
            </form>}
            <button className="button secondary" type="button" disabled={busy} onClick={() => void perform(loadJobs)}>刷新任务</button>
            {jobs.length === 0 && <p>暂无订阅批量任务</p>}
            {jobs.map(item => <button className="button secondary" type="button" key={item.id} disabled={busy}
              onClick={() => void perform(() => viewJob(item.id))}>
              {item.action && label[item.action]} · {status[item.status]} · {item.processed}/{item.total}
            </button>)}
          </>}
        </div>
      </section>
    </Dialog>
    <ConfirmDialog open={Boolean(choosingPlan || request || review)}
      size={choosingPlan ? 'm' : 's'} dirty={choosingTarget && !!planId}
      title={choosingPlan ? '更换计划' : review ? label[review.input.operation.action] : '批量影响预览'}
      description={choosingTarget ? '选中的订阅将改用同一计划' : review ? `已选 ${review.preview.selected} 个 · 预计影响 ${review.preview.affected} 个 · ${review.preview.missing} 个已不存在` : error ? '可关闭后重新预览' : '正在读取所选订阅的影响范围'}
      confirmLabel={choosingTarget ? '预览影响' : '确认并创建任务'} confirmDisabled={choosingTarget ? !planId : !review} busy={busy} onConfirm={confirm}
      onClose={() => { setPlanId(''); setReview(null); setError(''); onClear() }}>
      {choosingTarget && <FormSelect aria-label="目标计划" value={planId} onChange={(event) => setPlanId(event.currentTarget.value)}>
        <option value="">选择计划</option>
        {plans.filter((plan) => plan.enabled).map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
      </FormSelect>}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {review?.preview.changes && <ul>{review.preview.changes.map(item =>
        <li key={item.userId}>{item.userId} · {item.errorCode ?? item.changes?.map(({ before, after }) => {
          const date = (value: number | null) => value === null ? '永久' : new Date(value).toLocaleDateString()
          return `${before ? date(before.expires_at) : '无授权'} → ${date(after.expires_at)}`
        }).join('、')}</li>)}</ul>}
      {review && <div>
        <p>{review.preview.platforms.length
          ? `可能失效的平台产物：${review.preview.platforms.map(id => platforms[id]).join('、')}`
          : '预计无平台产物失效'}</p>
        {review.input.operation.action === 'binding' && <p>sing-box 独立绑定优先于共享配置</p>}
        {review.input.operation.action === 'plan' && <p>会应用目标计划的分组权限和额度，保留订阅已有有效期</p>}
      </div>}
    </ConfirmDialog>
  </>
}
