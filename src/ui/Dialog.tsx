import { X } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { focusFirstField } from './focus-field'

type DialogProps = {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode | ((requestClose: () => void) => ReactNode)
  size?: 's' | 'm' | 'l' | 'xl'
  busy?: boolean
  dirty?: boolean
  sensitive?: boolean
  closeOnBackdrop?: boolean
  returnFocusRef?: RefObject<HTMLElement | null>
}

function restoreFocus(trigger: HTMLElement | null, explicitTarget?: RefObject<HTMLElement | null>) {
  const menuTrigger = trigger?.closest('details')?.querySelector<HTMLElement>(':scope > summary')
  const active = document.activeElement
  const activeModal = active?.closest('dialog:modal')
  for (const target of [explicitTarget?.current, trigger, menuTrigger]) {
    if (!target?.isConnected || (activeModal && !activeModal.contains(target))) continue
    target.focus({ preventScroll: true })
    if (document.activeElement === target) return
  }

  if (activeModal) return
  const fallback = document.querySelector<HTMLElement>('main h1, main, .topbar-page-title h1')
  if (!fallback) return
  const temporary = !fallback.hasAttribute('tabindex')
  if (temporary) fallback.tabIndex = -1
  fallback.focus({ preventScroll: true })
  if (temporary) fallback.removeAttribute('tabindex')
}

export function Dialog({
  open, onClose, title, description, children, footer, size = 'm', busy = false, dirty = false,
  sensitive = false, closeOnBackdrop = true, returnFocusRef,
}: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const stayButton = useRef<HTMLButtonElement>(null)
  const beforeDiscard = useRef<HTMLElement | null>(null)
  const pointerStartedOutside = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  const [discard, setDiscard] = useState<{ previous: HTMLElement | null } | null>(null)
  const discarding = discard !== null && open && dirty
  if (discard && !discarding) setDiscard(null)

  useLayoutEffect(() => {
    const element = dialog.current
    if (!open || !element) return

    const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null
    element.showModal()
    const initial = element.querySelector<HTMLElement>('[data-dialog-initial-focus]:not(:disabled)')
    if (initial) initial.focus({ preventScroll: true })
    else focusFirstField(element)

    const viewport = window.visualViewport
    const updateViewport = () => {
      if (!viewport) return
      element.style.setProperty('--dialog-viewport-height', `${viewport.height}px`)
      element.style.setProperty('--dialog-viewport-top', `${viewport.offsetTop}px`)
    }
    updateViewport()
    const resizeViewport = () => {
      updateViewport()
      const body = element.querySelector('.sp-dialog-body')
      const field = document.activeElement
      if (!body?.contains(field) || !field?.matches('input, textarea, [contenteditable="true"]')) return
      const bounds = body.getBoundingClientRect()
      const { top, bottom } = field.getBoundingClientRect()
      if (top < bounds.top) body.scrollTop += top - bounds.top
      else if (bottom > bounds.bottom) body.scrollTop += bottom - bounds.bottom
    }
    viewport?.addEventListener('resize', resizeViewport)
    viewport?.addEventListener('scroll', updateViewport)

    return () => {
      viewport?.removeEventListener('resize', resizeViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      element.close()
      queueMicrotask(() => {
        if (!element.open) restoreFocus(trigger, returnFocusRef)
      })
    }
  }, [open, returnFocusRef])

  useLayoutEffect(() => {
    if (discard) {
      beforeDiscard.current = discard.previous
      if (discarding) stayButton.current?.focus()
    } else if (beforeDiscard.current) {
      const previous = beforeDiscard.current
      beforeDiscard.current = null
      if (open && previous.isConnected) previous.focus()
      else if (open) closeButton.current?.focus()
    }
  }, [discard, discarding, open])

  const requestClose = (source: 'control' | 'backdrop' | 'discard' = 'control') => {
    if (busy || (source === 'backdrop' && (!closeOnBackdrop || dirty || sensitive))) return
    if (source === 'discard') {
      setDiscard(null)
      onClose()
    } else if (discarding) {
      setDiscard(null)
    } else if (dirty) {
      setDiscard({ previous: document.activeElement instanceof HTMLElement ? document.activeElement : null })
    } else {
      onClose()
    }
  }

  const trapTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]',
    )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') &&
      element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]'))
    const first = elements[0]
    const last = elements.at(-1)
    const active = document.activeElement
    if (!first || !last) {
      event.preventDefault()
      return
    }
    if (event.shiftKey ? active === first || active === event.currentTarget : active === last) {
      event.preventDefault()
      const next = event.shiftKey ? last : first
      next.focus()
    }
  }

  const actions = typeof footer === 'function' ? footer(() => requestClose()) : footer
  return (
    <dialog
      ref={dialog}
      className="sp-dialog"
      data-size={size}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => { event.preventDefault(); requestClose() }}
      onKeyDown={trapTab}
      onPointerDown={(event) => {
        pointerStartedOutside.current = event.target === dialog.current
        if (pointerStartedOutside.current) event.preventDefault()
      }}
      onPointerUp={(event) => {
        if (event.target !== dialog.current) pointerStartedOutside.current = false
      }}
      onPointerCancel={() => { pointerStartedOutside.current = false }}
      onClick={(event) => {
        if (pointerStartedOutside.current && event.target === dialog.current) requestClose('backdrop')
        pointerStartedOutside.current = false
      }}
    >
      <div className="sp-dialog-panel">
        <header className="sp-dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeButton} className="sp-dialog-close" type="button" aria-label="关闭" title="关闭" onClick={() => requestClose()} disabled={busy}><X aria-hidden="true" size={18} /></button>
        </header>
        <div className="sp-dialog-body">
          {description ? <p className="sp-dialog-description" id={descriptionId}>{description}</p> : null}
          {children}
        </div>
        {actions || discarding ? (
          <footer className="sp-dialog-footer">
            {discarding ? (
              <div className="drawer-discard" role="group" aria-label="未保存更改">
                <p>关闭将放弃未保存的更改</p>
                <button ref={stayButton} className="button secondary" type="button" disabled={busy} onClick={() => requestClose()}>继续编辑</button>
                <button className="button danger" type="button" disabled={busy} onClick={() => requestClose('discard')}>放弃更改</button>
              </div>
            ) : actions}
          </footer>
        ) : null}
      </div>
    </dialog>
  )
}
