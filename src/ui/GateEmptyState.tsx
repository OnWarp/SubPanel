import type { ReactNode } from 'react'

type GateEmptyStateProps = { icon: ReactNode; message: ReactNode; action?: ReactNode }

export function GateEmptyState({ icon, message, action }: GateEmptyStateProps) {
  return <div className="sp-gate-empty"><span className="sp-gate-empty-icon" aria-hidden="true">{icon}</span><p>{message}</p>{action}</div>
}
