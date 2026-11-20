import type { ReactNode } from 'react'

type PlanCardProps = {
  name: ReactNode
  specs: { key: string; label: ReactNode; value: ReactNode }[]
  highlighted?: boolean
  badge?: ReactNode
  footer?: ReactNode
}

export function PlanCard({ name, specs, highlighted = false, badge, footer }: PlanCardProps) {
  return <section className={`object-card${highlighted ? ' object-card-highlighted' : ''}`}><div className="sp-card-heading"><h2>{name}</h2>{badge != null ? <span className="sp-plan-badge">{badge}</span> : null}</div><dl className="sp-plan-specs">{specs.map(spec => <div key={spec.key}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>)}</dl>{footer != null ? <div className="sp-card-footer">{footer}</div> : null}</section>
}
