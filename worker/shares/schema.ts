import { z } from 'zod'
import { passwordHashSchema, userIdSchema } from '../accounts/schema.js'
import { subscriptionIdSchema, tokenHashSchema } from '../delivery/schema.js'
import { encryptedValueSchema } from '../platform/crypto.js'

export { subscriptionIdSchema, tokenHashSchema, userIdSchema }

export const shareIdSchema = z.string().regex(/^shr_[1-9]\d*$/)
export const shareStatusSchema = z.enum(['active', 'disabled', 'revoked'])

export function canonicalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== '/' && url.pathname !== '') return null
    return url.origin
  } catch {
    return null
  }
}

export const shareSettingsSchema = z.object({
  enabled: z.boolean(),
  createAllowed: z.boolean(),
  maxSharesPerSubscription: z.number().int().min(1).max(100),
  maxActiveSharesPerUser: z.number().int().min(1).max(1_000),
  maxValidityDays: z.number().int().min(1).max(3_650),
  defaultAllowOriginalLink: z.boolean(),
  defaultAccessControl: z.enum(['none', 'password']),
  requireLoginDefault: z.boolean(),
  publicBaseUrl: z.string().max(256).refine(
    (value) => canonicalPublicBaseUrl(value) !== null,
    '公网基址必须是空字符串或 http(s) 源站',
  ),
})

export const shareAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('password'), passwordHash: passwordHashSchema }),
])

export const shareRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: shareIdSchema,
  ownerUserId: userIdSchema,
  subscriptionId: subscriptionIdSchema,
  tokenHash: tokenHashSchema,
  tokenPrefix: z.string().regex(/^[A-Za-z0-9_-]{8}$/),
  tokenEncrypted: encryptedValueSchema,
  remark: z.string().max(200),
  status: shareStatusSchema,
  accessControl: shareAccessSchema,
  expiresAt: z.iso.datetime(),
  allowOriginalLink: z.boolean(),
  showSubscriptionName: z.boolean(),
  showGroups: z.boolean(),
  showExpiry: z.boolean(),
  showNodeNames: z.boolean(),
  requireLogin: z.boolean(),
  maxAccessCount: z.number().int().positive().max(1_000_000).nullable(),
  accessCount: z.number().int().nonnegative(),
  lastAccessedAt: z.iso.datetime().nullable(),
  // 审计占位。项目暂无审计表，不能把这个时间当成完整审计日志。
  lastOriginalRevealAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const createShareSchema = z.object({
  subscriptionId: subscriptionIdSchema,
  remark: z.string().trim().max(200).optional(),
  expiresAt: z.iso.datetime().optional(),
  allowOriginalLink: z.boolean().optional(),
  showSubscriptionName: z.boolean().optional(),
  showGroups: z.boolean().optional(),
  showExpiry: z.boolean().optional(),
  showNodeNames: z.boolean().optional(),
  requireLogin: z.boolean().optional(),
  maxAccessCount: z.number().int().positive().max(1_000_000).nullable().optional(),
  accessControl: z.enum(['none', 'password']).optional(),
  password: z.string().min(8).max(128).optional(),
}).superRefine((value, ctx) => {
  if (value.accessControl === 'password' && value.password === undefined) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: 'Password is required' })
  }
  if (value.accessControl === 'none' && value.password !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: 'Password is not allowed' })
  }
})

export const updateShareSchema = z.object({
  remark: z.string().trim().max(200).optional(),
  expiresAt: z.iso.datetime().optional(),
  allowOriginalLink: z.boolean().optional(),
  showSubscriptionName: z.boolean().optional(),
  showGroups: z.boolean().optional(),
  showExpiry: z.boolean().optional(),
  showNodeNames: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')

export const verifyShareSchema = z.object({
  password: z.string().min(1).max(128).optional(),
})

export const exportQuerySchema = z.object({
  type: z.enum(['link']).optional(),
  client: z.string().trim().min(1).max(64).optional(),
}).refine((value) => value.type === 'link' || value.client !== undefined, 'client or type=link is required')

export const adminShareQuerySchema = z.object({
  user: userIdSchema.optional(),
  subscription: subscriptionIdSchema.optional(),
  status: shareStatusSchema.optional(),
})

export type ShareSettings = z.infer<typeof shareSettingsSchema>
export type ShareRecord = z.infer<typeof shareRecordSchema>
export type ShareStatus = z.infer<typeof shareStatusSchema>
export type CreateShareInput = z.infer<typeof createShareSchema>
export type UpdateShareInput = z.infer<typeof updateShareSchema>
export type AdminShareQuery = z.infer<typeof adminShareQuerySchema>

export const DEFAULT_SHARE_SETTINGS: ShareSettings = {
  enabled: true,
  createAllowed: true,
  maxSharesPerSubscription: 5,
  maxActiveSharesPerUser: 20,
  maxValidityDays: 90,
  defaultAllowOriginalLink: false,
  defaultAccessControl: 'none',
  requireLoginDefault: false,
  publicBaseUrl: '',
}

export type ShareView = {
  id: string
  ownerUserId: string
  subscriptionId: string
  tokenPrefix: string
  remark: string
  status: ShareStatus
  accessControl: 'none' | 'password'
  expiresAt: string
  allowOriginalLink: boolean
  showSubscriptionName: boolean
  showGroups: boolean
  showExpiry: boolean
  showNodeNames: boolean
  requireLogin: boolean
  maxAccessCount: number | null
  accessCount: number
  lastAccessedAt: string | null
  lastOriginalRevealAt: string | null
  createdAt: string
  updatedAt: string
}

export const toShareView = (record: ShareRecord): ShareView => ({
  id: record.id,
  ownerUserId: record.ownerUserId,
  subscriptionId: record.subscriptionId,
  tokenPrefix: record.tokenPrefix,
  remark: record.remark,
  status: record.status,
  accessControl: record.accessControl.mode,
  expiresAt: record.expiresAt,
  allowOriginalLink: record.allowOriginalLink,
  showSubscriptionName: record.showSubscriptionName,
  showGroups: record.showGroups,
  showExpiry: record.showExpiry,
  showNodeNames: record.showNodeNames,
  requireLogin: record.requireLogin,
  maxAccessCount: record.maxAccessCount,
  accessCount: record.accessCount,
  lastAccessedAt: record.lastAccessedAt,
  lastOriginalRevealAt: record.lastOriginalRevealAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

export type ShareMeta = {
  nodeCount: number
  subscriptionName?: string
  groupNames?: string[]
  expiresAt?: string
  nodeNames?: string[]
}
