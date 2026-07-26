import { Ellipsis } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type BatchAction = {
  key: string
  label: string
  icon?: LucideIcon
  tone?: 'default' | 'danger'
  onClick: () => void
}

type BatchToolbarProps = {
  selectedCount: number
  totalCount: number
  onSelectAll: () => void
  onClear: () => void
  actions: BatchAction[]
  busy?: boolean
  progress?: string
}

export function BatchToolbar({
  selectedCount,
  totalCount,
  onSelectAll,
  onClear,
  actions,
  busy = false,
  progress,
}: BatchToolbarProps) {
  if (selectedCount === 0) return null
  return (
    <div className="batch-toolbar" role="toolbar" aria-label="批量操作">
      <strong>已选择 {selectedCount} 项</strong>
      {selectedCount < totalCount ? <button type="button" className="button secondary" onClick={onSelectAll} disabled={busy}>全选当前结果</button> : null}
      <button type="button" className="button secondary" onClick={onClear} disabled={busy}>清除选择</button>
      <span className="batch-actions">
        {actions.map(({ key, label, icon: Icon, tone = 'default', onClick }) => (
          <button key={key} type="button" className={`button ${tone === 'danger' ? 'danger' : 'secondary'}`} onClick={onClick} disabled={busy}>
            {Icon ? <Icon aria-hidden="true" size={16} /> : null}
            {label}
          </button>
        ))}
      </span>
      <details className="batch-more">
        <summary className="icon-button" role="button" aria-label="更多批量操作" title="更多批量操作"><Ellipsis aria-hidden="true" size={16} /></summary>
        <div className="batch-more-menu">
          {actions.map(({ key, label, icon: Icon, tone = 'default', onClick }) => <button key={key} type="button" className={`button ${tone === 'danger' ? 'danger' : 'secondary'}`} onClick={onClick} disabled={busy}>{Icon ? <Icon aria-hidden="true" size={16} /> : null}{label}</button>)}
        </div>
      </details>
      {progress ? <span className="batch-progress" role="status">{progress}</span> : null}
    </div>
  )
}
