import { Link, useLocation } from 'react-router-dom'
import { matchesSectionTab, type SectionTab } from '../app/navigation'

export function SectionTabs({ label, tabs, preserveSearch }: {
  label: string
  tabs: ReadonlyArray<SectionTab>
  preserveSearch?: boolean
}) {
  const { pathname, search } = useLocation()
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map(tab => {
        const active = matchesSectionTab(tab, pathname)
        return (
          <Link key={tab.to} to={tab.to + (preserveSearch ? search : '')} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
