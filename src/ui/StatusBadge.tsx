import type { ReactNode } from 'react'

export type StatusBadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'muted'
export type StatusBadgeSize = 'md' | 'sm' | 'xs'

type StatusBadgeProps = {
  tone: StatusBadgeTone
  size?: StatusBadgeSize
  children: ReactNode
}

export function StatusBadge({ tone, size = 'md', children }: StatusBadgeProps) {
  return (
    <span className={`sp-badge sp-badge-${tone} sp-badge-${size}`}>
      <span className="sp-badge-dot" aria-hidden="true" />
      {children}
    </span>
  )
}
