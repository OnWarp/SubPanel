import { Link, matchPath, useLocation } from 'react-router-dom'

export function SectionTabs({ label, tabs, preserveSearch }: {
  label: string
  tabs: ReadonlyArray<{ to: string; label: string; includeChildren?: boolean }>
  preserveSearch?: boolean
}) {
  const { pathname, search } = useLocation()
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map(tab => {
        const active = matchPath({ path: tab.to, end: !tab.includeChildren }, pathname)
        return (
          <Link key={tab.to} to={tab.to + (preserveSearch ? search : '')} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
