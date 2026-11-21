export type Plan = { id: string; name: string; description: string; groupIds: string[]; durationDays: number; trafficGb: number; speedLimitMbps: number; deviceLimit: number; enabled: boolean; sortOrder: number }
export type SubscriptionPlanState = { state: 'active' | 'none' | 'expired' | 'revoked' | 'pending' | 'disabled'; current: AssignedPlan | null; latest: AssignedPlan | null; usedGb?: number; remainingGb?: number | null }
type AssignedPlan = { id: string; planId: string; plan: Plan; expiresAt: string | null; startsAt: string; status: string; note: string; source: string }
export const subscriptionPlanLabels = { active: '有效', none: '无可用订阅', expired: '订阅已过期', revoked: '订阅已收回', pending: '订阅待生效', disabled: '计划已停用' }
