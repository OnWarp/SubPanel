export type Plan = { id: string; name: string; description: string; groupIds: string[]; durationDays: number; trafficGb: number; speedLimitMbps: number; deviceLimit: number; enabled: boolean; sortOrder: number }
export const subscriptionPlanLabels = { active: '有效', none: '无可用订阅', expired: '订阅已过期', revoked: '计划授权已收回', pending: '订阅待生效', disabled: '计划已停用' }
