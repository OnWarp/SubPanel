import type { ReactNode } from 'react'

export function DataHeader({ id, title, filters, actions }: { id?: string; title: string; filters?: ReactNode; actions?: ReactNode }) {
  return <div className="section-heading data-header">
    <div className="data-header-main"><h2 id={id}>{title}</h2>{filters}</div>
    <div className="data-header-actions">{actions}</div>
  </div>
}
