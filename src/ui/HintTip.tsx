import { Info } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

const VIEWPORT_MARGIN = 12

function place(trigger: HTMLElement, bubble: HTMLElement) {
  const maxWidth = Math.min(280, window.innerWidth - VIEWPORT_MARGIN * 2)
  bubble.style.maxWidth = `${maxWidth}px`
  bubble.style.left = '0px'
  bubble.style.top = '0px'
  const bubbleRect = bubble.getBoundingClientRect()
  const triggerRect = trigger.getBoundingClientRect()
  let left = triggerRect.left
  if (left + bubbleRect.width > window.innerWidth - VIEWPORT_MARGIN) {
    left = window.innerWidth - VIEWPORT_MARGIN - bubbleRect.width
  }
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
  let top = triggerRect.bottom + 6
  const above = triggerRect.top - bubbleRect.height - 6
  if (top + bubbleRect.height > window.innerHeight - VIEWPORT_MARGIN) {
    top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - bubbleRect.height)
  }
  bubble.style.left = `${left}px`
  bubble.style.top = `${top}px`
}

/** Long notes stay off the page until the circled info control is hovered or clicked. */
export function HintTip({ text }: { text: string }) {
  const id = `hint-${useId().replace(/:/g, '')}`
  const trigger = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const pinned = useRef(false)
  const timer = useRef(0)

  const position = () => {
    const node = bubble.current
    const anchor = trigger.current
    if (!node || !anchor || !node.matches(':popover-open')) return
    place(anchor, node)
    requestAnimationFrame(() => {
      if (node.matches(':popover-open')) place(anchor, node)
    })
  }

  const show = () => {
    window.clearTimeout(timer.current)
    const node = bubble.current
    const anchor = trigger.current
    if (!node || !anchor) return
    if (!node.matches(':popover-open')) node.showPopover()
    position()
  }

  const hideSoon = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const node = bubble.current
      if (!pinned.current && node?.matches(':popover-open')) node.hidePopover()
    }, 120)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    const onResize = () => {
      const node = bubble.current
      const anchor = trigger.current
      if (node?.matches(':popover-open') && anchor) place(anchor, node)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [])

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
          position()
        }}
      >{text}</span>
    </span>
  )
}
