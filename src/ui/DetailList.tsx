import type { ReactNode } from 'react'

type DetailItem = {
  id: string
  label: ReactNode
  value: ReactNode
}

export function DetailList({ items, variant = 'detail' }: {
  items: readonly DetailItem[]
  variant?: 'detail' | 'summary'
}) {
  return (
    <dl className="content-detail-list" data-variant={variant}>
      {items.map(({ id, label, value }) => (
        <div key={id}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function StatGroup({ items }: { items: readonly DetailItem[] }) {
  return <DetailList items={items} variant="summary" />
}
