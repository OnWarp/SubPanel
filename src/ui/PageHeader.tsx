import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PageHeaderSlots } from './page-header-slots'

type PageHeaderProps = {
  title: string
  id?: string
  actions?: ReactNode
  description?: ReactNode
  showDescription?: boolean
  placement?: 'workspace' | 'inline'
}

export function PageHeader({ title, id, actions, description, showDescription = false, placement = 'workspace' }: PageHeaderProps) {
  const slots = useContext(PageHeaderSlots)
  const heading = (
    <div className="topbar-page-title">
      <h1 id={id}>{title}</h1>
      {showDescription && description ? <p>{description}</p> : null}
    </div>
  )
  if (placement === 'inline' || !slots) {
    return <header className="page-header">{heading}{actions && <div className="page-header-actions">{actions}</div>}</header>
  }

  if (!slots.title || !slots.actions) return null
  return <>{createPortal(heading, slots.title)}{actions ? createPortal(actions, slots.actions) : null}</>
}
