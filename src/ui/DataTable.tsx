import type { ReactNode } from 'react'
import { Pagination, type PaginationProps } from './Pagination'

export type DataTableAlign = 'left' | 'right' | 'center'

export type DataTableColumn<T> = {
  key: string
  header: ReactNode
  headerContent?: ReactNode
  /** Narrow-screen row label. Falls back to a string header. */
  label?: string
  width?: number | string
  align?: DataTableAlign
  render?: (row: T) => ReactNode
}

type DataTableProps<T> = {
  columns: Array<DataTableColumn<T>>
  rows: T[]
  rowKey: (row: T) => string | number
  empty?: ReactNode
  pagination?: PaginationProps
  className?: string
}

function alignClass(align?: DataTableAlign) {
  if (align === 'right') return ' sp-align-right'
  if (align === 'center') return ' sp-align-center'
  return ''
}

function widthStyle(width?: number | string) {
  if (width === undefined) return undefined
  return { width: typeof width === 'number' ? `${width}px` : width }
}

function columnLabel(column: { header: ReactNode; label?: string }) {
  if (column.label) return column.label
  return typeof column.header === 'string' ? column.header : ''
}

export function DataTable<T>({ columns, rows, rowKey, empty, pagination, className }: DataTableProps<T>) {
  return (
    <div className={`sp-table-wrap${className ? ` ${className}` : ''}`}>
      <table className="sp-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={widthStyle(column.width)} className={alignClass(column.align).trim() || undefined}>
                {column.headerContent ?? column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
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
                  <td key={column.key} data-label={columnLabel(column)} className={alignClass(column.align).trim() || undefined}>
                    {content}
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
