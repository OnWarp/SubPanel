import { apiError } from '../platform/api-error.js'
import { decryptText, encryptedValueSchema, hashToken, randomToken, readCryptoMaterial } from '../platform/crypto.js'
import { ACCOUNTS_D1_READY_KEY, CATALOG_D1_READY_KEY, isModuleReady, type DataEnv } from '../db/module-switch.js'
import type { RenderClient } from '../renderers/index.js'
import { createToken } from './service.js'

export const userSubscriptionReady = 'unified_subscription_ready'
export const userSubscriptionPublicReady = 'unified_subscription_public_ready'
export const subscriptionNotFound = () => apiError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
export const bindingConflict = () => apiError(409, 'BINDING_CONFLICT', '授权已更新，请刷新后重试')

export async function requireUnifiedSubscription(db: D1Database, publicAccess = false) {
  if (!await isModuleReady(db, userSubscriptionReady) ||
    (publicAccess && !await isModuleReady(db, userSubscriptionPublicReady))) throw subscriptionNotFound()
  if (!await isModuleReady(db, ACCOUNTS_D1_READY_KEY) || !await isModuleReady(db, CATALOG_D1_READY_KEY)) {
    throw apiError(503, 'UNIFIED_SUBSCRIPTION_UNAVAILABLE', '统一订阅暂不可用')
  }
}

export type UserAccess = {
  user_id: string
  token_hash: string | null
  encrypted_token: string | null
  enabled: number | null
  default_client: RenderClient | null
  revision: number | null
  account_enabled: number
  deleted_at: string | null
}

export function readUserAccess(db: D1Database, identity: { userId: string } | { tokenHash: string }) {
  return db.prepare(`SELECT u.id AS user_id, u.enabled AS account_enabled, u.deleted_at,
    a.token_hash, a.encrypted_token, a.enabled, a.default_client, a.revision
    FROM users u LEFT JOIN user_subscription_access a ON a.user_id=u.id
    WHERE ${'userId' in identity ? 'u.id' : 'a.token_hash'}=?`)
    .bind('userId' in identity ? identity.userId : identity.tokenHash).first<UserAccess>()
}

export function accountAvailable(access: UserAccess | null): access is UserAccess {
  return access !== null && access.account_enabled === 1 && access.deleted_at === null
}

export async function prepareUserAccess(env: DataEnv, userId: string, now: string) {
  const token = await createToken(env.DATA, randomToken())
  return env.DB.prepare(`INSERT INTO user_subscription_access
    (user_id,token_hash,token_prefix,encrypted_token,enabled,created_at,updated_at)
    SELECT id,?,?,?,1,?,? FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE token_hash=?)
    ON CONFLICT(user_id) DO NOTHING`)
    .bind(token.tokenHash, token.tokenPrefix, JSON.stringify(token.encryptedToken), now, now, userId, token.tokenHash)
}

export async function resetUserToken(env: DataEnv, userId: string, expectedRevision: number, actor: string) {
  const { tokenHash, tokenPrefix, encryptedToken } = await createToken(env.DATA, randomToken())
  const now = new Date().toISOString()
  const [result] = await env.DB.batch([
    env.DB.prepare(`UPDATE user_subscription_access SET token_hash=?,token_prefix=?,encrypted_token=?,
      revision=revision+1,updated_at=? WHERE user_id=? AND revision=? AND enabled=1
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE token_hash=?)`)
      .bind(tokenHash, tokenPrefix, JSON.stringify(encryptedToken), now, userId, expectedRevision, userId, tokenHash),
    env.DB.prepare(`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,detail,created_at)
      SELECT ?,?,'subscription.user_token_reset','user',?,'{}',? WHERE changes()=1`)
      .bind(crypto.randomUUID(), actor, userId, now),
  ])
  if (result.meta.changes !== 1) throw bindingConflict()
  return { revision: expectedRevision + 1 }
}

export async function revealUserToken(env: DataEnv, access: UserAccess | null) {
  if (!accountAvailable(access) || access.enabled !== 1 || !access.encrypted_token) return null
  const encrypted = encryptedValueSchema.parse(JSON.parse(access.encrypted_token))
  const token = await decryptText(encrypted, (await readCryptoMaterial(env.DATA)).encryptionKey)
  if (await hashToken(token) !== access.token_hash) throw subscriptionNotFound()
  return token
}

export async function unifiedOperationsEnabled(db: D1Database) {
  return await isModuleReady(db, userSubscriptionReady) && await isModuleReady(db, userSubscriptionPublicReady)
}
