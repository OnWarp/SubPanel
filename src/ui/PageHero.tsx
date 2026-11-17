import type { ReactNode } from 'react'

type PageHeroProps = { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }

export function PageHero({ title, subtitle, actions, children }: PageHeroProps) {
  return <header className="sp-page-hero"><div className="sp-page-hero-heading"><div><h1>{title}</h1>{subtitle != null ? <p>{subtitle}</p> : null}</div>{actions != null ? <div className="sp-page-hero-actions">{actions}</div> : null}</div>{children}</header>
}
