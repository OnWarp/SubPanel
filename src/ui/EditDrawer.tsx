import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { focusFirstField } from './focus-field'

type EditDrawerProps = {
  open: boolean
  title: string
  headerStatus?: ReactNode
  headerActions?: ReactNode
  busy?: boolean
  /** When true, Esc and the close icon ask before discarding. */
  dirty?: boolean
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  size?: 'compact' | 'medium' | 'wide' | 'large'
  footer?: ReactNode
  children: ReactNode
}

export function EditDrawer({ open, title, headerStatus, headerActions, busy = false, dirty = false, onClose, returnFocusRef, size = 'medium', footer, children }: EditDrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const fallbackFocus = useRef<HTMLElement | null>(null)
  const stayButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [discarding, setDiscarding] = useState(false)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      fallbackFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      element.showModal()
      const frame = requestAnimationFrame(() => focusFirstField(element))
      return () => cancelAnimationFrame(frame)
    }
    if (!open && element.open) {
      element.close()
      const frame = requestAnimationFrame(() => (returnFocusRef?.current ?? fallbackFocus.current)?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [open, returnFocusRef])

  useEffect(() => {
    if (!open || !dirty) setDiscarding(false)
  }, [open, dirty])

  useEffect(() => {
    if (discarding) stayButton.current?.focus()
  }, [discarding])

  const requestClose = () => {
    if (busy) return
    if (discarding) {
      setDiscarding(false)
      return
    }
    if (dirty) {
      setDiscarding(true)
      return
    }
    onClose()
  }

  const discard = () => {
    setDiscarding(false)
    onClose()
  }

  return (
    <dialog
      ref={dialog}
      className={`edit-drawer drawer-${size}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); requestClose() }}
      onPointerDown={(event) => { if (event.target === dialog.current) event.preventDefault() }}
    >
      <div className="drawer-panel">
        <header className="dialog-heading">
          {headerStatus ? <div className="drawer-heading-title"><h2 id={titleId}>{title}</h2>{headerStatus}</div> : <h2 id={titleId}>{title}</h2>}
          <div className="drawer-heading-actions">
            {headerActions}
            <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={requestClose} disabled={busy}><X aria-hidden="true" size={18} /></button>
          </div>
        </header>
        <div className="drawer-content">{children}</div>
        {footer || discarding ? (
          <div className="drawer-footer">
            {discarding ? (
              <div className="drawer-discard" role="group" aria-label="未保存更改">
                <p>关闭将放弃未保存的更改</p>
                <button ref={stayButton} className="button secondary" type="button" onClick={() => setDiscarding(false)}>继续编辑</button>
                <button className="button danger" type="button" onClick={discard}>放弃更改</button>
              </div>
            ) : footer}
          </div>
        ) : null}
      </div>
    </dialog>
  )
}
