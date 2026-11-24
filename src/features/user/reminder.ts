export function reminderKey(userId?: string) { return `subpanel:expiry-reminder:${userId ?? 'anonymous'}` }
export function reminderEnabled(userId?: string) {
  try { return localStorage.getItem(reminderKey(userId)) === '1' } catch { return false }
}

export function unifiedExpiryReminder(summary: { status: string; expiresAt: string | null }, userId?: string) {
  if (summary.status !== 'active' || !summary.expiresAt || !reminderEnabled(userId)) return null
  const remaining = Math.ceil((Date.parse(summary.expiresAt) - Date.now()) / 86_400_000)
  return remaining > 0 && remaining <= 7 ? `订阅将在 ${remaining} 天内到期，请联系管理员续期` : null
}
