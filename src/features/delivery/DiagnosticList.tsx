import type { SubscriptionDiagnostic } from '../../app/api'
import { diagnosticDescription } from './diagnostics'

type DiagnosticListProps = {
  items: SubscriptionDiagnostic['diagnostics']
}

export function DiagnosticList({ items }: DiagnosticListProps) {
  return (
    <ul className="diagnostic-items">
      {items.map((item, index) => (
        <li key={`${item.nodeId}-${index}`}>
          <strong>{item.nodeName ?? item.nodeId}</strong>
          <span>{diagnosticDescription(item)}</span>
          {item.fields?.length ? <code>{item.fields.join('、')}</code> : null}
        </li>
      ))}
    </ul>
  )
}
