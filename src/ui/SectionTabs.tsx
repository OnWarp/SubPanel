import { Link, useLocation } from 'react-router-dom'
import { matchesSectionTab, type SectionTab } from '../app/navigation'

export function SectionTabs({ label, tabs, preserveSearch, variant, activeTo }: {
  label: string
  tabs: ReadonlyArray<SectionTab>
  preserveSearch?: boolean
  variant?: 'module' | 'detail'
  /** Pass the selected destination for routes that differ only by query string. */
  activeTo?: string
}) {
  const { pathname, search } = useLocation()
  return (
    <nav className="section-tabs" data-variant={variant} aria-label={label}>
      {tabs.map(tab => {
        const active = activeTo === undefined ? matchesSectionTab(tab, pathname) : activeTo === tab.to
        return (
          <Link key={tab.to} to={tab.to + (preserveSearch ? search : '')} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}

type ContentTabsProps = Omit<Parameters<typeof SectionTabs>[0], 'variant'>

export function ModuleTabs(props: ContentTabsProps) {
  return <SectionTabs {...props} variant="module" />
}

export function DetailTabs(props: ContentTabsProps) {
  return <SectionTabs {...props} variant="detail" />
}
