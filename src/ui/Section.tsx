import { useId, type ReactNode } from 'react'
import { SectionHeading } from './DataHeader'

export function Section({ title, actions, children }: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="content-section" aria-labelledby={id}>
      <SectionHeading id={id} title={title} actions={actions} />
      {children}
    </section>
  )
}
