import type { ReactNode } from 'react'

type FilterBarProps = {
  children: ReactNode
  className?: string
}

export function FilterBar({ children, className }: FilterBarProps) {
  return <div className={`sp-filter-bar${className ? ` ${className}` : ''}`}>{children}</div>
}
