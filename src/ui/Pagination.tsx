import { ChevronLeft, ChevronRight } from 'lucide-react'

export type PaginationProps = {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}

type PageItem = number | 'start-gap' | 'end-gap'

function pageItems(page: number, pageCount: number): PageItem[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1)

  const start = Math.max(2, page - 1)
  const end = Math.min(pageCount - 1, page + 1)
  const items: PageItem[] = [1]
  if (start > 2) items.push('start-gap')
  for (let current = start; current <= end; current += 1) items.push(current)
  if (end < pageCount - 1) items.push('end-gap')
  items.push(pageCount)
  return items
}

export function Pagination({ page, pageCount, onPageChange }: PaginationProps) {
  const current = Math.min(Math.max(page, 1), Math.max(pageCount, 1))
  const previous = Math.max(current - 1, 1)
  const next = Math.min(current + 1, Math.max(pageCount, 1))

  return (
    <nav className="sp-pagination" aria-label="分页">
      <button type="button" className="sp-pagination-step" aria-label="上一页" onClick={() => onPageChange(previous)} disabled={current <= 1}>
        <ChevronLeft aria-hidden="true" size={16} />
      </button>
      {pageItems(current, pageCount).map((item) => typeof item === 'number'
        ? <button key={item} type="button" className="sp-pagination-page" aria-current={item === current ? 'page' : undefined} onClick={() => onPageChange(item)}>{item}</button>
        : <span key={item} className="sp-pagination-gap" aria-hidden="true">…</span>)}
      <button type="button" className="sp-pagination-step" aria-label="下一页" onClick={() => onPageChange(next)} disabled={current >= pageCount}>
        <ChevronRight aria-hidden="true" size={16} />
      </button>
    </nav>
  )
}
