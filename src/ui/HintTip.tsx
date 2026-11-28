import { Info } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { scheduleHintPosition, useHintBubbleTracking } from './hint-placement'

/** Long notes stay off the page until the circled info control is hovered or clicked. */
export function HintTip({ text }: { text: string }) {
  const id = `hint-${useId().replace(/:/g, '')}`
  const trigger = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const pinned = useRef(false)
  const timer = useRef(0)

  const show = () => {
    window.clearTimeout(timer.current)
    const node = bubble.current
    const anchor = trigger.current
    if (!node || !anchor) return
    if (!node.matches(':popover-open')) node.showPopover()
    if (node.matches(':popover-open')) scheduleHintPosition(anchor, node)
  }

  const hideSoon = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const node = bubble.current
      if (!pinned.current && node?.matches(':popover-open')) node.hidePopover()
    }, 120)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])
  useHintBubbleTracking(trigger, bubble)

  return (
    <span className="sp-hint-tip" onMouseEnter={show} onMouseLeave={hideSoon}>
      <button
        ref={trigger}
        type="button"
        className="sp-hint-tip-button"
        aria-label={text}
        popoverTarget={id}
        onClick={(event) => {
          event.stopPropagation()
          const node = bubble.current
          if (!node) return
          if (node.matches(':popover-open') && !pinned.current) {
            event.preventDefault()
            pinned.current = true
            return
          }
          pinned.current = !node.matches(':popover-open')
        }}
        onFocus={show}
        onBlur={hideSoon}
      >
        <Info aria-hidden="true" size={15} />
      </button>
      <span
        ref={bubble}
        id={id}
        popover="auto"
        role="note"
        aria-label={text}
        className="sp-hint-bubble"
        onMouseEnter={() => window.clearTimeout(timer.current)}
        onMouseLeave={hideSoon}
        onToggle={(event) => {
          if (event.newState === 'closed') {
            pinned.current = false
            return
          }
          const node = bubble.current
          const anchor = trigger.current
          if (node && anchor) scheduleHintPosition(anchor, node)
        }}
      >{text}</span>
    </span>
  )
}
