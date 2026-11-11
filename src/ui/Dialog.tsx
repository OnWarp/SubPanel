import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

type DialogProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      element.showModal()
    }
    if (!open && element.open) {
      element.close()
      requestAnimationFrame(() => returnFocus.current?.focus())
    }
  }, [open])

  return (
    <dialog
      ref={dialog}
      className="sp-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onPointerDown={(event) => { if (event.target === dialog.current) onClose() }}
    >
      <div className="sp-dialog-panel">
        <header className="sp-dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <button className="sp-dialog-close" type="button" aria-label="关闭" title="关闭" onClick={onClose}><X aria-hidden="true" size={18} /></button>
        </header>
        <div className="sp-dialog-body">{children}</div>
        {footer ? <footer className="sp-dialog-footer">{footer}</footer> : null}
      </div>
    </dialog>
  )
}
