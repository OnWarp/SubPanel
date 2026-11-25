import { useLocation } from 'react-router-dom'
import { adminDomainForPath } from '../../app/navigation'
import { ModuleTabs } from '../../ui/SectionTabs'

export function AdminModuleTabs() {
  const { pathname } = useLocation()
  const section = adminDomainForPath(pathname)?.section
  return section ? <ModuleTabs {...section} /> : null
}
