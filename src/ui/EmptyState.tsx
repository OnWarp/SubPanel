import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type EmptyStateProps = {
  icon?: LucideIcon
  title: string
  description?: ReactNode
  children?: ReactNode
}

export function EmptyState({ icon: Icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="sp-empty">
      {Icon ? <span className="sp-empty-icon" aria-hidden="true"><Icon size={22} /></span> : null}
      <p className="sp-empty-title">{title}</p>
      {description ? <p className="sp-empty-description">{description}</p> : null}
      {children ? <div className="sp-empty-actions">{children}</div> : null}
    </div>
  )
}
