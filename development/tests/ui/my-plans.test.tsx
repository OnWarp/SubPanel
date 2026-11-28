import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/theme/ThemeProvider', () => ({
  useTheme: () => ({ mode: 'light', preference: 'system', setPreference: () => undefined }),
}))
import { SessionProvider } from '../../../src/app/session'
import {
  expiringSoonLabel, expiringSoonText, formatPlanDate, planRangeText, planStatusLine, remainingDaysText,
  remainingSecondsText, type PlanSummary,
} from '../../../src/features/plans/my-plan-model'

const emptySummary: PlanSummary = {
  total: 0, active: 0, expired: 0, pending: 0, disabled: 0, accessStatus: 'none',
  validUntil: null, hasPermanentActivePlan: false, nextExpiryAt: null, expiringSoonCount: 0, lastExpiredAt: null,
}

const DAY = 86_400_000

describe('plan status semantics', () => {
  it('maps a permanent-only account to "long-term valid" and never a fake date', () => {
    expect(planStatusLine({ ...emptySummary, total: 1, active: 1, accessStatus: 'active', hasPermanentActivePlan: true }))
      .toBe('长期有效')
  })

  it('uses the latest active expiry and falls back to the last expiry when all are expired', () => {
    const validUntil = Date.UTC(2026, 11, 12, 19, 11)
    expect(planStatusLine({ ...emptySummary, total: 2, active: 1, accessStatus: 'active', validUntil }))
      .toBe(`有效期至 ${formatPlanDate(validUntil)}`)
    const lastExpiredAt = Date.UTC(2026, 10, 1)
    expect(planStatusLine({ ...emptySummary, total: 1, expired: 1, accessStatus: 'expired', lastExpiredAt }))
      .toBe(`已过期 · ${formatPlanDate(lastExpiredAt)}`)
  })

  it('distinguishes no plans from no valid plans and from pending', () => {
    expect(planStatusLine(emptySummary)).toBe('暂无套餐')
    expect(planStatusLine({ ...emptySummary, total: 1, disabled: 1, accessStatus: 'disabled' })).toBe('暂无有效套餐')
    expect(planStatusLine({ ...emptySummary, total: 1, pending: 1, accessStatus: 'pending' })).toBe('待生效')
  })

  it('rounds remaining days up and says "不足 1 天" below one day', () => {
    const now = Date.UTC(2026, 0, 1)
    expect(remainingDaysText(null, now)).toBeNull()
    expect(remainingDaysText(now + 3 * DAY + 1, now)).toBe('4 天')
    expect(remainingDaysText(now + 2.5 * DAY, now)).toBe('3 天')
    expect(remainingDaysText(now + 3_600_000, now)).toBe('不足 1 天')
    expect(remainingDaysText(now - 1, now)).toBe('已过期')
  })

  it('formats the detail remaining time in days or hours', () => {
    expect(remainingSecondsText(null)).toBe('长期有效')
    expect(remainingSecondsText(0)).toBe('已过期')
    expect(remainingSecondsText(15 * 86400)).toBe('15 天')
    expect(remainingSecondsText(7200)).toBe('2 小时')
    expect(remainingSecondsText(600)).toBe('不足 1 小时')
  })

  it('names the count of soon-to-expire plans, else the remaining days', () => {
    const now = Date.UTC(2026, 0, 1)
    const soon = { ...emptySummary, total: 2, active: 2, accessStatus: 'active' as const, expiringSoonCount: 1, nextExpiryAt: now + 3 * DAY, validUntil: now + 40 * DAY }
    expect(expiringSoonLabel(soon, now)).toBe('1 个套餐将在 3 天内到期')
    expect(expiringSoonText(soon, now)).toBe('1 个套餐将在 3 天内到期')
    const distant = { ...emptySummary, total: 1, active: 1, accessStatus: 'active' as const, validUntil: now + 20 * DAY }
    expect(expiringSoonLabel(distant, now)).toBeNull()
    expect(expiringSoonText(distant, now)).toBe('距全部有效套餐到期还有 20 天')
    expect(expiringSoonText({ ...emptySummary, total: 1, active: 1, accessStatus: 'active' as const, hasPermanentActivePlan: true }, now)).toBeNull()
  })

  it('renders a permanent detail range without an end date', () => {
    const start = Date.UTC(2026, 0, 5)
    expect(planRangeText(start, null)).toBe('2026.01.05 起 · 长期有效')
    expect(planRangeText(start, Date.UTC(2026, 1, 5))).toBe('2026.01.05 — 2026.02.05')
  })
})

function render(node: Parameters<typeof createElement>[0]) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SessionProvider, null, createElement(node as never))))
}

describe('my plans route rendering', () => {
  it('renders the empty My Plans list with a redeem entry and an all/valid/expired filter bar', async () => {
    const { MyPlansPage } = await import('../../../src/features/plans/MyPlansPage')
    const html = render(MyPlansPage)
    expect(html).toContain('我的套餐')
    expect(html).toContain('兑换套餐')
    expect(html).toContain('全部')
    expect(html).toContain('有效')
    expect(html).toContain('已过期')
    // No filter result must not render the "no plans" copy while loading.
    expect(html).not.toContain('暂无套餐')
  })

  it('renders the plan detail frame with the back link', async () => {
    const { MyPlanDetailPage } = await import('../../../src/features/plans/MyPlanDetailPage')
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/me/plans/abc'] },
      createElement(SessionProvider, null, createElement(Routes, null,
        createElement(Route, { path: '/me/plans/:instanceId', element: createElement(MyPlanDetailPage) })))))
    expect(html).toContain('套餐详情')
    expect(html).toContain('href="/me/plans"')
    expect(html).toContain('正在加载套餐')
  })
})
