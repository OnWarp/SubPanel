import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'

type EditDrawerProps = {
  open: boolean
  title: string
  busy?: boolean
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  size?: 'compact' | 'medium' | 'wide' | 'large'
  children: ReactNode
}

export function EditDrawer({ open, title, busy = false, onClose, returnFocusRef, size = 'medium', children }: EditDrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) {
      element.close()
      requestAnimationFrame(() => returnFocusRef?.current?.focus())
    }
  }, [open, returnFocusRef])

  const close = () => {
    if (busy) return
    onClose()
  }

  return (
    <dialog
      ref={dialog}
      className={`edit-drawer drawer-${size}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close() }}
      onPointerDown={(event) => { if (event.target === dialog.current) event.preventDefault() }}
    >
      <div className="drawer-panel">
        <header className="dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={close} disabled={busy}><X aria-hidden="true" size={18} /></button>
        </header>
        <div className="drawer-content">{children}</div>
      </div>
    </dialog>
  )
}
