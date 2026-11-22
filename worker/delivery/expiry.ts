import { apiError } from '../platform/api-error.js'
import type { Subscription } from './schema.js'

export const EXPIRY_SOON_DAYS = 7

type WindowSubscription = Pick<Subscription, 'startsAt' | 'expiresAt' | 'createdAt'>

export function effectiveStartsAt(subscription: WindowSubscription): number {
  if (subscription.startsAt !== null) return subscription.startsAt
  const createdAt = Date.parse(subscription.createdAt)
  return Number.isFinite(createdAt) ? createdAt : 0
}

export function subscriptionWindowStatus(subscription: WindowSubscription, now: number) {
  if (subscription.expiresAt !== null && subscription.expiresAt <= now) return 'expired'
  if (now < effectiveStartsAt(subscription)) return 'pending'
  return null
}

export function subscriptionRowStatus(subscription: WindowSubscription & Pick<Subscription, 'enabled' | 'planRevoked'>, now: number) {
  const window = subscriptionWindowStatus(subscription, now)
  if (window === 'expired') return window
  if (!subscription.enabled) return subscription.planRevoked ? 'revoked' : 'disabled'
  return window
}

// Expired wins over not-yet-started so an inverted window still fails closed.
export function assertSubscriptionAvailable(subscription: WindowSubscription, now = Date.now()): void {
  const status = subscriptionWindowStatus(subscription, now)
  if (status === 'expired') {
    throw apiError(410, 'SUB_EXPIRED', '订阅已过期')
  }
  if (status === 'pending') {
    throw apiError(403, 'SUB_NOT_STARTED', '订阅尚未生效')
  }
}

export { expiryFromDuration, type SubscriptionDuration } from '../../shared/subscription-duration.js'

const DAY_MS = 86_400_000

export type SubscriptionExpiryKind = 'permanent' | 'pending' | 'active' | 'soon' | 'expired'

// Mirrors the admin UI's getExpiryState classification so server-side list
// filters agree with the badges the page renders for the same subscription.
export function subscriptionExpiryKind(subscription: WindowSubscription, now = Date.now()): SubscriptionExpiryKind {
  const startsAt = effectiveStartsAt(subscription)
  if (subscription.expiresAt !== null && now >= subscription.expiresAt) return 'expired'
  if (now < startsAt) return 'pending'
  if (subscription.expiresAt === null) return 'permanent'
  return subscription.expiresAt - now <= EXPIRY_SOON_DAYS * DAY_MS ? 'soon' : 'active'
}

// Mirrors the admin UI's isWithinExpiryDays: disabled subscriptions never
// match, and expired or permanent ones have no remaining window to fall into.
export function isWithinExpiryDays(
  subscription: WindowSubscription & { enabled: boolean },
  days: number,
  now = Date.now(),
): boolean {
  if (!subscription.enabled) return false
  if (subscriptionExpiryKind(subscription, now) === 'expired' || subscription.expiresAt === null) return false
  return subscription.expiresAt - now <= days * DAY_MS
}
