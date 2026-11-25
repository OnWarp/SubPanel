import { DataHeader } from '../../ui/DataHeader'
import type { ReactNode } from 'react'
import { Checkbox } from '../../ui/Controls'
import { Pagination, type PaginationProps } from '../../ui/Pagination'
import './resource-card.css'

export function ResourceHeading({ id, title, action }: { id: string; title: string; action?: ReactNode }) {
  return (
    <header>
      <DataHeader id={id} title={title} actions={action} />
    </header>
  )
}

export function ResourceFooter({ count, unit, pagination, children }: {
  count: number
  unit: string
  pagination?: PaginationProps
  children?: ReactNode
}) {
  return (
    <footer className="resource-card-footer">
      <span>共 {count} {unit}</span>
      {(pagination || children) && <div className="resource-card-footer-controls">
        {children}
        {pagination && <Pagination {...pagination} compact />}
      </div>}
    </footer>
  )
}

export function ResourceSelectAll({ label, ids, selected, disabled, onChange }: {
  label: string
  ids: string[]
  selected: ReadonlySet<string>
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const count = ids.filter((id) => selected.has(id)).length
  const checked = ids.length > 0 && count === ids.length
  return (
    <label className="resource-card-select-all">
      <Checkbox
        ref={(input) => { if (input) input.indeterminate = count > 0 && !checked }}
        aria-label={label}
        checked={checked}
        disabled={disabled || ids.length === 0}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export { RowActions as ResourceRowActions } from '../../ui/RowActions'
