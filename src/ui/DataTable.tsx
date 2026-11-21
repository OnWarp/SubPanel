import type { ReactNode } from 'react'
import { Pagination, type PaginationProps } from './Pagination'

export type DataTableAlign = 'left' | 'right' | 'center'

export type DataTableColumn<T> = {
  key: string
  header: ReactNode
  headerContent?: ReactNode
  /** Narrow-screen row label. Falls back to a string header. */
  label?: string
  hideBelow?: 'desktop' | 'tablet'
  sortDirection?: 'ascending' | 'descending' | 'none'
  width?: number | string
  align?: DataTableAlign
  render?: (row: T) => ReactNode
}

type DataTableProps<T> = {
  columns: Array<DataTableColumn<T>>
  rows: T[]
  rowKey: (row: T) => string | number
  empty?: ReactNode
  loadingLabel?: string
  pagination?: PaginationProps
  flat?: boolean
  className?: string
}

function alignClass(align?: DataTableAlign) {
  if (align === 'right') return ' sp-align-right'
  if (align === 'center') return ' sp-align-center'
  return ''
}

function columnClass(column: Pick<DataTableColumn<unknown>, 'align' | 'hideBelow'>) {
  return [alignClass(column.align).trim(), column.hideBelow && `sp-column-${column.hideBelow}`].filter(Boolean).join(' ') || undefined
}

function widthStyle(width?: number | string) {
  if (width === undefined) return undefined
  return { width: typeof width === 'number' ? `${width}px` : width }
}

function columnLabel(column: { header: ReactNode; label?: string }) {
  if (column.label) return column.label
  return typeof column.header === 'string' ? column.header : ''
}

export function DataTable<T>({ columns, rows, rowKey, empty, loadingLabel, pagination, flat = false, className }: DataTableProps<T>) {
  return (
    <div className={`sp-table-wrap${flat ? ' sp-table-flat' : ''}${className ? ` ${className}` : ''}`}>
      {loadingLabel && <span className="sp-table-loading-label" role="status">{loadingLabel}</span>}
      <table className="sp-table" aria-busy={loadingLabel ? true : undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={widthStyle(column.width)} aria-sort={column.sortDirection} className={columnClass(column)}>
                {column.headerContent ?? column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loadingLabel ? [0, 1, 2].map((index) => (
            <tr key={index} aria-hidden="true">
              {columns.map((column) => (
                <td key={column.key} className={columnClass(column)}><span className="sp-table-placeholder" /></td>
              ))}
            </tr>
          )) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="empty-row">{empty ?? '暂无数据'}</td>
            </tr>
          ) : rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => {
                const content = column.render
                  ? column.render(row)
                  : (row as Record<string, unknown>)[column.key] as ReactNode
                return (
                  <td key={column.key} data-label={columnLabel(column)} className={columnClass(column)}>
                    {content == null || content === '' ? '—' : content}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {pagination ? <div className="sp-table-pagination"><Pagination {...pagination} /></div> : null}
    </div>
  )
}
