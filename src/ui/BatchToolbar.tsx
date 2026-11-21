import { Ellipsis, type LucideIcon } from 'lucide-react'
import { useId, useRef } from 'react'

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
  compact?: boolean
}

export function BatchToolbar({
  selectedCount,
  totalCount,
  onSelectAll,
  onClear,
  actions,
  busy = false,
  progress,
  compact = false,
}: BatchToolbarProps) {
  const id = useId()
  const popup = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  if (selectedCount === 0) return null

  const renderActions = (inPopover: boolean) => actions.map(({ key, label, icon: Icon, tone, onClick }) => (
    <button key={key} type="button" className={`button ${tone === 'danger' ? 'danger' : 'secondary'}`} disabled={busy} onClick={() => {
      if (inPopover) {
        popup.current?.hidePopover()
        trigger.current?.focus()
      }
      onClick()
    }}>
      {Icon && <Icon aria-hidden="true" size={16} />}
      {label}
    </button>
  ))

  return (
    <div className={`batch-toolbar${compact ? ' batch-toolbar-compact' : ''}`} role="toolbar" aria-label="批量操作">
      <strong role="status">已选择 {selectedCount} 项</strong>
      {selectedCount < totalCount && <button type="button" className="button secondary" onClick={onSelectAll} disabled={busy}>全选当前结果</button>}
      <button type="button" className="button secondary batch-clear" onClick={onClear} disabled={busy}>清除选择</button>
      <span className="batch-actions">{renderActions(false)}</span>
      {actions.length > 0 && (
        <div className="batch-more">
          <button ref={trigger} className="icon-button" type="button" aria-label="更多批量操作" popoverTarget={id} disabled={busy}>
            <Ellipsis aria-hidden="true" size={16} />
          </button>
          <div ref={popup} id={id} popover="auto" className="batch-more-menu" role="group" aria-label="批量操作选项">
            {renderActions(true)}
          </div>
        </div>
      )}
      {progress && <span className="batch-progress" role="status">{progress}</span>}
    </div>
  )
}
