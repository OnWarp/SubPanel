import { Ellipsis } from 'lucide-react'
import { useId, useRef, type ReactNode } from 'react'
import { Checkbox } from '../../ui/Controls'
import { Pagination, type PaginationProps } from '../../ui/Pagination'
import './resource-card.css'

export function ResourceHeading({ id, title, action }: { id: string; title: string; action?: ReactNode }) {
  return (
    <header className="resource-card-heading">
      <h1 id={id}>{title}</h1>
      {action}
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
      <div className="resource-card-footer-controls">
        {children}
        {pagination
          ? <Pagination {...pagination} compact />
          : <span>1 / 1 页</span>}
      </div>
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

type RowAction = {
  label: string
  accessibleLabel?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  onClick: () => void
}

export function ResourceRowActions({ actions }: { actions: RowAction[] }) {
  const id = useId()
  const popup = useRef<HTMLDivElement>(null)

  return (
    <>
      <button className="icon-button resource-card-more" type="button" aria-label="更多操作" popoverTarget={id} disabled={actions.every((action) => action.disabled)}>
        <Ellipsis aria-hidden="true" size={18} />
      </button>
      <div className="resource-card-actions" id={id} ref={popup} popover="auto" role="group" aria-label="行操作">
        {actions.map(({ label, accessibleLabel, danger, disabled, checked, onClick }) => (
          <button
            className={danger ? 'resource-card-action-danger' : undefined}
            key={label}
            type="button"
            aria-label={accessibleLabel}
            aria-pressed={checked}
            disabled={disabled}
            onClick={() => {
              popup.current?.hidePopover()
              onClick()
            }}
          >{label}{checked !== undefined && <span aria-hidden="true">{checked ? ' ✓' : ''}</span>}</button>
        ))}
      </div>
    </>
  )
}
