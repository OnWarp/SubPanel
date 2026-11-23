import { Link } from 'react-router-dom'
import { useEffect } from 'react'
import type { SubscriptionDiagnostic } from '../../app/api'
import { diagnosticDescription } from './diagnostics'

type DiagnosticListProps = {
  href?: string
  highlight?: string
  items: SubscriptionDiagnostic['diagnostics']
}

export function DiagnosticList({ items, href, highlight }: DiagnosticListProps) {
  useEffect(() => {
    if (highlight) document.getElementById(highlight)?.focus()
  }, [highlight, items])
  return (
    <ul className="diagnostic-items del-diagnostic-items">
      {items.map((item, index) => {
        const id = `node-diagnostic-${item.nodeId}-${index}`
        return <li key={id} id={highlight ? id : undefined} tabIndex={highlight === id ? -1 : undefined}>
          <strong>{item.nodeName ?? item.nodeId}</strong>
          <span>{diagnosticDescription(item)}</span>
          {item.fields?.length ? <code>{item.fields.join('、')}</code> : null}
          {href && <Link to={`${href}#${encodeURIComponent(id)}`}>查看诊断</Link>}
        </li>
      })}
    </ul>
  )
}
