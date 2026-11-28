import { useEffect } from 'react'

export const HINT_VIEWPORT_MARGIN = 12
export const HINT_GAP = 6

export type HintBox = { left: number; top: number; width: number; height: number }
export type HintPlaceResult = 'placed' | 'unmeasured' | 'hidden'

export function hintTriggerVisible(trigger: HintBox, viewport: { width: number; height: number }): boolean {
  const right = trigger.left + trigger.width
  const bottom = trigger.top + trigger.height
  return bottom > 0 && trigger.top < viewport.height && right > 0 && trigger.left < viewport.width
}

/** Prefer above the trigger. Flip below when that would leave the viewport, then clamp. */
export function hintBubblePosition(
  trigger: HintBox,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = HINT_VIEWPORT_MARGIN,
  gap = HINT_GAP,
): { left: number; top: number; maxWidth: number } {
  const maxWidth = Math.max(0, Math.min(280, viewport.width - margin * 2))
  const width = Math.min(Math.max(0, bubble.width), maxWidth)
  const height = Math.max(0, bubble.height)
  let left = trigger.left
  if (left + width > viewport.width - margin) left = viewport.width - margin - width
  if (left < margin) left = margin
  const above = trigger.top - height - gap
  const below = trigger.top + trigger.height + gap
  const roomBelow = viewport.height - margin - below
  let top = above
  if (above < margin) top = height <= roomBelow ? below : Math.max(margin, viewport.height - margin - height)
  if (top < margin) top = margin
  return { left, top, maxWidth }
}

/**
 * Anchor a popover bubble to its trigger.
 * Without an anchor, a top-layer popover stays at the viewport origin.
 * Inline margin and coordinates override the UA inset and margin rules.
 */
export function placeHintBubble(trigger: HTMLElement, bubble: HTMLElement): HintPlaceResult {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const triggerRect = trigger.getBoundingClientRect()
  const triggerBox = { left: triggerRect.left, top: triggerRect.top, width: triggerRect.width, height: triggerRect.height }
  if (triggerBox.width < 1 && triggerBox.height < 1) return 'unmeasured'
  if (!hintTriggerVisible(triggerBox, viewport)) return 'hidden'

  const maxWidth = Math.max(0, Math.min(280, viewport.width - HINT_VIEWPORT_MARGIN * 2))
  const maxHeight = Math.max(0, viewport.height - HINT_VIEWPORT_MARGIN * 2)
  bubble.style.position = 'fixed'
  bubble.style.boxSizing = 'border-box'
  bubble.style.margin = '0px'
  bubble.style.right = 'auto'
  bubble.style.bottom = 'auto'
  bubble.style.maxWidth = `${maxWidth}px`
  bubble.style.maxHeight = `${maxHeight}px`
  bubble.style.visibility = 'hidden'
  bubble.style.left = `${HINT_VIEWPORT_MARGIN}px`
  bubble.style.top = `${HINT_VIEWPORT_MARGIN}px`
  const measured = bubble.getBoundingClientRect()
  if (measured.width < 1 || measured.height < 1) return 'unmeasured'
  const pos = hintBubblePosition(triggerBox, measured, viewport)
  bubble.style.left = `${pos.left}px`
  bubble.style.top = `${pos.top}px`
  bubble.style.visibility = ''
  return 'placed'
}

export function positionOpenHint(trigger: HTMLElement, bubble: HTMLElement): HintPlaceResult {
  if (!bubble.matches(':popover-open')) return 'hidden'
  const result = placeHintBubble(trigger, bubble)
  if (result === 'hidden' && bubble.matches(':popover-open')) bubble.hidePopover()
  return result
}

export function scheduleHintPosition(trigger: HTMLElement, bubble: HTMLElement) {
  positionOpenHint(trigger, bubble)
  requestAnimationFrame(() => {
    if (bubble.matches(':popover-open')) positionOpenHint(trigger, bubble)
  })
}

export function useHintBubbleTracking(
  trigger: { readonly current: HTMLElement | null },
  bubble: { readonly current: HTMLElement | null },
) {
  useEffect(() => {
    let frame = 0
    const onChange = () => {
      cancelAnimationFrame(frame)
      // Scroll listeners can run before layout, so place on the next frame.
      frame = requestAnimationFrame(() => {
        const node = bubble.current
        const anchor = trigger.current
        if (!node || !anchor || !node.matches(':popover-open')) return
        positionOpenHint(anchor, node)
      })
    }
    window.addEventListener('resize', onChange)
    window.addEventListener('scroll', onChange, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onChange)
      window.removeEventListener('scroll', onChange, true)
    }
  }, [bubble, trigger])
}

