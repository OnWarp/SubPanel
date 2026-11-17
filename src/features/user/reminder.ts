export function reminderKey(userId?: string) { return `subpanel:expiry-reminder:${userId ?? 'anonymous'}` }
export function reminderEnabled(userId?: string) {
  try { return localStorage.getItem(reminderKey(userId)) === '1' } catch { return false }
}
