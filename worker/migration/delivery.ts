import { deliverySnapshotSchema, type DeliverySnapshot } from '../delivery/schema.js'

export interface ConversionReport {
  converted: number
  skipped: number
  anomalies: string[]
}

export interface DeliveryConversionResult {
  rows: {
    subscriptions: SubscriptionRow[]
    subscription_groups: SubscriptionGroupRow[]
  }
  report: ConversionReport
}

export interface SubscriptionRow {
  id: string
  user_id: string
  name: string
  token_hash: string
  token_prefix: string
  encrypted_token: string
  enabled: 0 | 1
  default_client: string
  revision: number
  starts_at: number | null
  expires_at: number | null
  created_at: string
  updated_at: string
}

export interface SubscriptionGroupRow {
  subscription_id: string
  group_id: string
  position: number
}

export function convertDelivery(kvValue: unknown): DeliveryConversionResult {
  const report: ConversionReport = { converted: 0, skipped: 0, anomalies: [] }
  const snapshot = deliverySnapshotSchema.parse(kvValue) as DeliverySnapshot

  // Convert subscriptions
  const subscriptions: SubscriptionRow[] = snapshot.subscriptions.map((sub) => ({
    id: sub.id,
    user_id: sub.userId,
    name: sub.name,
    token_hash: sub.tokenHash,
    token_prefix: sub.tokenPrefix,
    encrypted_token: JSON.stringify(sub.encryptedToken),
    enabled: sub.enabled ? 1 : 0,
    default_client: sub.defaultClient,
    revision: sub.revision,
    starts_at: sub.startsAt ?? null,
    expires_at: sub.expiresAt ?? null,
    created_at: sub.createdAt,
    updated_at: sub.updatedAt,
  }))

  // Convert subscription_groups
  const subscription_groups: SubscriptionGroupRow[] = []
  for (const sub of snapshot.subscriptions) {
    for (let i = 0; i < sub.groupIds.length; i++) {
      subscription_groups.push({
        subscription_id: sub.id,
        group_id: sub.groupIds[i],
        position: i,
      })
    }
  }

  report.converted = subscriptions.length + subscription_groups.length

  return { rows: { subscriptions, subscription_groups }, report }
}