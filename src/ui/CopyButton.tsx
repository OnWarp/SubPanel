import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '../app/clipboard'

type CopyButtonProps = {
  value: string
  label?: string
  copiedLabel?: string
  variant?: 'ghost' | 'secondary'
  iconOnly?: boolean
  className?: string
  onError?: (cause: unknown) => void
  onCopied?: () => void
}

/**
 * Copy action with in-place feedback: the button itself flips to the copied
 * label for 1.5s instead of raising a toast (plan section 5.3).
 */
export function CopyButton({ value, label = '复制', copiedLabel = '已复制', variant = 'ghost', iconOnly = false, className, onError, onCopied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await copyToClipboard(value)
    } catch (cause) {
      onError?.(cause)
      return
    }
    setCopied(true)
    onCopied?.()
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const Icon = copied ? Check : Copy
  if (iconOnly) {
    return (
      <button
        type="button"
        className={`icon-button${className ? ` ${className}` : ''}`}
        aria-label={copied ? copiedLabel : label}
        title={copied ? copiedLabel : label}
        onClick={copy}
      >
        <Icon aria-hidden="true" size={16} />
      </button>
    )
  }
  return (
    <button type="button" className={`button ${variant}${className ? ` ${className}` : ''}`} onClick={copy}>
      <Icon aria-hidden="true" size={16} />
      {copied ? copiedLabel : label}
    </button>
  )
}
