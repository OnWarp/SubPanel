import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type SelectOption = {
  value: string
  label: string
}

type SelectProps = {
  label?: string
  id?: string
  invalid?: boolean
  describedBy?: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
}

export function Select({ label, value, options, onChange, disabled, id, invalid, describedBy }: SelectProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const [active, setActive] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open ])

  useEffect(() => {
    if (open) document.getElementById(`${menuId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, menuId])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className="sp-select" ref={rootRef}>
      <button
        id={id ?? `${menuId}-trigger`}
        role="combobox"
        ref={triggerRef}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-controls={open ? menuId : undefined}
        type="button"
        className="sp-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || options.length === 0}
        onClick={() => { setActive(Math.max(0, options.findIndex((option) => option.value === value))); setOpen((current) => !current) }}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            setOpen(true)
            setActive((current) => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, (open ? current : Math.max(0, options.findIndex((option) => option.value === value))) + (event.key === 'ArrowUp' ? -1 : 1))))
          } else if (open && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            if (options[active]) onChange(options[active].value)
            setOpen(false)
          } else if (event.key === 'Tab' || event.key === 'Escape') setOpen(false)
          else if (event.key.length === 1 && event.key !== ' ') {
            const index = options.findIndex((option) => option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
            if (index >= 0) { event.preventDefault(); setActive(index); setOpen(true) }
          }
        }}
        aria-activedescendant={open ? `${menuId}-${active}` : undefined}
      >
        <span className="sp-select-value">{selected?.label ?? ''}</span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open ? (
        <ul id={menuId} className="sp-select-menu" role="listbox" aria-label={label} aria-labelledby={label ? undefined : (id ?? `${menuId}-trigger`)}>
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${menuId}-${index}`}
              onPointerMove={() => setActive(index)}
              role="option"
              aria-selected={option.value === value}
              className={`sp-select-option${option.value === value || index === active ? ' sp-select-option-active' : ''}`}
              onClick={(event) => {
                event.preventDefault()
                onChange(option.value)
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? <Check aria-hidden="true" size={15} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
