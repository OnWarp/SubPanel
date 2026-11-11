import type { ReactNode } from 'react'

type FilterChipProps = {
  active: boolean
  onClick: () => void
  children: ReactNode
}

export function FilterChip({ active, onClick, children }: FilterChipProps) {
  return (
    <button
      type="button"
      className={`sp-chip${active ? ' sp-chip-active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
