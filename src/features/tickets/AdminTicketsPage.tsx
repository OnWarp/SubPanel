import { OperationsActions, OperationsFooter, OperationsHeading } from '../admin/OperationsCard'
import { FormSelect } from '../../ui/Controls'
import { MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError } from '../../app/api'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { formatTicketTime, levelLabel, ticketState, ticketTime, type Ticket } from './types'

const PAGE_SIZE = 20
type StatusFilter = 'all' | 'open' | 'closed'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function AdminTicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (statusFilter !== 'all') params.set('status', statusFilter)
    try {
      const result = await api<{ tickets: Ticket[], total: number }>(`/api/admin/tickets?${params.toString()}`)
      setTickets(result.tickets)
      setTotal(result.total)
    } catch (cause) {
      setTickets([])
      setTotal(0)
      setLoadError(errorMessage(cause, '加载工单队列失败'))
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const changeStatus = (next: StatusFilter) => {
    setStatusFilter(next)
    setPage(1)
  }

  const columns: Array<DataTableColumn<Ticket>> = [
    {
      key: 'title',
      header: '标题',
      render: (ticket) => <div><Link className="tk-title-link ops-main" to={`/delivery/tickets/${ticket.id}`}>{ticket.title}</Link><span className="ops-meta">{ticket.username}</span></div>,
    },
    {
      key: 'level',
      header: '等级',
      render: (ticket) => {
        const label = levelLabel(ticket.level)
        return <StatusBadge tone={label.tone} size="sm">{label.label}</StatusBadge>
      },
    },
    {
      key: 'state',
      header: '状态',
      render: (ticket) => {
        const state = ticketState(ticket)
        return <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
      },
    },
    {
      key: 'lastReply',
      header: '最后回复',
      render: (ticket) => ticket.lastReplyBy === 'admin' ? '管理员' : ticket.lastReplyBy === 'user' ? '用户' : '-',
    },
    {
      key: 'time',
      header: '时间',
      render: (ticket) => <span className="tk-cell-time">{formatTicketTime(ticketTime(ticket))}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (ticket) => (
        <OperationsActions label={`工单操作 ${ticket.title}`}>
          <Link className="button ghost" to={`/delivery/tickets/${ticket.id}`}>查看工单</Link>
        </OperationsActions>
      ),
    },
  ]

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="page-stack tk-page ops-page">
      <PageHeader title="工单" />
      <section className="data-section" aria-label="工单">
        <OperationsHeading title="工单" />
        <div className="page-toolbar ops-filters">
          <FormSelect aria-label="工单状态" value={statusFilter} onChange={(event) => changeStatus(event.currentTarget.value as StatusFilter)}>
            <option value="all">全部状态</option>
            <option value="open">处理中</option>
            <option value="closed">已关闭</option>
          </FormSelect>
        </div>
        {loading && tickets.length === 0 ? <LoadingState label="正在加载工单队列" /> : null}
        {!loading && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {!loading && !loadError ? (
          <>
            {total === 0
              ? <EmptyState icon={MessageSquare} title="暂无工单" description={statusFilter === 'all' ? '用户提交的工单会显示在这里' : '当前筛选下没有工单'} />
              : <DataTable columns={columns} rows={tickets} rowKey={(ticket) => ticket.id} empty="暂无匹配工单" />}
            <OperationsFooter total={total} pagination={{ page, pageCount, onPageChange: setPage }} />
          </>
        ) : null}
      </section>
    </div>
  )
}
