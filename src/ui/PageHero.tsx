import type { ReactNode } from 'react'

type PageHeroProps = { title: ReactNode; id?: string; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }

export function PageHero({ title, id, subtitle, actions, children }: PageHeroProps) {
  return <header className="sp-page-hero"><div className="sp-page-hero-heading"><div><h1 id={id}>{title}</h1>{subtitle != null ? <p>{subtitle}</p> : null}</div>{actions != null ? <div className="sp-page-hero-actions">{actions}</div> : null}</div>{children}</header>
}
