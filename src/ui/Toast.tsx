import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

type ToastTone = 'note' | 'error'

type ToastEntry = {
  id: number
  message: string
}

export type ToastApi = {
  notify: (message: string) => void
  notifyError: (message: string) => void
  dismiss: () => void
}

const NOTE_DURATION = 2500
const ERROR_DURATION = 5000

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [note, setNote] = useState<ToastEntry | null>(null)
  const [error, setError] = useState<ToastEntry | null>(null)
  const timers = useRef<Partial<Record<ToastTone, number>>>({})
  const counter = useRef(0)

  const push = useCallback((tone: ToastTone, message: string) => {
    if (!message) return
    counter.current += 1
    const entry = { id: counter.current, message }
    if (tone === 'error') setError(entry)
    else setNote(entry)
    const previous = timers.current[tone]
    if (previous !== undefined) window.clearTimeout(previous)
    timers.current[tone] = window.setTimeout(() => {
      if (tone === 'error') setError(null)
      else setNote(null)
      delete timers.current[tone]
    }, tone === 'error' ? ERROR_DURATION : NOTE_DURATION)
  }, [])

  const dismiss = useCallback(() => {
    for (const tone of ['note', 'error'] as const) {
      const timer = timers.current[tone]
      if (timer !== undefined) {
        window.clearTimeout(timer)
        delete timers.current[tone]
      }
    }
    setNote(null)
    setError(null)
  }, [])

  useEffect(() => () => {
    for (const tone of ['note', 'error'] as const) {
      const timer = timers.current[tone]
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({
    notify: (message) => push('note', message),
    notifyError: (message) => push('error', message),
    dismiss,
  }), [dismiss, push])

  return (
    <ToastContext value={api}>
      {children}
      {error || note ? (
        <div className="sp-toast-stack">
          {error ? <div key={error.id} className="sp-toast sp-toast-error" role="alert">{error.message}</div> : null}
          {note ? <div key={note.id} className="sp-toast sp-toast-note" role="status">{note.message}</div> : null}
        </div>
      ) : null}
    </ToastContext>
  )
}

// eslint-disable-next-line react/only-export-components -- The hook and provider share one private context.
export function useToast(): ToastApi {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}
