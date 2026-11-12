import { apiError } from '../platform/api-error.js'
import type { Subscription } from './schema.js'

export const EXPIRY_SOON_DAYS = 7

type WindowSubscription = Pick<Subscription, 'startsAt' | 'expiresAt' | 'createdAt'>

export function effectiveStartsAt(subscription: WindowSubscription): number {
  if (subscription.startsAt !== null) return subscription.startsAt
  const createdAt = Date.parse(subscription.createdAt)
  return Number.isFinite(createdAt) ? createdAt : 0
}

// Expired wins over not-yet-started so an inverted window still fails closed.
export function assertSubscriptionAvailable(subscription: WindowSubscription, now = Date.now()): void {
  if (subscription.expiresAt !== null && now > subscription.expiresAt) {
    throw apiError(410, 'SUB_EXPIRED', '订阅已过期')
  }
  if (now < effectiveStartsAt(subscription)) {
    throw apiError(403, 'SUB_NOT_STARTED', '订阅尚未生效')
  }
}
