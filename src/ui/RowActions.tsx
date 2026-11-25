import { Ellipsis } from 'lucide-react'
import { useId, useRef } from 'react'
import { Button } from './Button'

export type RowAction = {
  label: string
  accessibleLabel?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  onClick: (trigger: HTMLButtonElement | null) => void
}

export function RowActions({ actions, label = '更多操作' }: { actions: readonly RowAction[]; label?: string }) {
  const id = useId()
  const popup = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  const unavailable = actions.every((action) => action.disabled)

  return (
    <>
      <Button ref={trigger} size="page" className="resource-card-more" aria-label={label} title={label} popoverTarget={unavailable ? undefined : id} aria-disabled={unavailable || undefined}>
        <Ellipsis aria-hidden="true" size={18} />
      </Button>
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
              trigger.current?.focus()
              onClick(trigger.current)
            }}
          >{label}{checked !== undefined && <span aria-hidden="true">{checked ? ' ✓' : ''}</span>}</button>
        ))}
      </div>
    </>
  )
}
