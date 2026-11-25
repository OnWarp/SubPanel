import { OperationsActions } from '../admin/OperationsCard'
import { FormSelect } from '../../ui/Controls'
import { FilterBar } from '../../ui/FilterBar'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { adminDomains } from '../../app/navigation'
import { peekApi, watchApi, ApiClientError } from '../../app/api'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
import { ModuleTabs } from '../../ui/SectionTabs'
import { StatusBadge } from '../../ui/StatusBadge'
import { formatTicketTime, levelLabel, ticketState, ticketTime, type Ticket } from './types'

const PAGE_SIZE = 20
const opsNav = adminDomains.find((domain) => domain.to === '/delivery/tickets')?.section
type StatusFilter = 'all' | 'open' | 'closed'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function readStatus(value: string | null): StatusFilter {
  return value === 'open' || value === 'closed' ? value : 'all'
}

function readPage(value: string | null): number {
  const page = Number.parseInt(value ?? '', 10)
  return Number.isInteger(page) && page > 0 ? page : 1
}

export function AdminTicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const statusFilter = readStatus(searchParams.get('status'))
  const page = readPage(searchParams.get('page'))
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
  if (statusFilter !== 'all') params.set('status', statusFilter)
  const path = `/api/admin/tickets?${params}`
  type Result = { tickets: Ticket[]; total: number }
  const [tickets, setTickets] = useState<Ticket[]>(() => peekApi<Result>(path)?.tickets ?? [])
  const [total, setTotal] = useState(() => peekApi<Result>(path)?.total ?? 0)
  const [loading, setLoading] = useState(() => peekApi(path) === undefined)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoading(peekApi(path) === undefined)
    setLoadError('')
    try {
      await watchApi<Result>(path, (result) => {
        setTickets(result.tickets)
        setTotal(result.total)
      })
    } catch (cause) {
      setTickets([])
      setTotal(0)
      setLoadError(errorMessage(cause, '加载工单队列失败'))
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const writeQuery = (nextStatus: StatusFilter, nextPage: number) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (nextStatus === 'all') next.delete('status')
      else next.set('status', nextStatus)
      if (nextPage > 1) next.set('page', String(nextPage))
      else next.delete('page')
      return next
    })
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
  ]

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <PageContainer width="list">
      <PageHeader title="工单" />
      {opsNav ? <ModuleTabs {...opsNav} /> : null}
      <FilterBar>
        <label className="filter-field">
          <span>工单状态</span>
          <FormSelect id="ticket-status-filter" aria-label="工单状态" value={statusFilter} onChange={(event) => writeQuery(event.currentTarget.value as StatusFilter, 1)}>
            <option value="all">全部状态</option>
            <option value="open">处理中</option>
            <option value="closed">已关闭</option>
          </FormSelect>
        </label>
      </FilterBar>
      {loading && tickets.length === 0 ? <LoadingState label="正在加载工单队列" /> : null}
      {!loading && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !loadError ? (
        <DataTable
          columns={columns}
          rows={tickets}
          rowKey={(ticket) => ticket.id}
          empty={statusFilter === 'all' ? '暂无工单' : '暂无匹配工单'}
          rowActions={(ticket) => (
            <OperationsActions label={`工单操作 ${ticket.title}`}>
              <Link className="button ghost" to={`/delivery/tickets/${ticket.id}`}>查看工单</Link>
            </OperationsActions>
          )}
          summary={`共 ${total} 条`}
          pagination={{ compact: true, page, pageCount, onPageChange: (nextPage) => writeQuery(statusFilter, nextPage) }}
        />
      ) : null}
    </PageContainer>
  )
}
