import { formatExpiryTime } from './expiry'
import type { SubscriptionNode } from './unified-subscription'

export function SubscriptionDetailRows({ expiresAt, permanent, nodes }: {
  expiresAt: string | null
  permanent: boolean
  nodes: SubscriptionNode[]
}) {
  return <dl className="key-value-rows">
    <div><dt>最远到期</dt><dd>{permanent ? '长期有效' : expiresAt ? formatExpiryTime(Date.parse(expiresAt)) : '—'}</dd></div>
    <div><dt>聚合节点</dt><dd>{nodes.length}</dd></div>
  </dl>
}
