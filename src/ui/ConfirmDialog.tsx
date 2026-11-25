import type { RefObject, ReactNode } from 'react'
import { Dialog, type DialogSize } from './Dialog'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  size?: DialogSize
  appearance?: 'content'
  dirty?: boolean
  busy?: boolean
  confirmDisabled?: boolean
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
  size = 's',
  appearance,
  dirty = false,
  busy = false,
  confirmDisabled = false,
  onClose,
  onConfirm,
  returnFocusRef,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      size={size}
      appearance={appearance}
      dirty={dirty}
      busy={busy}
      closeOnBackdrop={false}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={(requestClose) => <>
        <button className="button ghost" type="button" onClick={requestClose} disabled={busy} data-dialog-initial-focus={danger ? '' : undefined}>取消</button>
        <button className={`button ${danger ? 'danger-fill' : 'primary'}`} type="button" onClick={onConfirm} disabled={busy || confirmDisabled}>{busy ? '处理中' : confirmLabel}</button>
      </>}
    >
      {children}
    </Dialog>
  )
}
