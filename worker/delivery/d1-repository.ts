import { versionUnavailable } from './entitlement-templates.js'
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
import { deliverySnapshotSchema, emptyDeliverySnapshot, subscriptionSchema, type DeliverySnapshot, type Subscription } from './schema.js'

export type DeliveryCounts = {
  subscriptions: number
  subscriptionGroups: number
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

export function parseStoredOrder(raw: string | null): unknown {
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
export function resolveSubscriptionOrder<T extends { id: string }>(rows: T[], storedOrder: unknown, warnOnMismatch = true): T[] {
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
  if (warnOnMismatch && !intact) {
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
    const [subscriptions, groups, metadata, nodes] = await batch(db, [
      db.prepare(`SELECT s.*, coalesce(sc.source_type, 'legacy') AS source_type,
        v.id AS entitlement_version_id, v.version_no AS entitlement_version_no, t.name AS entitlement_template_name
        FROM subscriptions s LEFT JOIN subscription_creation sc ON sc.subscription_id = s.id
        LEFT JOIN subscription_template_origins o ON o.subscription_id = s.id
        LEFT JOIN entitlement_template_versions v ON v.id = o.version_id
        LEFT JOIN entitlement_templates t ON t.id = v.template_id`),
      db.prepare('SELECT subscription_id, group_id, position FROM subscription_groups ORDER BY subscription_id, position'),
      db.prepare(`SELECT key, value FROM system_settings WHERE key IN (${placeholders})`).bind(...DELIVERY_META_KEYS),
      db.prepare('SELECT subscription_id, node_id FROM subscription_nodes ORDER BY subscription_id, position'),
    ])
    const subscriptionRows = subscriptions.results as (SubscriptionRow & {
      source_type: 'manual' | 'legacy'
      entitlement_version_id: string | null
      entitlement_version_no: number | null
      entitlement_template_name: string | null
    })[]
    const directIds = new Map<string, string[]>()
    for (const { subscription_id, node_id } of nodes.results as { subscription_id: string; node_id: string }[]) {
      const ids = directIds.get(subscription_id) ?? []
      ids.push(node_id)
      directIds.set(subscription_id, ids)
    }
    const groupRows = groups.results as SubscriptionGroupSql[]
    const metadataRows = metadata.results as { key: string; value: string }[]
    const storedOrderRaw = metadataRows.find(row => row.key === DELIVERY_SETTING_KEYS.entityOrder)?.value ?? null
    const settings = new Map(metadataRows
      .filter(row => row.key !== DELIVERY_SETTING_KEYS.entityOrder)
      .map(row => [row.key, decodeSettingJson(row.value)]))
    const revision = settings.get(DELIVERY_SETTING_KEYS.revision) ?? 0
    if (!settings.size && subscriptionRows.length === 0) return emptyDeliverySnapshot()

    const schemaVersion = settings.get(DELIVERY_SETTING_KEYS.schemaVersion) ?? 1
    const updatedAt = settings.get(DELIVERY_SETTING_KEYS.updatedAt) ?? emptyDeliverySnapshot().updatedAt
    const nextSubscriptionId = settings.get(DELIVERY_SETTING_KEYS.nextSubscriptionId) ?? 1
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
      nextSubscriptionId: subscriptionRows.reduce((next, row) => Math.max(next, Number(row.id.slice(4)) + 1), nextSubscriptionId),
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
        encryptedToken: row.encrypted_token === '{}' ? null : parseJson(row.encrypted_token),
        ...(directIds.has(row.id) ? { nodeIds: directIds.get(row.id) } : {}),
        ...(row.entitlement_version_id ? {
          sourceType: 'template',
          templateVersionId: row.entitlement_version_id,
          entitlementTemplateName: row.entitlement_template_name,
          entitlementVersionNumber: row.entitlement_version_no,
        } : row.source_type === 'manual' ? { sourceType: row.source_type } : {}),
        ...(row.plan_id || row.source_type === 'manual' || row.traffic_gb || row.speed_limit_mbps || row.device_limit ? {
          trafficGb: row.traffic_gb,
          speedLimitMbps: row.speed_limit_mbps,
          deviceLimit: row.device_limit,
        } : {}),
        ...(row.plan_id ? {
          planId: row.plan_id,
          planSource: row.plan_source,
          planNote: row.plan_note,
          planRevoked: row.plan_revoked === 1,
          lastRemindedAt: row.last_reminded_at,
        } : {}),
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

export async function readDeliverySubscription(db: AppDatabase, lookup: { tokenHash: string } | { id: string }) {
  const byToken = 'tokenHash' in lookup
  const selector = byToken ? 'token_hash' : 'id'
  const value = byToken ? lookup.tokenHash : lookup.id
  const [subscriptions, groups, nodes] = await batch(db, [
    db.prepare(`SELECT * FROM subscriptions WHERE ${selector} = ?`).bind(value),
    db.prepare(`SELECT group_id FROM subscription_groups
      WHERE subscription_id = (SELECT id FROM subscriptions WHERE ${selector} = ?) ORDER BY position`).bind(value),
    db.prepare(`SELECT node_id FROM subscription_nodes
      WHERE subscription_id = (SELECT id FROM subscriptions WHERE ${selector} = ?) ORDER BY position`).bind(value),
  ])
  const row = subscriptions.results[0] as SubscriptionRow | undefined
  if (!row || row.encrypted_token === '{}') return null
  return subscriptionSchema.parse({
    id: row.id, userId: row.user_id, name: row.name,
    groupIds: (groups.results as { group_id: string }[]).map(row => row.group_id),
    nodeIds: (nodes.results as { node_id: string }[]).map(row => row.node_id),
    tokenHash: row.token_hash, tokenPrefix: row.token_prefix, encryptedToken: parseJson(row.encrypted_token),
    enabled: row.enabled === 1, defaultClient: row.default_client, revision: row.revision,
    startsAt: row.starts_at, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
    planId: row.plan_id ?? undefined, planRevoked: row.plan_revoked === 1, speedLimitMbps: row.speed_limit_mbps,
  })
}

export async function isPublicSubscriptionCurrent(db: AppDatabase, subscription: Subscription) {
  return Boolean(await db.prepare(`SELECT 1 FROM subscriptions s WHERE s.id=? AND s.token_hash=? AND s.revision=?
    AND s.enabled=1 AND s.plan_revoked=0 AND s.encrypted_token <> '{}'
    AND (s.user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id=s.user_id AND u.enabled=1 AND u.deleted_at IS NULL))
    AND (s.plan_id IS NULL OR EXISTS (SELECT 1 FROM plans p WHERE p.id=s.plan_id AND p.enabled=1))`)
    .bind(subscription.id, subscription.tokenHash, subscription.revision).first())
}

export function subscriptionInsert(
  db: AppDatabase,
  row: Omit<SubscriptionRow, 'id'>,
  target: { id: string } | { where: string; bindings: string[] },
): D1PreparedStatement {
  const values = [
    row.user_id, row.name, row.token_hash, row.token_prefix, row.encrypted_token,
    row.enabled, row.default_client, row.revision, row.starts_at, row.expires_at, row.created_at, row.updated_at,
    row.plan_id, row.traffic_gb, row.speed_limit_mbps, row.device_limit, row.plan_source, row.plan_note,
    row.plan_revoked, row.last_reminded_at,
  ]
  const placeholders = values.map(() => '?').join(', ')
  const source = 'id' in target ? `VALUES (?, ${placeholders})
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
      updated_at = excluded.updated_at,
      plan_id = excluded.plan_id,
      traffic_gb = excluded.traffic_gb,
      speed_limit_mbps = excluded.speed_limit_mbps,
      device_limit = excluded.device_limit,
      plan_source = excluded.plan_source,
      plan_note = excluded.plan_note,
      plan_revoked = excluded.plan_revoked,
      last_reminded_at = CASE WHEN subscriptions.expires_at IS excluded.expires_at
        THEN subscriptions.last_reminded_at ELSE excluded.last_reminded_at END`
    : `SELECT 'sub_' || max(
      coalesce((SELECT max(cast(substr(id, 5) AS INTEGER)) + 1 FROM subscriptions), 1),
      coalesce((SELECT cast(value AS INTEGER) FROM system_settings WHERE key='next_subscription_id'), 1)
    ), ${placeholders} WHERE ${target.where}`
  return db.prepare(
    `INSERT INTO subscriptions (
      id, user_id, name, token_hash, token_prefix, encrypted_token,
      enabled, default_client, revision, starts_at, expires_at, created_at, updated_at,
      plan_id, traffic_gb, speed_limit_mbps, device_limit, plan_source, plan_note, plan_revoked, last_reminded_at
    ) ${source}`,
  ).bind(...('id' in target ? [target.id, ...values] : [...values, ...target.bindings]))
}

function groupInsert(db: AppDatabase, row: SubscriptionGroupRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO subscription_groups (subscription_id, group_id, position) VALUES (?, ?, ?)`,
  ).bind(row.subscription_id, row.group_id, row.position)
}

export type DeliveryCreationRequest = { id: string; keyHash: string; fingerprint: string }
export type DeliveryNodePolicyWrite = { id: string; nodeIds?: string[]; templateVersionId?: string }

export async function persistDeliverySnapshot(
  db: AppDatabase,
  snapshot: DeliverySnapshot,
  users: readonly User[],
  bindingStatement?: D1PreparedStatement,
  expectedRevision?: number,
  request?: DeliveryCreationRequest,
  policy?: DeliveryNodePolicyWrite,
): Promise<void> {
  const converted = convertDelivery(snapshot)
  const ids = converted.rows.subscriptions.map((row) => row.id)
  const idJson = JSON.stringify(ids)
  const statements: D1PreparedStatement[] = [
    ...(expectedRevision === undefined ? [db.prepare(`INSERT INTO system_settings (key, value, updated_at)
      SELECT 'delivery_import_conflict', NULL, ?
      WHERE EXISTS (SELECT 1 FROM subscription_template_origins) OR EXISTS (SELECT 1 FROM subscription_nodes)`)
      .bind(snapshot.updatedAt)] : []),
    ...userAnchorStatements(db, users, converted.rows.subscriptions.flatMap((row) => row.user_id ? [row.user_id] : [])),
    db.prepare('DELETE FROM subscriptions WHERE id NOT IN (SELECT value FROM json_each(?))').bind(idJson),
    ...converted.rows.subscriptions.map((row) => subscriptionInsert(db, row, { id: row.id })),
    ...(request ? [db.prepare(`INSERT INTO subscription_creation
      (subscription_id, source_type, request_key_hash, request_fingerprint) VALUES (?, 'manual', ?, ?)`)
      .bind(request.id, request.keyHash, request.fingerprint)] : []),
    db.prepare(`INSERT OR IGNORE INTO subscription_creation (subscription_id, source_type)
      SELECT value, 'manual' FROM json_each(?)`).bind(JSON.stringify(
      snapshot.subscriptions.filter((row) => row.sourceType === 'manual').map(({ id }) => id),
    )),
    db.prepare('DELETE FROM subscription_creation WHERE subscription_id IS NULL AND request_key_hash IS NULL'),
    db.prepare('DELETE FROM subscription_groups WHERE subscription_id IN (SELECT value FROM json_each(?))').bind(idJson),
    ...converted.rows.subscription_groups.map((row) => groupInsert(db, row)),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.schemaVersion, snapshot.schemaVersion, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.revision, snapshot.revision, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.updatedAt, snapshot.updatedAt, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.nextSubscriptionId, snapshot.nextSubscriptionId, snapshot.updatedAt),
    upsertSettingStatement(db, DELIVERY_SETTING_KEYS.entityOrder, ids, snapshot.updatedAt),
  ]
  if (bindingStatement) statements.push(bindingStatement)
  if (policy?.templateVersionId) {
    statements.push(db.prepare('INSERT INTO subscription_template_origins (subscription_id, version_id) VALUES (?, ?)')
      .bind(policy.id, policy.templateVersionId))
  }
  if (policy?.nodeIds) {
    const nodes = JSON.stringify(policy.nodeIds)
    statements.push(
      db.prepare('DELETE FROM subscription_nodes WHERE subscription_id = ? AND node_id NOT IN (SELECT value FROM json_each(?))')
        .bind(policy.id, nodes),
      db.prepare(`UPDATE subscription_nodes SET position = selected.key FROM json_each(?) AS selected
        WHERE subscription_id = ? AND node_id = selected.value AND position <> selected.key`).bind(nodes, policy.id),
      db.prepare(`INSERT INTO subscription_nodes (subscription_id, node_id, position)
        SELECT ?, selected.value, selected.key FROM json_each(?) AS selected WHERE NOT EXISTS (
          SELECT 1 FROM subscription_nodes WHERE subscription_id = ? AND node_id = selected.value
        )`).bind(policy.id, nodes, policy.id),
    )
  }
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
    if (error instanceof Error && error.message.includes('ENTITLEMENT_VERSION_UNAVAILABLE')) versionUnavailable()
    if (error instanceof Error && error.message.includes('SUBSCRIPTION_NODE_UNAVAILABLE')) {
      throw apiError(422, 'SUBSCRIPTION_NODE_UNAVAILABLE', '请选择当前可用的节点')
    }
    if (policy && error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) {
      throw apiError(409, 'SUBSCRIPTION_REFERENCE_CHANGED', '节点或分组已变更，请刷新后重试')
    }
    throw error
  }
}
