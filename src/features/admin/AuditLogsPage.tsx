import { useCallback, useEffect, useState } from 'react'
import { api } from '../../app/api'
import { DateTimeInput, Input } from '../../ui/Controls'
import { DataTable } from '../../ui/DataTable'
import { ErrorState } from '../../ui/ErrorState'
import { PageHeader } from '../../ui/PageHeader'
import { OperationsFooter, OperationsHeading } from './OperationsCard'

type Log = {
  id: string
  actor_user_id: string
  action: string
  target_type: string
  target_id: string | null
  created_at: string
  detail: string
}

export function AuditLogsPage() {
  const [logs, setLogs] = useState<Log[]>([])
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({ pageCount: 1, total: 0 })
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const query = new URLSearchParams({
        page: String(page), pageSize: '20', action, actor,
        ...(from ? { from: new Date(from).toISOString() } : {}),
        ...(to ? { to: new Date(to).toISOString() } : {}),
      })
      const result = await api<{ logs: Log[]; pagination: typeof pagination }>(`/api/admin/audit-logs?${query}`)
      setLogs(result.logs)
      setPagination(result.pagination)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败')
    }
  }, [page, action, actor, from, to])

  useEffect(() => { void load() }, [load])

  return (
    <div className="page-stack ops-page">
      <PageHeader title="审计日志" />
      <section className="ops-card ops-table" aria-label="审计日志">
        <OperationsHeading title="审计日志" />
        <div className="ops-filters">
          <label>操作<Input value={action} onChange={(event) => { setAction(event.target.value); setPage(1) }} /></label>
          <label>管理员 ID<Input value={actor} onChange={(event) => { setActor(event.target.value); setPage(1) }} /></label>
          <label>开始时间<DateTimeInput value={from} onChange={(event) => { setFrom(event.target.value); setPage(1) }} /></label>
          <label>结束时间<DateTimeInput value={to} onChange={(event) => { setTo(event.target.value); setPage(1) }} /></label>
        </div>
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        <DataTable rows={logs} rowKey={(log) => log.id} empty="暂无日志" columns={[
          { key: 'action', header: '操作', render: (log) => <strong className="ops-main">{log.action}<span className="ops-meta">{log.created_at}</span></strong> },
          { key: 'actor_user_id', header: '管理员' },
          { key: 'target_type', header: '目标', render: (log) => <>{log.target_type} / {log.target_id}</> },
          { key: 'detail', header: '详情' },
        ]} />
        <OperationsFooter total={pagination.total} pagination={{ page, pageCount: pagination.pageCount, onPageChange: setPage }} />
      </section>
    </div>
  )
}
