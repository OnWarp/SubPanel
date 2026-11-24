import { useEffect, useRef, useState } from 'react'
import { api, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { StatusMessage } from '../../ui/StatusMessage'

const path = '/api/admin/compile-jobs'
export type BatchOperation =
  | { action: 'copy' | 'enable' | 'disable' }
  | { action: 'plan'; planId: string }
  | { action: 'binding'; templateBinding: { mode: 'inherit' | 'base' } | { mode: 'specific'; templateId: string } }
type BatchInput = { ids: string[]; operation: BatchOperation }
type Preview = {
  previewId: string; fingerprint: string; selected: number; affected: number; missing: number
  platforms: string[]; generatedPlatforms: string[]
}
type Job = {
  id: string; action: BatchOperation['action'] | null; total: number; processed: number; failures: number
  status: 'queued' | 'running' | 'failed' | 'cancelled' | 'completed'; busy: number
  errorCode: string | null
}
type Item = { id: string; outcome: 'applied' | 'failed' | null; errorCode: string | null; copyId: string | null }
const label = { copy: '复制订阅', enable: '启用订阅', disable: '停用订阅', plan: '更换计划', binding: '更换配置' }
const status = { queued: '待执行', running: '执行中', failed: '有失败', cancelled: '已取消', completed: '已完成' }

type Props = {
  request: BatchInput | null
  onClear: () => void
  historyOpen: boolean
  onCloseHistory: () => void
  onChanged: () => void
  platforms: Record<string, string>
}

export function SubscriptionBatchJobs({ request, onClear, historyOpen, onCloseHistory, onChanged, platforms }: Props) {
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
    void loadJobs().catch(showError)
  }, [historyOpen, job, review])

  const perform = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await work() } catch (cause) { showError(cause) } finally { setBusy(false) }
  }
  const confirm = () => {
    if (!review) return
    void perform(async () => {
      const { previewId, fingerprint } = review.preview
      const { job: queued } = await api<{ job: Job }>(`${path}/batch`, {
        method: 'POST', body: jsonBody({ ...review.input, previewId, fingerprint }),
      })
      onClear()
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
    <EditDrawer open={(historyOpen || job !== null) && !review && !request} title="订阅批量任务" onClose={close} busy={busy}>
      <section aria-label="任务进度">
        <div className="form-stack">
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
          {job ? <>
            <p role="status">{job.action && label[job.action]} · {status[job.status]} · 已处理 {job.processed}/{job.total} · 失败 {job.failures}</p>
            {job.errorCode && <StatusMessage tone="error">{`${job.errorCode} · 可重新预览未完成项`}</StatusMessage>}
            <div className="data-header-actions">
              {(job.status === 'queued' || job.status === 'running') ? <>
                <button className="button primary" type="button" disabled={busy || Boolean(job.busy)} onClick={() => advance('run')}>执行任务</button>
                {busy && <button className="button secondary" type="button" onClick={() => { advancing.current = false }}>处理完本页后暂停</button>}
                <button className="button secondary" type="button" disabled={busy} onClick={() => advance('cancel')}>取消剩余项目</button>
              </> : (job.status === 'cancelled' || job.status === 'failed') && job.processed - job.failures < job.total &&
                <button className="button primary" type="button" disabled={busy} onClick={retry}>重新预览未完成项</button>}
              <button className="button secondary" type="button" disabled={busy} onClick={() => void perform(() => viewJob(job.id))}>刷新进度</button>
            </div>
            {items.some(item => item.errorCode || item.copyId) && <ul>{items.filter(item => item.errorCode || item.copyId).map(item =>
              <li key={item.id}>{item.id} · {item.copyId ? `新订阅 ${item.copyId}` : item.errorCode}</li>,
            )}</ul>}
          </> : <>
            <button className="button secondary" type="button" disabled={busy} onClick={() => void perform(loadJobs)}>刷新任务</button>
            {jobs.length === 0 && <p>暂无订阅批量任务</p>}
            {jobs.map(item => <button className="button secondary" type="button" key={item.id} disabled={busy}
              onClick={() => void perform(() => viewJob(item.id))}>
              {item.action && label[item.action]} · {status[item.status]} · {item.processed}/{item.total}
            </button>)}
          </>}
        </div>
      </section>
    </EditDrawer>
    <ConfirmDialog open={Boolean(request || review)} title={review ? label[review.input.operation.action] : '批量影响预览'}
      description={review ? `已选 ${review.preview.selected} 个 · 预计影响 ${review.preview.affected} 个 · ${review.preview.missing} 个已不存在` : error ? '可关闭后重新预览' : '正在读取所选订阅的影响范围'}
      confirmLabel="确认并创建任务" confirmDisabled={!review} busy={busy} onConfirm={confirm}
      onClose={() => { setReview(null); setError(''); onClear() }}>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {review && <div>
        <p>{review.preview.platforms.length
          ? `可能失效的平台产物：${review.preview.platforms.map(id => platforms[id]).join('、')}`
          : review.input.operation.action === 'copy' ? '现有平台产物保留，副本使用新令牌' : '预计无平台产物失效'}</p>
        {review.preview.generatedPlatforms.length > 0 &&
          <p>副本平台：{review.preview.generatedPlatforms.map(id => platforms[id]).join('、')}</p>}
        {review.input.operation.action === 'binding' && <p>sing-box 独立绑定优先于共享配置</p>}
        {review.input.operation.action === 'plan' && <p>会应用目标计划的分组权限和额度，保留订阅已有有效期</p>}
      </div>}
    </ConfirmDialog>
  </>
}
