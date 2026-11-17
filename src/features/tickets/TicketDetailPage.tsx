import { Textarea } from '../../ui/Controls'
import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { StatusMessage } from '../../ui/StatusMessage'
import { TicketThread } from './TicketThread'
import type { Ticket, TicketReply, TicketThreadData } from './types'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function TicketDetailPage() {
  const { id = '' } = useParams()
  const [thread, setThread] = useState<TicketThreadData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [closeOpen, setCloseOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setThread(await api<TicketThreadData>(`/api/tickets/${id}`))
    } catch (cause) {
      setThread(null)
      setLoadError(errorMessage(cause, '加载工单失败'))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const submitReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = reply.trim()
    if (!body || busy) return
    setBusy(true)
    setActionError('')
    try {
      const result = await api<{ ticket: Ticket, reply: TicketReply }>(`/api/tickets/${id}/replies`, {
        method: 'POST',
        body: jsonBody({ body }),
      })
      setThread((current) => current ? { ticket: result.ticket, replies: [...current.replies, result.reply] } : current)
      setReply('')
    } catch (cause) {
      setActionError(errorMessage(cause, '发送回复失败'))
    } finally {
      setBusy(false)
    }
  }

  const closeTicket = async () => {
    if (busy) return
    setBusy(true)
    setActionError('')
    try {
      const result = await api<{ ticket: Ticket }>(`/api/tickets/${id}/close`, { method: 'POST', body: '{}' })
      setThread((current) => current ? { ...current, ticket: result.ticket } : current)
      setCloseOpen(false)
    } catch (cause) {
      setActionError(errorMessage(cause, '关闭工单失败'))
    } finally {
      setBusy(false)
    }
  }

  const ticket = thread?.ticket ?? null
  const closed = ticket?.status === 'closed'

  return (
    <div className="page-stack tk-page tk-detail">
      <PageHero subtitle="查看工单处理进度"
        title={ticket?.title ?? '工单详情'}
        actions={(
          <span className="tk-head-actions">
            <Link className="button ghost" to="/tickets"><ArrowLeft aria-hidden="true" size={16} />返回列表</Link>
            {ticket && !closed ? (
              <button className="button secondary" type="button" disabled={busy} onClick={() => setCloseOpen(true)}>关闭工单</button>
            ) : null}
          </span>
        )}
      />

      {loading && !thread ? <LoadingState label="正在加载工单" /> : null}
      {!loading && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {actionError ? <StatusMessage tone="error">{actionError}</StatusMessage> : null}

      {thread ? (
        <>
          <TicketThread ticket={thread.ticket} replies={thread.replies} viewerRole="user" />
          <section className="data-section tk-composer" aria-label="回复工单">
            {closed ? (
              <p className="tk-closed-hint">工单已关闭，如需继续请新建工单</p>
            ) : (
              <form className="tk-form" onSubmit={submitReply}>
                <FormField label="追加回复" htmlFor="tk-reply-body">
                  <Textarea
                    id="tk-reply-body"
                    rows={4}
                    maxLength={5_000}
                    placeholder="补充说明或回应管理员"
                    value={reply}
                    disabled={busy}
                    onChange={(event) => setReply(event.currentTarget.value)}
                  />
                </FormField>
                <div className="tk-form-actions">
                  <button className="button primary" type="submit" disabled={busy || reply.trim() === ''}>{busy ? '发送中' : '发送回复'}</button>
                </div>
              </form>
            )}
          </section>
        </>
      ) : null}

      <ConfirmDialog
        open={closeOpen}
        title="关闭工单"
        description="关闭后不能再回复，如需继续请新建工单；管理员回复已关闭的工单会自动重开"
        confirmLabel="关闭工单"
        danger
        busy={busy}
        onClose={() => setCloseOpen(false)}
        onConfirm={() => { closeTicket().catch(() => undefined) }}
      />
    </div>
  )
}
