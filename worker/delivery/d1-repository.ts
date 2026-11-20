import { apiError } from '../platform/api-error.js'
import type { User } from '../accounts/schema.js'
import { batch, type AppDatabase } from '../db/db.js'
import { userAnchorStatements } from '../db/ensure-users.js'
import {
  DELIVERY_SETTING_KEYS,
  countRows,
  deleteSettings,
  upsertSettingStatement,
} from '../db/module-switch.js'
import { decodeSettingJson } from '../db/settings-repository.js'
import { convertDelivery, type SubscriptionGroupRow, type SubscriptionRow } from '../migration/delivery.js'
import { deliverySnapshotSchema, emptyDeliverySnapshot, type DeliverySnapshot } from './schema.js'

export type DeliveryCounts = {
  subscriptions: number
  subscriptionGroups: number
}

type SubscriptionSql = {
  id: string
  user_id: string | null
  name: string
  token_hash: string
  token_prefix: string
  encrypted_token: string
  enabled: number
  default_client: string
  revision: number
  starts_at: number | null
  expires_at: number | null
  created_at: string
  updated_at: string
}

type SubscriptionGroupSql = {
  subscription_id: string
  group_id: string
  position: number
}

const DELIVERY_META_KEYS = [
  DELIVERY_SETTING_KEYS.schemaVersion,
  DELIVERY_SETTING_KEYS.revision,
  DELIVERY_SETTING_KEYS.updatedAt,
  DELIVERY_SETTING_KEYS.nextSubscriptionId,
  DELIVERY_SETTING_KEYS.entityOrder,
] as const

function corrupt(): never {
  throw new Error('Delivery snapshot is corrupt')
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    corrupt()
  }
}

function parseStoredOrder(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// Fallback for a missing or out-of-sync delivery_entity_order (a legacy import
// once dropped the key and took every delivery page down): keep the stored
// relative order for subscriptions that still exist, drop stale ids, and
// append any missing subscriptions by ascending id instead of rejecting the
// whole snapshot. Read-only: the derived order is never written back.
function resolveSubscriptionOrder<T extends { id: string }>(rows: T[], storedOrder: unknown): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const kept: string[] = []
  if (Array.isArray(storedOrder)) {
    for (const item of storedOrder) {
      if (typeof item === 'string' && byId.has(item) && !kept.includes(item)) kept.push(item)
    }
  }
  const missing = rows
    .map((row) => row.id)
    .filter((id) => !kept.includes(id))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const resolved = [...kept, ...missing]
  const intact = Array.isArray(storedOrder)
    && storedOrder.length === resolved.length
    && storedOrder.every((id, index) => id === resolved[index])
  if (!intact) {
    console.warn('[delivery] delivery_entity_order missing or out of sync; using derived subscription order')
  }
  return resolved.map((id) => byId.get(id)!)
}

function idsByPosition(rows: { position: number, id: string }[]): string[] {
  return [...rows].sort((left, right) => left.position - right.position).map((row) => row.id)
}

export async function clearDeliveryStorage(db: AppDatabase): Promise<void> {
  await batch(db, [
    db.prepare('DELETE FROM subscription_groups'),
    db.prepare('DELETE FROM subscriptions'),
  ])
  await deleteSettings(db, DELIVERY_META_KEYS)
}

export async function deliveryCounts(db: AppDatabase): Promise<DeliveryCounts> {
  const [subscriptions, subscriptionGroups] = await Promise.all([
    countRows(db, 'subscriptions'),
    countRows(db, 'subscription_groups'),
  ])
  return { subscriptions, subscriptionGroups }
}

export async function readDeliveryFromD1(db: AppDatabase): Promise<DeliverySnapshot> {
  try {
    const placeholders = DELIVERY_META_KEYS.map(() => '?').join(', ')
    const [subscriptions, groups, metadata] = await batch(db, [
      db.prepare('SELECT * FROM subscriptions'),
      db.prepare('SELECT subscription_id, group_id, position FROM subscription_groups ORDER BY subscription_id, position'),
      db.prepare(`SELECT key, value FROM system_settings WHERE key IN (${placeholders})`).bind(...DELIVERY_META_KEYS),
    ])
    const subscriptionRows = subscriptions.results as SubscriptionSql[]
    const groupRows = groups.results as SubscriptionGroupSql[]
    const metadataRows = metadata.results as { key: string; value: string }[]
    const storedOrderRaw = metadataRows.find(row => row.key === DELIVERY_SETTING_KEYS.entityOrder)?.value ?? null
    const settings = new Map(metadataRows
      .filter(row => row.key !== DELIVERY_SETTING_KEYS.entityOrder)
      .map(row => [row.key, decodeSettingJson(row.value)]))
    const revision = settings.get(DELIVERY_SETTING_KEYS.revision)
    if (revision === undefined && subscriptionRows.length === 0) return emptyDeliverySnapshot()

    const schemaVersion = settings.get(DELIVERY_SETTING_KEYS.schemaVersion)
    const updatedAt = settings.get(DELIVERY_SETTING_KEYS.updatedAt)
    const nextSubscriptionId = settings.get(DELIVERY_SETTING_KEYS.nextSubscriptionId)
    if (
      schemaVersion !== 1 ||
      typeof revision !== 'number' ||
      typeof updatedAt !== 'string' ||
      typeof nextSubscriptionId !== 'number'
    ) corrupt()

    const ordered = resolveSubscriptionOrder(subscriptionRows, parseStoredOrder(storedOrderRaw))
    const snapshot = {
      schemaVersion: 1 as const,
      revision,
      updatedAt,
      nextSubscriptionId,
      subscriptions: ordered.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        groupIds: idsByPosition(
          groupRows
            .filter((group) => group.subscription_id === row.id)
            .map((group) => ({ position: group.position, id: group.group_id })),
        ),
        tokenHash: row.token_hash,
        tokenPrefix: row.token_prefix,
        encryptedToken: parseJson(row.encrypted_token),
        enabled: row.enabled === 1,
        defaultClient: row.default_client,
        revision: row.revision,
        startsAt: row.starts_at,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    }
    return deliverySnapshotSchema.parse(snapshot)
  } catch (error) {
    if (error instanceof Error && error.message === 'Delivery snapshot is corrupt') throw error
    throw new Error('Delivery snapshot is corrupt')
  }
}

function subscriptionInsert(db: AppDatabase, row: SubscriptionRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO subscriptions (
      id, user_id, name, token_hash, token_prefix, encrypted_token,
      enabled, default_client, revision, starts_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      name = excluded.name,
      token_hash = excluded.token_hash,
      token_prefix = excluded.token_prefix,
      encrypted_token = excluded.encrypted_token,
      enabled = excluded.enabled,
      default_client = excluded.default_client,
      revision = excluded.revision,
      starts_at = excluded.starts_at,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
  ).bind(
    row.id,
    row.user_id,
    row.name,
    row.token_hash,
    row.token_prefix,
    row.encrypted_token,
    row.enabled,
    row.default_client,
    row.revision,
    row.starts_at,
    row.expires_at,
    row.created_at,
    row.updated_at,
  )
}

function groupInsert(db: AppDatabase, row: SubscriptionGroupRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO subscription_groups (subscription_id, group_id, position) VALUES (?, ?, ?)`,
  ).bind(row.subscription_id, row.group_id, row.position)
}

export async function persistDeliverySnapshot(
  db: AppDatabase,
  snapshot: DeliverySnapshot,
  users: readonly User[],
  bindingStatement?: D1PreparedStatement,
  expectedRevision?: number,
): Promise<void> {
  const converted = convertDelivery(snapshot)
  const ids = converted.rows.subscriptions.map((row) => row.id)
  const idJson = JSON.stringify(ids)
  const statements: D1PreparedStatement[] = [
    ...userAnchorStatements(db, users, converted.rows.subscriptions.flatMap((row) => row.user_id ? [row.user_id] : [])),
    db.prepare('DELETE FROM subscriptions WHERE id NOT IN (SELECT value FROM json_each(?))').bind(idJson),
    ...converted.rows.subscriptions.map((row) => subscriptionInsert(db, row)),
    db.prepare('DELETE FROM subscription_groups WHERE subscription_id IN (SELECT value FROM json_each(?))').bind(idJson),
    ...converted.rows.subscription_groups.map((row) => groupInsert(db, row)),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.schemaVersion, snapshot.schemaVersion, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.revision, snapshot.revision, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.updatedAt, snapshot.updatedAt, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.nextSubscriptionId, snapshot.nextSubscriptionId, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.entityOrder, ids, snapshot.updatedAt),
  ]
  if (bindingStatement) statements.push(bindingStatement)
  if (expectedRevision !== undefined) {
    // Updating the metadata in this guard would itself overwrite a concurrent
    // writer. A NULL value instead aborts the batch when the snapshot changed.
    statements.unshift(db.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, CASE WHEN COALESCE((SELECT value FROM system_settings WHERE key=?), '0')=? THEN ? ELSE NULL END, ?)
      ON CONFLICT(key) DO NOTHING
    `).bind(DELIVERY_SETTING_KEYS.revision, DELIVERY_SETTING_KEYS.revision, String(expectedRevision), String(expectedRevision), snapshot.updatedAt))
  }
  try {
    await batch(db, statements)
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOT NULL constraint failed: system_settings.value')) {
      throw apiError(409, bindingStatement ? 'TEMPLATE_CONFLICT' : 'SUBSCRIPTION_CONFLICT', '订阅已被修改，请刷新后重试')
    }
    throw error
  }
}
