import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { focusFirstField } from './focus-field'

type DialogProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  busy?: boolean
  /** When true, Esc, the close icon and the backdrop ask before discarding. */
  dirty?: boolean
}

export function Dialog({ open, onClose, title, children, footer, busy = false, dirty = false }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const stayButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [discarding, setDiscarding] = useState(false)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      element.showModal()
      const frame = requestAnimationFrame(() => focusFirstField(element))
      return () => cancelAnimationFrame(frame)
    }
    if (!open && element.open) {
      element.close()
      const frame = requestAnimationFrame(() => returnFocus.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [open])

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

  return (
    <dialog
      ref={dialog}
      className="sp-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); requestClose() }}
      onPointerDown={(event) => { if (event.target === dialog.current) requestClose() }}
    >
      <div className="sp-dialog-panel">
        <header className="sp-dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <button className="sp-dialog-close" type="button" aria-label="关闭" title="关闭" onClick={requestClose} disabled={busy}><X aria-hidden="true" size={18} /></button>
        </header>
        <div className="sp-dialog-body">{children}</div>
        {footer || discarding ? (
          <footer className="sp-dialog-footer">
            {discarding ? (
              <div className="drawer-discard" role="group" aria-label="未保存更改">
                <p>关闭将放弃未保存的更改</p>
                <button ref={stayButton} className="button secondary" type="button" onClick={() => setDiscarding(false)}>继续编辑</button>
                <button className="button danger" type="button" onClick={() => { setDiscarding(false); onClose() }}>放弃更改</button>
              </div>
            ) : footer}
          </footer>
        ) : null}
      </div>
    </dialog>
  )
}
