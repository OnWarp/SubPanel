import type { ReactNode } from 'react'

export function PageContainer({ width = 'list', children }: {
  width?: 'list' | 'detail' | 'form'
  children: ReactNode
}) {
  return <div className="content-scope content-page" data-width={width}>{children}</div>
}
