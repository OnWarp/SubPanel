import { z } from 'zod'
import { apiError } from '../platform/api-error.js'
import { decryptText, hashToken, readCryptoMaterial } from '../platform/crypto.js'
import { ACCOUNTS_D1_READY_KEY, CATALOG_D1_READY_KEY, DELIVERY_D1_READY_KEY, SHARES_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { auditStatement } from '../admin/audit.js'
import type { SubscriptionRow } from '../migration/delivery.js'
import { readArtifactCatalog } from './artifacts.js'
import { maxBindings } from './bindings.js'
import { selectedNodes } from './compiler.js'
import { parseDeliveryRow, subscriptionSelections } from './d1-repository.js'
import { templateInputSchema } from './entitlement-templates.js'
import { effectiveStartsAt } from './expiry.js'
import { verifyShadowUser } from './shadow.js'
import { accountAvailable, prepareUserAccess, readUserAccess } from './user-access.js'

export const migrationId = z.string().min(1).max(128)
type LegacyRow = SubscriptionRow & {
  version_id: string | null; template_id: string | null; historical: number;
  group_ids: string; node_ids: string; conversion_override: number
}
const legacySelect = `SELECT s.*, ${subscriptionSelections},
  (EXISTS (SELECT 1 FROM subscription_template_bindings WHERE subscription_id=s.id AND mode<>'inherit')
  OR EXISTS (SELECT 1 FROM conversion_bindings WHERE subscription_id=s.id AND mode<>'inherit')) AS conversion_override,
  v.id AS version_id,v.template_id,coalesce(v.version_no < (
    SELECT max(version_no) FROM entitlement_template_versions WHERE template_id=v.template_id
  ),0) AS historical
  FROM subscriptions s LEFT JOIN subscription_template_origins o ON o.subscription_id=s.id
  LEFT JOIN redemption_records r ON r.subscription_id=s.id
  LEFT JOIN redemption_codes c ON c.id=r.code_id LEFT JOIN redemption_batches b ON b.id=c.batch_id
  LEFT JOIN entitlement_template_versions v ON v.id=coalesce(o.version_id,b.template_version_id)`

export async function requireBackfillReady(db: D1Database) {
  const ready = await Promise.all([ACCOUNTS_D1_READY_KEY, CATALOG_D1_READY_KEY, DELIVERY_D1_READY_KEY, SHARES_D1_READY_KEY]
    .map(key => isModuleReady(db, key)))
  if (ready.includes(false)) throw apiError(409, 'MIGRATION_D1_NOT_READY', '迁移数据尚未就绪')
}

export async function inventory(db: D1Database, after: string) {
  const [users, orphaned, counts, batches] = await db.batch<Record<string, string | number>>([
    db.prepare(`SELECT DISTINCT user_id FROM subscriptions WHERE user_id>? ORDER BY user_id LIMIT 21`).bind(after),
    db.prepare('SELECT id FROM subscriptions WHERE user_id IS NULL ORDER BY id LIMIT 20'),
    db.prepare(`SELECT
      (SELECT count(*) FROM subscriptions WHERE user_id IS NULL) AS orphaned,
      (SELECT count(*) FROM unified_subscription_mappings) AS backfilled,
      (SELECT count(*) FROM shares WHERE status='active' AND expires_at>?) AS activeShares,
      (SELECT count(*) FROM redemption_codes c JOIN redemption_batches b ON b.id=c.batch_id
        WHERE c.revoked=0 AND c.used_count<c.max_uses AND b.enabled=1 AND b.redeem_deadline>?) AS unusedCodes`)
      .bind(new Date().toISOString(), Date.now()),
    db.prepare(`SELECT b.id AS batchId,count(*) AS codes
      FROM redemption_batches b JOIN redemption_codes c ON c.batch_id=b.id
      JOIN entitlement_template_versions v ON v.id=b.template_version_id
      WHERE b.enabled=1 AND b.redeem_deadline>? AND c.revoked=0 AND c.used_count<c.max_uses
        AND EXISTS (SELECT 1 FROM entitlement_template_versions newer
          WHERE newer.template_id=v.template_id AND newer.version_no>v.version_no)
      GROUP BY b.id ORDER BY b.id LIMIT 20`).bind(Date.now()),
  ])
  const ids = users.results.map(row => row.user_id as string)
  return {
    users: ids.slice(0, 20), next: ids.length > 20 ? ids[19] : null,
    orphanSamples: orphaned.results.map(row => row.id), counts: counts.results[0], historicalCodeBatches: batches.results,
  }
}

async function inspect(env: DataEnv, userId: string, actor: string) {
  const [access, rows, checkpoint, catalog, bindings, shares] = await Promise.all([
    readUserAccess(env.DB, { userId }),
    env.DB.prepare(`${legacySelect} WHERE s.user_id=? ORDER BY s.id LIMIT ?`).bind(userId, maxBindings + 1).all<LegacyRow>(),
    env.DB.prepare('SELECT source_snapshot FROM unified_subscription_checkpoints WHERE user_id=?').bind(userId).first<string>('source_snapshot'),
    readArtifactCatalog(env),
    env.DB.prepare('SELECT 1 FROM user_template_bindings WHERE user_id=? LIMIT 1').bind(userId).first(),
    env.DB.prepare("SELECT count(*) AS total FROM shares WHERE owner_user_id=? AND status='active' AND expires_at>?")
      .bind(userId, new Date().toISOString()).first<number>('total'),
  ])
  const blockers = new Set<string>()
  if (!accountAvailable(access) || access.enabled === 0) blockers.add('ACCOUNT_UNAVAILABLE')
  if (!rows.results.length) blockers.add('NO_LEGACY_SUBSCRIPTIONS')
  if (rows.results.length > maxBindings) blockers.add('BINDING_LIMIT')
  if (bindings && checkpoint === null) blockers.add('EXISTING_BINDINGS')
  if (shares) blockers.add('LEGACY_SHARE_SCOPE_REVIEW_REQUIRED')
  const material = rows.results.length ? await readCryptoMaterial(env.DATA).catch(() => null) : null
  const now = Date.now()
  const seen = new Set<string>()
  const entries = []
  for (const row of rows.results) {
    if (row.conversion_override) blockers.add('CONVERSION_OVERRIDE')
    if (row.plan_id || row.traffic_gb || row.speed_limit_mbps || row.device_limit) blockers.add('PLAN_POLICY_UNVERIFIED')
    const duplicate = row.template_id !== null && seen.has(row.template_id)
    if (row.template_id) seen.add(row.template_id)
    let subscription = null
    try {
      subscription = parseDeliveryRow(row, JSON.parse(row.group_ids), JSON.parse(row.node_ids))
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
    }
    let recoverable = false
    if (material && subscription?.encryptedToken) {
      try {
        recoverable = await hashToken(await decryptText(subscription.encryptedToken, material.encryptionKey)) === subscription.tokenHash
      } catch {
        recoverable = false
      }
    }
    if (!recoverable) blockers.add('TOKEN_UNRECOVERABLE')
    if (subscription?.revision !== row.revision || subscription?.userId !== userId) blockers.add('SOURCE_CHANGED')
    let input
    const starts = subscription && effectiveStartsAt(subscription)
    if (subscription && starts !== null) {
      if ((!Number.isFinite(Date.parse(subscription.createdAt)) && subscription.startsAt === null)
          || (subscription.expiresAt !== null && subscription.expiresAt <= starts)) blockers.add('LEGACY_WINDOW_INVALID')
      input = templateInputSchema.safeParse({ name: '迁移专属模板', config: {
        duration: { value: 1, unit: 'day' }, quotaBytes: null, resetPolicy: 'none',
        groupIds: subscription.groupIds, nodeIds: subscription.nodeIds ?? [], limits: { speedLimitMbps: 0 },
      } })
      if (!input.success) blockers.add('RESOURCE_SCOPE_REVIEW_REQUIRED')
    }
    entries.push({ row, subscription, starts, input: input?.data, recoverable, duplicate,
      future: starts !== null && starts > now })
  }
  const snapshot = JSON.stringify(rows.results.map(({ id, revision }) => [id, revision]))
  if (checkpoint !== null && checkpoint !== snapshot) blockers.add('SOURCE_CHANGED')
  const digest = await hashToken(JSON.stringify([actor, userId, snapshot, catalog.revision, checkpoint, [...blockers],
    entries.map(({ row, input, starts }) => [row.id, row.version_id, row.template_id, row.historical,
      row.token_hash, row.enabled, row.plan_revoked, row.expires_at, starts, input])]))
  const report = {
    userId, digest, executed: checkpoint !== null, blockers: [...blockers],
    subscriptions: entries.map(({ row, recoverable, future, duplicate }) => ({
      id: row.id, historicalVersion: Boolean(row.historical), duplicate, future, recoverable,
      limited: Boolean(row.plan_id || row.traffic_gb || row.speed_limit_mbps || row.device_limit),
    })),
  }
  return { report, entries, catalog, snapshot }
}

export async function previewBackfill(env: DataEnv, userId: string, actor: string) {
  return (await inspect(env, userId, actor)).report
}

export async function executeBackfill(env: DataEnv, userId: string, actor: string, digest: string) {
  const { report, entries, catalog, snapshot } = await inspect(env, userId, actor)
  if (report.executed && !report.blockers.length) return { executed: true }
  if (report.digest !== digest || report.blockers.length) throw apiError(409, 'MIGRATION_REVIEW_REQUIRED', '请重新预检并处理阻断项')
  const now = new Date().toISOString()
  const records = entries.map(({ subscription, input, starts, row }) => {
    if (!subscription || !input || starts === null) throw apiError(409, 'MIGRATION_REVIEW_REQUIRED', '请重新预检')
    return {
      legacyId: row.id, templateId: crypto.randomUUID(), versionId: crypto.randomUUID(),
      config: input.config, starts, expiry: subscription.expiresAt,
      status: row.plan_revoked ? 'revoked' : subscription.enabled ? 'active' : 'paused',
      revision: row.revision, tokenHash: subscription.tokenHash,
      nodes: selectedNodes(catalog, input.config).filter(node => node.enabled).map(node => node.id),
    }
  })
  const payload = JSON.stringify(records)
  const statements = [
    env.DB.prepare(`INSERT INTO unified_subscription_checkpoints (user_id,actor_user_id,source_snapshot,created_at)
      VALUES (?,?,?,?)`).bind(userId, actor, snapshot, now),
    await prepareUserAccess(env, userId, now),
    env.DB.prepare(`INSERT INTO entitlement_templates (id,name,description,status,allow_redemption,revision,created_by,created_at,updated_at)
      SELECT value->>'templateId','迁移专属模板','','enabled',0,1,?,?,? FROM json_each(?)`).bind(actor, now, now, payload),
    env.DB.prepare(`INSERT INTO private_entitlement_templates (template_id,owner_user_id)
      SELECT value->>'templateId',? FROM json_each(?)`).bind(userId, payload),
    env.DB.prepare(`INSERT INTO entitlement_template_versions (id,template_id,version_no,schema_version,config_json,created_by,created_at)
      SELECT value->>'versionId',value->>'templateId',1,1,value->'config',?,? FROM json_each(?)`).bind(actor, now, payload),
    env.DB.prepare(`INSERT INTO user_template_bindings (user_id,template_id,starts_at,expires_at,status,created_at,updated_at)
      SELECT ?,value->>'templateId',value->>'starts',value->>'expiry',value->>'status',?,? FROM json_each(?)`).bind(userId, now, now, payload),
    env.DB.prepare(`INSERT INTO unified_subscription_mappings
      (legacy_subscription_id,user_id,template_id,source_revision,source_token_hash,original_node_ids,status,created_at)
      SELECT value->>'legacyId',?,value->>'templateId',value->>'revision',value->>'tokenHash',value->'nodes','backfilled',?
      FROM json_each(?)`).bind(userId, now, payload),
    env.DB.prepare('UPDATE user_subscription_access SET revision=revision+1,updated_at=? WHERE user_id=?').bind(now, userId),
    auditStatement(env.DB, actor, 'subscription.shadow_backfill', 'user', userId, { mappings: records.length }, now),
  ]
  try {
    await env.DB.batch(statements)
  } catch (error) {
    if (error instanceof Error && /UNIFIED_MIGRATION_SOURCE_CHANGED|UNIQUE constraint failed: unified_subscription_checkpoints/.test(error.message)) {
      throw apiError(409, 'MIGRATION_REVIEW_REQUIRED', '迁移状态已更新，请重新预检')
    }
    throw error
  }
  return { executed: true }
}

export async function reconcileBackfill(env: DataEnv, userId: string) {
  const [shadow, mappings, missing] = await Promise.all([
    readArtifactCatalog(env).then(catalog => verifyShadowUser(env, userId, Date.now(), catalog)),
    env.DB.prepare(`SELECT m.legacy_subscription_id AS legacyId,m.template_id AS templateId,m.status,
      (s.revision=m.source_revision AND s.token_hash=m.source_token_hash AND s.user_id=m.user_id) AS current
      FROM unified_subscription_mappings m JOIN subscriptions s ON s.id=m.legacy_subscription_id
      WHERE m.user_id=? ORDER BY m.legacy_subscription_id`).bind(userId).all<{ legacyId: string; templateId: string; status: string; current: number }>(),
    env.DB.prepare(`SELECT count(*) AS total FROM subscriptions s WHERE user_id=? AND NOT EXISTS
      (SELECT 1 FROM unified_subscription_mappings m WHERE m.legacy_subscription_id=s.id AND m.user_id=s.user_id)`)
      .bind(userId).first<number>('total'),
  ])
  const reasons = [...shadow.reasons]
  if (missing || !mappings.results.length) reasons.push('MAPPING_INCOMPLETE')
  if (mappings.results.some(mapping => !mapping.current)) reasons.push('SOURCE_CHANGED')
  return { ...shadow, matches: reasons.length === 0, reasons, mappings: mappings.results }
}
