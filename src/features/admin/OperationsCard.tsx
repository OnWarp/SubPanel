import { DataHeader } from '../../ui/DataHeader'
import { useId, type PropsWithChildren, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PaginationProps } from '../../ui/Pagination'
import '../../styles/pages-admin-ops.css'

export function OperationsHeading({ title, action }: { title?: string; action?: ReactNode }) {
  return <DataHeader title={title} actions={action} />
}

export function OperationsFooter({ total, unit = '条', pagination }: { total: number; unit?: string; pagination?: PaginationProps }) {
  const pageCount = Math.max(1, pagination?.pageCount ?? 1)
  const page = Math.max(1, Math.min(pageCount, pagination?.page ?? 1))
  return (
    <footer className="ops-footer">
      <span>共 {total} {unit}</span>
      {pagination && <nav className="sp-pagination" aria-label="分页">
        <button type="button" className="sp-pagination-step" aria-label="上一页" disabled={page === 1} onClick={() => pagination.onPageChange(page - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
        <span>{page} / {pageCount} 页</span>
        <button type="button" className="sp-pagination-step" aria-label="下一页" disabled={page === pageCount} onClick={() => pagination.onPageChange(page + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
      </nav>}
    </footer>
  )
}

export function OperationsActions({ label, children }: PropsWithChildren<{ label: string }>) {
  const id = useId()
  return (
    <>
      <button type="button" className="button ghost ops-overflow" popoverTarget={id} aria-label={label}>•••</button>
      <div id={id} popover="auto" className="ops-action-popover" onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button, a')) {
          event.currentTarget.hidePopover()
        }
      }}>{children}</div>
    </>
  )
}
