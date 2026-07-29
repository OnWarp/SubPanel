import { z } from 'zod'
import { encryptedValueSchema, type EncryptedValue } from '../platform/crypto.js'
import { groupIdSchema } from '../catalog/schema.js'
import { userIdSchema } from '../accounts/schema.js'

export const subscriptionIdSchema = z.string().regex(/^sub_[1-9]\d*$/)
export const tokenHashSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const clientIdSchema = z.enum([
  'mihomo',
  'singbox',
  'surge',
  'loon',
  'quantumultx',
  'v2rayn',
  'nekobox',
  'shadowrocket',
  'generic',
])

export const renderDiagnosticSchema = z.object({
  nodeId: z.string().min(1),
  nodeName: z.string().min(1).optional(),
  protocol: z.string().min(1).optional(),
  code: z.enum(['UNSUPPORTED_PROTOCOL', 'UNSUPPORTED_FIELD', 'INVALID_NODE']),
  outcome: z.enum(['included', 'skipped']).optional(),
  fields: z.array(z.string().min(1)).min(1).optional(),
  message: z.string().min(1),
})

const uniqueGroupIds = z.array(groupIdSchema).refine(
  (values) => new Set(values).size === values.length,
  'Duplicate group identifiers are not allowed',
)

export const subscriptionSchema = z.object({
  id: subscriptionIdSchema,
  userId: userIdSchema,
  name: z.string().trim().min(1).max(128),
  groupIds: uniqueGroupIds,
  tokenHash: tokenHashSchema,
  tokenPrefix: z.string().regex(/^[A-Za-z0-9_-]{8}$/),
  encryptedToken: encryptedValueSchema,
  enabled: z.boolean(),
  defaultClient: clientIdSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const deliverySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  nextSubscriptionId: z.number().int().positive(),
  subscriptions: z.array(subscriptionSchema),
}).superRefine((snapshot, ctx) => {
  const ids = new Set<string>()
  const tokenHashes = new Set<string>()
  let maxSubscriptionId = 0
  for (const [index, subscription] of snapshot.subscriptions.entries()) {
    if (ids.has(subscription.id)) {
      ctx.addIssue({ code: 'custom', path: ['subscriptions', index, 'id'], message: 'Duplicate subscription id' })
    }
    if (tokenHashes.has(subscription.tokenHash)) {
      ctx.addIssue({ code: 'custom', path: ['subscriptions', index, 'tokenHash'], message: 'Duplicate subscription token' })
    }
    ids.add(subscription.id)
    tokenHashes.add(subscription.tokenHash)
    maxSubscriptionId = Math.max(maxSubscriptionId, Number(subscription.id.slice('sub_'.length)))
  }
  if (snapshot.nextSubscriptionId <= maxSubscriptionId) {
    ctx.addIssue({ code: 'custom', path: ['nextSubscriptionId'], message: 'nextSubscriptionId must be greater than all existing subscription IDs' })
  }
})

export type SubscriptionId = z.infer<typeof subscriptionIdSchema>
export type TokenHash = z.infer<typeof tokenHashSchema>
export type ClientId = z.infer<typeof clientIdSchema>
export type Subscription = z.infer<typeof subscriptionSchema>
export type DeliverySnapshot = z.infer<typeof deliverySnapshotSchema>
export type RenderDiagnostic = z.infer<typeof renderDiagnosticSchema>
export type { EncryptedValue }

export type PublicSubscription = Omit<Subscription, 'tokenHash' | 'encryptedToken'>

export const toPublicSubscription = (subscription: Subscription): PublicSubscription => {
  const { tokenHash: _tokenHash, encryptedToken: _encryptedToken, ...publicValue } = subscription
  return publicValue
}

export const emptyDeliverySnapshot = (now = '1970-01-01T00:00:00.000Z'): DeliverySnapshot => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: now,
  nextSubscriptionId: 1,
  subscriptions: [],
})

const artifactFileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
const artifactContentTypeSchema = z.string().min(1).max(256).regex(/^[\x20-\x7E]+$/u)

export const compiledArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  client: clientIdSchema,
  body: z.string(),
  contentType: artifactContentTypeSchema,
  fileName: artifactFileNameSchema,
  etag: z.string().regex(/^"[A-Za-z0-9_-]{43}"$/),
  lastModified: z.iso.datetime(),
  subscriptionRevision: z.number().int().positive(),
  catalogRevision: z.number().int().nonnegative(),
  inputNodes: z.number().int().nonnegative(),
  outputNodes: z.number().int().nonnegative(),
  skippedNodes: z.number().int().nonnegative(),
  diagnostics: z.array(renderDiagnosticSchema),
  available: z.boolean(),
}).superRefine((artifact, ctx) => {
  if (artifact.outputNodes + artifact.skippedNodes > artifact.inputNodes) {
    ctx.addIssue({ code: 'custom', path: ['outputNodes'], message: 'Rendered node counts exceed input nodes' })
  }
  if (artifact.available !== (artifact.outputNodes > 0)) {
    ctx.addIssue({ code: 'custom', path: ['available'], message: 'Artifact availability does not match output nodes' })
  }
})

export type CompiledArtifact = z.infer<typeof compiledArtifactSchema>
