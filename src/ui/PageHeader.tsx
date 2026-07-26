import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  const titleTarget = document.getElementById('page-title-slot')
  const actionsTarget = document.getElementById('page-actions-slot')
  if (!titleTarget || !actionsTarget) return null
  return <>{createPortal(<div className="topbar-page-title"><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>, titleTarget)}{actions ? createPortal(actions, actionsTarget) : null}</>
}
