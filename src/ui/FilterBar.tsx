import { useRef, type ReactNode, type RefObject } from 'react'

type FilterBarProps = {
  children: ReactNode
  className?: string
  actions?: ReactNode
  more?: ReactNode
  moreActive?: boolean
  onReset?: () => void
  searchRef?: RefObject<HTMLInputElement | null>
}

export function FilterBar({ children, className, more, moreActive, onReset, searchRef, actions }: FilterBarProps) {
  const advanced = useRef<HTMLDetailsElement>(null)

  return (
    <div className={`sp-filter-bar${className ? ` ${className}` : ''}`} role="group" aria-label="筛选">
      {children}
      {more && (
        <details ref={advanced} className="sp-filter-more" onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.open) return
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
        }}>
          <summary className="button secondary">{moreActive ? '更多筛选（已生效）' : '更多筛选'}</summary>
          <div className="sp-filter-options">{more}</div>
        </details>
      )}
      {onReset && (
        <button className="button ghost sp-filter-reset" type="button" onClick={() => {
          onReset()
          if (advanced.current) advanced.current.open = false
          searchRef?.current?.focus()
        }}>重置筛选</button>
      )}
      {actions && <div className="content-toolbar-actions">{actions}</div>}
    </div>
  )
}

export { FilterBar as TableToolbar }
