import { useMemo, useState, type ReactNode } from 'react'
import { PageHeaderSlots } from './page-header-slots'

export function PageFrame({ path, leadingTools, tools, account, tabs, footer, children }: {
  path: string
  leadingTools?: ReactNode
  tools?: ReactNode
  account?: ReactNode
  tabs?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const [title, setTitle] = useState<HTMLDivElement | null>(null)
  const [actions, setActions] = useState<HTMLDivElement | null>(null)
  const slots = useMemo(() => ({ title, actions }), [title, actions])

  return (
    <PageHeaderSlots value={slots}>
      <div className="workspace">
        <header className="workspace-topbar">
          {leadingTools}
          <div ref={setTitle} id="page-title-slot" className="topbar-context" />
          {tools}
          <div ref={setActions} id="page-actions-slot" className="topbar-page-actions" />
          {account}
        </header>
        <main key={path} className="workspace-content">
          {tabs}
          {children}
        </main>
        {footer}
      </div>
    </PageHeaderSlots>
  )
}
