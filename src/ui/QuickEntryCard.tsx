import { ArrowUpRight, ChevronRight } from 'lucide-react'
import type { MouseEventHandler, ReactNode } from 'react'

type QuickEntryCardProps = {
  icon: ReactNode
  title: ReactNode
  desc: string
} & ({ href: string; onClick?: MouseEventHandler<HTMLAnchorElement> } | { href?: undefined; onClick: MouseEventHandler<HTMLButtonElement> })

export function QuickEntryCard({ icon, title, desc, href, onClick }: QuickEntryCardProps) {
  const content = <><span className="sp-quick-entry-icon" aria-hidden="true">{icon}</span><span className="sp-quick-entry-text"><strong>{title}</strong><span title={desc}>{desc}</span></span>{href ? <ArrowUpRight className="sp-quick-entry-arrow" size={16} aria-hidden="true" /> : <ChevronRight className="sp-quick-entry-arrow" size={16} aria-hidden="true" />}</>
  return href !== undefined ? <a className="sp-quick-entry" href={href} onClick={onClick as MouseEventHandler<HTMLAnchorElement>}>{content}</a> : <button type="button" className="sp-quick-entry" onClick={onClick as MouseEventHandler<HTMLButtonElement>}>{content}</button>
}
