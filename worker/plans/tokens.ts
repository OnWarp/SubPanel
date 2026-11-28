import type { DataEnv } from '../db/module-switch.js'
import { createToken } from '../delivery/service.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { decryptText, encryptedValueSchema, hashToken, randomToken, readCryptoMaterial } from '../platform/crypto.js'
import type { SubscriptionScope, SubscriptionTokenRow } from './repository.js'

type TokenTarget = { userId: string; instanceId: string | null }

export async function preparePlanToken(env: DataEnv, target: TokenTarget, now: string) {
  const raw = randomToken()
  const { tokenHash, encryptedToken } = await createToken(env.DATA, raw)
  const row: SubscriptionTokenRow = {
    id: crypto.randomUUID(), scope: target.instanceId === null ? 'aggregate' : 'package',
    user_id: target.userId, user_plan_id: target.instanceId, token_digest: tokenHash,
    token_ciphertext: JSON.stringify(encryptedToken), revoked_at: null, created_at: now,
  }
  return { raw, row }
}

export async function revealPlanToken(env: DataEnv, row: SubscriptionTokenRow) {
  if (row.revoked_at !== null || row.token_ciphertext === null) return null
  const encrypted = encryptedValueSchema.parse(JSON.parse(row.token_ciphertext))
  const key = (await readCryptoMaterial(env.DATA)).encryptionKey
  const raw = await decryptText(encrypted, key)
  if (await hashToken(raw) !== row.token_digest) throw subscriptionNotFound()
  return raw
}

export function planStorageAvailable(db: D1Database) {
  return db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='subscription_tokens'").first<number>('present')
}

export function hasPlanAggregate(db: D1Database, userId: string) {
  return db.prepare(`SELECT 1 AS present FROM subscription_tokens WHERE user_id=? AND scope='aggregate' LIMIT 1`)
    .bind(userId).first<number>('present')
}

export function readPlanToken(db: D1Database, digest: string) {
  // Include revoked rows so migrated credentials can never fall through to the old reader.
  return db.prepare('SELECT * FROM subscription_tokens WHERE token_digest=?').bind(digest).first<SubscriptionTokenRow>()
}

export async function readAliasTarget(db: D1Database, digest: string): Promise<TokenTarget | null> {
  return db.prepare(`SELECT a.target_id AS userId, NULL AS instanceId FROM legacy_subscription_routes a
    WHERE a.legacy_token_digest=?1 AND a.revoked_at IS NULL AND a.target_scope='aggregate'
    UNION ALL
    SELECT i.user_id, i.id FROM legacy_subscription_routes a JOIN user_plans i ON i.id=a.target_id
    WHERE a.legacy_token_digest=?1 AND a.revoked_at IS NULL AND a.target_scope='package'`)
    .bind(digest).first<TokenTarget>()
}

export function revokeTargetCredentials(db: D1Database, scope: SubscriptionScope, targetId: string, now: string) {
  const column = scope === 'package' ? 'user_plan_id' : 'user_id'
  return [
    db.prepare(`UPDATE subscription_tokens SET revoked_at=? WHERE scope=? AND ${column}=? AND revoked_at IS NULL`)
      .bind(now, scope, targetId),
    db.prepare('UPDATE legacy_subscription_routes SET revoked_at=? WHERE target_scope=? AND target_id=? AND revoked_at IS NULL')
      .bind(now, scope, targetId),
  ]
}
