export type Plan = { id: string; name: string; description: string; groupIds: string[]; durationDays: number; trafficGb: number; speedLimitMbps: number; deviceLimit: number; enabled: boolean; sortOrder: number }
export type EntitlementState = { state: 'active' | 'none' | 'expired' | 'revoked' | 'pending' | 'disabled'; current: Entitlement | null; latest: Entitlement | null }
type Entitlement = { id: string; planId: string; plan: Plan; expiresAt: string; startsAt: string; status: string; note: string; source: string }
export const entitlementLabels = { active: '有效', none: '无可用订阅', expired: '权益已过期', revoked: '权益已收回', pending: '权益待生效', disabled: '计划已停用' }
