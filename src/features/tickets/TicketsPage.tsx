import { Input, Textarea } from '../../ui/Controls'
import { Plus, Ticket as TicketIcon } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, peekApi, watchApi, ApiClientError, jsonBody } from '../../app/api'
import { StatusPill } from '../../ui/StatusPill'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { formatTicketTime, levelLabel, ticketState, ticketTime, type Ticket } from './types'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

const ticketColumns: Array<DataTableColumn<Ticket>> = [
  {
    key: 'title',
    header: '标题',
    render: (ticket) => <Link className="tk-title-link" to={`/tickets/${ticket.id}`}>{ticket.title}</Link>,
  },
  {
    key: 'level',
    header: '等级',
    render: (ticket) => {
      const level = levelLabel(ticket.level)
      return <StatusBadge tone={level.tone} size="sm">{level.label}</StatusBadge>
    },
  },
  {
    key: 'state',
    header: '状态',
    render: (ticket) => {
      const state = ticketState(ticket)
      return <StatusPill tone={state.tone === 'muted' ? 'neutral' : state.tone}>{state.label}</StatusPill>
    },
  },
  {
    key: 'lastReply',
    header: '最后回复',
    render: (ticket) => ticket.lastReplyBy === 'admin' ? '管理员' : ticket.lastReplyBy === 'user' ? '我' : '暂无回复',
  },
  {
    key: 'time',
    header: '时间',
    render: (ticket) => <time dateTime={ticketTime(ticket)}>{formatTicketTime(ticketTime(ticket))}</time>,
  },
]

export function TicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>(() => peekApi<{ tickets: Ticket[] }>('/api/tickets')?.tickets ?? [])
  const [loading, setLoading] = useState(() => peekApi<{ tickets: Ticket[] }>('/api/tickets') === undefined)
  const [loadError, setLoadError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [level, setLevel] = useState<'0' | '1'>('0')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    setLoading(peekApi<{ tickets: Ticket[] }>('/api/tickets') === undefined)
    setLoadError('')
    try {
      await watchApi<{ tickets: Ticket[] }>('/api/tickets', (result) => {
        setTickets(result.tickets)
      })
    } catch (cause) {
      setTickets([])
      setLoadError(errorMessage(cause, '加载工单失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const openCreate = () => {
    setTitle('')
    setBody('')
    setLevel('0')
    setFormError('')
    setCreateOpen(true)
  }

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setFormError('')
    setBusy(true)
    try {
      const result = await api<{ ticket: Ticket }>('/api/tickets', {
        method: 'POST',
        body: jsonBody({ title: title.trim(), body: body.trim(), level: level === '1' ? 1 : 0 }),
      })
      setCreateOpen(false)
      navigate(`/tickets/${result.ticket.id}`)
    } catch (cause) {
      setFormError(errorMessage(cause, '提交工单失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer width="list">
      <PageHeader
        title="工单"
        actions={<button className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />新建工单</button>}
      />

      {loading && tickets.length === 0 ? <LoadingState label="正在加载工单" /> : null}
      {!loading && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !loadError && tickets.length === 0 ? (
        <EmptyState icon={TicketIcon} title="暂无工单">
          <button className="button primary" type="button" onClick={openCreate}>新建工单</button>
        </EmptyState>
      ) : null}
      {!loading && !loadError && tickets.length > 0 ? (
        <DataTable
          columns={ticketColumns}
          rows={tickets}
          rowKey={(ticket) => ticket.id}
          empty="暂无工单"
        />
      ) : null}

      <Dialog
        open={createOpen}
        appearance="content"
        busy={busy}
        onClose={() => setCreateOpen(false)}
        title="新建工单"
        footer={(requestClose) => (
          <>
            <button className="button ghost" type="button" disabled={busy} onClick={requestClose}>取消</button>
            <button className="button primary" type="submit" form="tk-create-form" disabled={busy}>{busy ? '提交中' : '提交工单'}</button>
          </>
        )}
      >
        <form id="tk-create-form" className="tk-form" onSubmit={create} noValidate>
          {formError ? <StatusMessage tone="error">{formError}</StatusMessage> : null}
          <FormField label="标题" htmlFor="tk-create-title">
            <Input
              id="tk-create-title"
              type="text"
              maxLength={120}
              required
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </FormField>
          <FormField label="等级">
            <SegmentedControl
              label="工单等级"
              value={level}
              options={[{ value: '0', label: '普通' }, { value: '1', label: '优先' }]}
              onChange={setLevel}
            />
          </FormField>
          <FormField label="正文" htmlFor="tk-create-body">
            <Textarea
              id="tk-create-body"
              rows={7}
              maxLength={5_000}
              required
              placeholder="请描述遇到的问题、发生时间和已尝试的处理"
              value={body}
              disabled={busy}
              onChange={(event) => setBody(event.currentTarget.value)}
            />
          </FormField>
        </form>
      </Dialog>
    </PageContainer>
  )
}
