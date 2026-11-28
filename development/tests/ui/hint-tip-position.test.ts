import { describe, expect, it } from 'vitest'
import { hintBubblePosition, hintTriggerVisible } from '../../../src/ui/hint-placement'

const viewport = { width: 1280, height: 800 }

describe('hint bubble placement', () => {
  it('prefers above the trigger and aligns to its left edge', () => {
    const placed = hintBubblePosition(
      { left: 420, top: 360, width: 22, height: 22 },
      { width: 280, height: 68 },
      viewport,
    )
    expect(placed).toEqual({ left: 420, top: 360 - 68 - 6, maxWidth: 280 })
  })

  it('flips below when the trigger is too close to the top', () => {
    const placed = hintBubblePosition(
      { left: 80, top: 10, width: 32, height: 32 },
      { width: 200, height: 80 },
      viewport,
    )
    expect(placed.top).toBe(10 + 32 + 6)
    expect(placed.left).toBe(80)
  })

  it('shifts left so a wide bubble stays inside the right margin', () => {
    const placed = hintBubblePosition(
      { left: 1100, top: 400, width: 22, height: 22 },
      { width: 280, height: 40 },
      viewport,
    )
    expect(placed.left).toBe(1280 - 12 - 280)
    expect(placed.top).toBe(400 - 40 - 6)
    expect(placed.left + 280).toBeLessThanOrEqual(1280 - 12)
  })

  it('keeps the bubble inside a 390px viewport', () => {
    const narrow = { width: 390, height: 844 }
    const placed = hintBubblePosition(
      { left: 300, top: 500, width: 32, height: 32 },
      { width: 366, height: 120 },
      narrow,
    )
    expect(placed.maxWidth).toBe(280)
    expect(placed.left).toBeGreaterThanOrEqual(12)
    expect(placed.left + Math.min(366, placed.maxWidth)).toBeLessThanOrEqual(390 - 12)
    expect(placed.top).toBe(500 - 120 - 6)
    expect(placed.top).toBeGreaterThanOrEqual(12)
  })

  it('clamps into the viewport when neither side can fit the whole bubble', () => {
    const placed = hintBubblePosition(
      { left: 40, top: 80, width: 22, height: 22 },
      { width: 100, height: 150 },
      { width: 390, height: 200 },
    )
    expect(placed.top).toBe(38)
    expect(placed.top + 150).toBeLessThanOrEqual(200 - 12)
  })

  it('treats a trigger that has scrolled fully away as hidden', () => {
    expect(hintTriggerVisible({ left: 40, top: -40, width: 22, height: 22 }, viewport)).toBe(false)
    expect(hintTriggerVisible({ left: 40, top: 10, width: 22, height: 22 }, viewport)).toBe(true)
    expect(hintTriggerVisible({ left: -30, top: 10, width: 22, height: 22 }, viewport)).toBe(false)
  })
})
