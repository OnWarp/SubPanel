import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useState } from 'react'

type NoticeCarouselProps = {
  items: { id: string; title: string }[]
  onSelect?: (id: string) => void
  onCloseItem?: (id: string) => void
  onDismiss?: () => void
  labels: { previous: string; next: string; close: string; dismiss?: string }
}

export function NoticeCarousel({ items, onSelect, onCloseItem, onDismiss, labels }: NoticeCarouselProps) {
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [dismissed, setDismissed] = useState(false)
  const found = items.findIndex(item => item.id === activeId)
  const index = found < 0 ? 0 : found
  const item = items[index]
  if (dismissed || !item) return null
  const move = (delta: number) => setActiveId(items[(index + delta + items.length) % items.length].id)
  return <div className="sp-notice-carousel"><div className="sp-notice-title" aria-live="polite">{onSelect ? <button type="button" onClick={() => onSelect(item.id)}>{item.title}</button> : <span>{item.title}</span>}</div><button type="button" className="icon-button" aria-label={labels.previous} disabled={items.length < 2} onClick={() => move(-1)}><ChevronLeft size={16} aria-hidden="true" /></button><span className="sp-notice-count">{index + 1}/{items.length}</span><button type="button" className="icon-button" aria-label={labels.next} disabled={items.length < 2} onClick={() => move(1)}><ChevronRight size={16} aria-hidden="true" /></button>{onCloseItem ? <button type="button" className="icon-button" aria-label={labels.close} onClick={() => onCloseItem(item.id)}><X size={16} aria-hidden="true" /></button> : null}<button type="button" className="icon-button" aria-label={labels.dismiss ?? labels.close} onClick={() => { setDismissed(true); onDismiss?.() }}><X size={16} aria-hidden="true" /></button></div>
}
