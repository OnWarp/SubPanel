import type { ReactNode } from 'react'

type StatusPillProps = { tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; children: ReactNode }

export function StatusPill({ tone, children }: StatusPillProps) {
  return <span className={`sp-status-pill sp-status-pill-${tone}`}>{children}</span>
}
