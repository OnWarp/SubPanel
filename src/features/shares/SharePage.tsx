import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiClientError } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { useSession } from '../../app/session'
import { AuthLayout } from '../accounts/AuthLayout'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { StatusMessage } from '../../ui/StatusMessage'
import {
  SHARE_CLIENTS,
  downloadShareExport,
  exportShareLink,
  getShareMeta,
  verifyShare,
  type ShareClientId,
  type ShareMeta,
} from './api'
import {
  buildShareExportUrl,
  clearShareReturn,
  formatRemaining,
  formatShareTime,
  isShareToken,
  rememberShareReturn,
} from './share-link'

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready', meta: ShareMeta }
  | { kind: 'password' }
  | { kind: 'login' }
  | { kind: 'unavailable' }
  | { kind: 'limited' }
  | { kind: 'error', message: string }

type Feedback = { tone: 'error' | 'success' | 'warning', text: string }

function phaseFromMetaError(cause: unknown): Phase {
  if (!(cause instanceof ApiClientError)) return { kind: 'error', message: '无法连接服务，请稍后重试' }
  if (cause.status === 404) return { kind: 'password' }
  if (cause.status === 401) return cause.code === 'AUTH_REQUIRED' ? { kind: 'login' } : { kind: 'password' }
  if (cause.status === 429) return { kind: 'limited' }
  return { kind: 'error', message: cause.message }
}

function titleFor(phase: Phase): string {
  if (phase.kind === 'ready') return phase.meta.subscriptionName ?? '分享'
  if (phase.kind === 'password') return '访问验证'
  if (phase.kind === 'login') return '需要登录'
  if (phase.kind === 'unavailable') return '链接不可用'
  if (phase.kind === 'limited') return '请稍后再试'
  return '分享'
}

export function SharePage() {
  const params = useParams()
  const token = params.token ?? ''
  const navigate = useNavigate()
  const { user, loading: sessionLoading } = useSession()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [originalBlocked, setOriginalBlocked] = useState(false)
  const [manualOriginal, setManualOriginal] = useState('')
  const [pendingAction, setPendingAction] = useState('')

  const load = useCallback(async () => {
    if (!isShareToken(token)) {
      setPhase({ kind: 'unavailable' })
      return
    }
    setPhase({ kind: 'loading' })
    try {
      const result = await getShareMeta(token)
      setPhase({ kind: 'ready', meta: result.meta })
    } catch (cause) {
      setPhase(phaseFromMetaError(cause))
    }
  }, [token])

  useEffect(() => { clearShareReturn() }, [])

  useEffect(() => {
    setOriginalBlocked(false)
    setManualOriginal('')
    setFeedback(null)
    setFormError('')
    load().catch(() => undefined)
  }, [load])

  const metaAlive = async () => {
    try {
      const result = await getShareMeta(token)
      setPhase({ kind: 'ready', meta: result.meta })
      return true
    } catch (cause) {
      setPhase(phaseFromMetaError(cause))
      return false
    }
  }

  const noteExportError = async (cause: unknown) => {
    if (!(cause instanceof ApiClientError)) {
      setFeedback({ tone: 'error', text: '无法连接服务，请稍后重试' })
      return
    }
    if (cause.status === 404) {
      const alive = await metaAlive()
      if (!alive) return
      setFeedback({ tone: 'error', text: '链接不可用' })
      return
    }
    if (cause.status === 401) {
      setFormError('需要验证')
      setFeedback(null)
      setPhase(cause.code === 'AUTH_REQUIRED' ? { kind: 'login' } : { kind: 'password' })
      return
    }
    if (cause.status === 429) {
      setFeedback({ tone: 'error', text: '尝试过多，请稍后再试' })
      return
    }
    setFeedback({ tone: 'error', text: cause.message })
  }

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting || !isShareToken(token)) return
    const form = event.currentTarget
    const password = String(new FormData(form).get('password') ?? '')
    if (password === '') return
    setSubmitting(true)
    setFormError('')
    try {
      await verifyShare(token, password)
      form.reset()
      await load()
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        if (cause.status === 429) {
          setPhase({ kind: 'limited' })
          return
        }
        if (cause.code === 'AUTH_REQUIRED') {
          setPhase({ kind: 'login' })
          return
        }
        if (cause.status === 401 && cause.code === 'SHARE_PASSWORD_INVALID') {
          setFormError('密码错误')
          return
        }
        if (cause.status === 404 || cause.code === 'SHARE_PASSWORD_NOT_REQUIRED') {
          setPhase({ kind: 'unavailable' })
          return
        }
        setFormError(cause.message)
        return
      }
      setFormError('无法连接服务，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  const goLogin = () => {
    rememberShareReturn(token)
    navigate('/login')
  }

  const copySubscriptionLink = async () => {
    if (!isShareToken(token)) return
    setPendingAction('link')
    setFeedback(null)
    setManualOriginal('')
    try {
      const result = await exportShareLink(token)
      try {
        await copyToClipboard(result.link)
        setFeedback({ tone: 'success', text: '订阅链接已复制' })
      } catch {
        setManualOriginal(result.link)
        setFeedback({ tone: 'error', text: '浏览器未允许复制，请手动选择内容' })
      }
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 404) {
        const alive = await metaAlive()
        if (alive) {
          setOriginalBlocked(true)
          setFeedback({ tone: 'error', text: '链接不可用' })
        }
        return
      }
      await noteExportError(cause)
    } finally {
      setPendingAction('')
    }
  }

  const copyClientLink = async (client: ShareClientId, label: string) => {
    try {
      await copyToClipboard(buildShareExportUrl(token, client))
      setFeedback({ tone: 'success', text: `${label} 链接已复制` })
    } catch {
      setFeedback({ tone: 'error', text: '浏览器未允许复制，请手动选择内容' })
    }
  }

  const openClient = async (client: ShareClientId) => {
    setPendingAction(client)
    setFeedback(null)
    try {
      await downloadShareExport(token, client)
      setFeedback({ tone: 'success', text: '已开始下载' })
    } catch (cause) {
      await noteExportError(cause)
    } finally {
      setPendingAction('')
    }
  }

  const title = titleFor(phase)

  return (
    <AuthLayout title={title}>
      <div className="sh-public">
        {phase.kind === 'loading' ? <LoadingState label="正在加载" /> : null}
        {phase.kind === 'error' ? <ErrorState message={phase.message} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {phase.kind === 'password' ? (
          <form className="form-stack" onSubmit={(event) => { submitPassword(event).catch(() => undefined) }}>
            <FormField label="访问密码" htmlFor="share-access-password">
              <input id="share-access-password" name="password" type="password" autoComplete="off" maxLength={128} required />
            </FormField>
            {formError ? <StatusMessage tone="error">{formError}</StatusMessage> : null}
            <button className="button primary" type="submit" disabled={submitting}>{submitting ? '正在验证' : '验证'}</button>
            {!sessionLoading && !user ? <button className="button secondary" type="button" onClick={goLogin}>登录后查看</button> : null}
          </form>
        ) : null}
        {phase.kind === 'login' ? (
          <>
            <p>此链接需要登录后查看</p>
            {formError ? <StatusMessage tone="error">{formError}</StatusMessage> : null}
            {user ? <button className="button primary" type="button" onClick={() => { load().catch(() => undefined) }}>重试</button> : <button className="button primary" type="button" onClick={goLogin}>去登录</button>}
          </>
        ) : null}
        {phase.kind === 'limited' ? <p>尝试过多，请稍后再试</p> : null}
        {phase.kind === 'ready' ? (
          <ReadyShare
            meta={phase.meta}
            feedback={feedback}
            originalBlocked={originalBlocked}
            manualOriginal={manualOriginal}
            pendingAction={pendingAction}
            onCopyLink={() => { copySubscriptionLink().catch(() => undefined) }}
            onCopyClient={(client, label) => { copyClientLink(client, label).catch(() => undefined) }}
            onOpenClient={(client) => { openClient(client).catch(() => undefined) }}
          />
        ) : null}
      </div>
    </AuthLayout>
  )
}

function ReadyShare({ meta, feedback, originalBlocked, manualOriginal, pendingAction, onCopyLink, onCopyClient, onOpenClient }: {
  meta: ShareMeta
  feedback: Feedback | null
  originalBlocked: boolean
  manualOriginal: string
  pendingAction: string
  onCopyLink: () => void
  onCopyClient: (client: ShareClientId, label: string) => void
  onOpenClient: (client: ShareClientId) => void
}) {
  const remaining = meta.expiresAt ? formatRemaining(meta.expiresAt) : ''
  return (
    <>
      <dl className="sh-meta">
        {meta.groupNames ? <div><dt>分组</dt><dd>{meta.groupNames.length ? meta.groupNames.join('、') : '无'}</dd></div> : null}
        {meta.expiresAt ? <div><dt>到期</dt><dd>{formatShareTime(meta.expiresAt)}{remaining ? ` · ${remaining}` : ''}</dd></div> : null}
        <div><dt>节点</dt><dd>{meta.nodeCount} 个</dd></div>
      </dl>
      {meta.nodeNames && meta.nodeNames.length > 0 ? (
        <ul className="sh-nodes">
          {meta.nodeNames.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}
        </ul>
      ) : null}
      {originalBlocked ? null : (
        <button className="button primary" type="button" onClick={onCopyLink} disabled={pendingAction !== ''}>
          {pendingAction === 'link' ? '正在复制' : '复制订阅链接'}
        </button>
      )}
      {manualOriginal ? (
        <div className="sh-manual">
          <input aria-label="订阅链接" value={manualOriginal} readOnly />
        </div>
      ) : null}
      {feedback ? <StatusMessage tone={feedback.tone}>{feedback.text}</StatusMessage> : null}
      <section className="sh-clients" aria-labelledby="share-clients-title">
        <h2 id="share-clients-title">客户端导入</h2>
        {SHARE_CLIENTS.map((item) => (
          <div className="sh-client" key={item.client}>
            <span>{item.label}</span>
            <div className="sh-client-actions">
              <button className="button secondary" type="button" disabled={pendingAction !== ''} aria-label={`复制 ${item.label} 链接`} onClick={() => onCopyClient(item.client, item.label)}>复制</button>
              <button className="button secondary" type="button" disabled={pendingAction !== ''} aria-label={`打开 ${item.label} 链接`} onClick={() => onOpenClient(item.client)}>
                {pendingAction === item.client ? '正在打开' : '打开'}
              </button>
            </div>
          </div>
        ))}
      </section>
    </>
  )
}
