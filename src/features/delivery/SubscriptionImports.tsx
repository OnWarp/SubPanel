import { ArrowUpRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CopyButton } from '../../ui/CopyButton'
import { StatusMessage } from '../../ui/StatusMessage'
import { clientImportLink, detectImportDevice, prefersClientImport } from '../user/client-import'

export type SubscriptionImport = { client: string; label: string; link: string }

export function SubscriptionImports({ entries, children }: { entries: SubscriptionImport[]; children?: ReactNode }) {
  const device = detectImportDevice(navigator.userAgent, navigator.maxTouchPoints)
  const [feedback, setFeedback] = useState('')
  const cancelAttempt = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => cancelAttempt.current?.(), [])

  const startImport = () => {
    cancelAttempt.current?.()
    setFeedback('')
    const cancel = () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', cancel)
      cancelAttempt.current = undefined
    }
    const onVisibility = () => {
      if (document.hidden) cancel()
    }
    const timer = window.setTimeout(() => {
      cancel()
      if (!document.hidden && document.hasFocus()) setFeedback('未检测到该应用，请先安装')
    }, 1600)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', cancel)
    cancelAttempt.current = cancel
  }

  const imports = entries.filter(({ link }) => link).map(entry => ({
    ...entry,
    href: clientImportLink(entry.client, entry.link),
  }))
  const preferred = imports.filter(({ client, href }) => href && prefersClientImport(device, client))
  const more = imports.filter(entry => !preferred.includes(entry))
  const copy = (entry: SubscriptionImport, iconOnly = false) => (
    <CopyButton value={entry.link} label={`复制 ${entry.label} 链接`} iconOnly={iconOnly}
      onError={() => setFeedback('无法复制链接')} onCopied={() => setFeedback('')} />
  )
  const importLink = (label: string, href: string, key?: string) => (
    <a key={key} className="button secondary" href={href} onClick={startImport}>
      <ArrowUpRight aria-hidden="true" size={16} />{label}
    </a>
  )

  if (!imports.length && !children) return null
  return (
    <div className="subscription-imports">
      {preferred.length > 0 && <div className="upd-import-actions">
        {preferred.map(entry => importLink(entry.label, entry.href!, entry.client))}
      </div>}
      {(more.length > 0 || children) && <details className="diagnostic-disclosure">
        <summary>更多导入方式</summary>
        {more.length > 0 && <div className="upd-import-actions">
          {more.map(entry => <div className="upd-import-actions" key={entry.client}>
            {entry.href ? <>{importLink(entry.label, entry.href)}{copy(entry, true)}</> : copy(entry)}
          </div>)}
        </div>}
        {children}
      </details>}
      {feedback && <StatusMessage tone="warning">{feedback}</StatusMessage>}
    </div>
  )
}
