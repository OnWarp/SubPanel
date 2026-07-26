import { X } from 'lucide-react'
import { useEffect, useId, useRef, type RefObject, type ReactNode } from 'react'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  children?: ReactNode
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  onClose,
  onConfirm,
  returnFocusRef,
  children,
}: ConfirmDialogProps) {
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
      className="confirm-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close() }}
      onPointerDown={(event) => { if (event.target === dialog.current) event.preventDefault() }}
    >
      <div className="dialog-panel">
        <header className="dialog-heading">
          <div><h2 id={titleId}>{title}</h2><p>{description}</p></div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={close} disabled={busy}><X aria-hidden="true" size={18} /></button>
        </header>
        {children}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={close} disabled={busy}>取消</button>
          <button className={`button ${danger ? 'danger' : 'primary'}`} type="button" onClick={onConfirm} disabled={busy}>{busy ? '处理中' : confirmLabel}</button>
        </div>
      </div>
    </dialog>
  )
}
