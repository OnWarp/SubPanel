import { auditStatement } from '../admin/audit.js'
import { apiError } from '../platform/api-error.js'
import { z } from 'zod'
import { readAccounts } from '../accounts/repository.js'
import { SHARES_D1_READY_KEY, SHARES_SETTING_KEYS, isModuleReady, type DataEnv } from '../db/module-switch.js'
import { getShareSettings, putSetting, putShareSettings } from '../db/settings-repository.js'
import {
  consumeVerifySlotD1,
  deleteShareByTokenHash,
  listSharesFromD1,
  readNextShareId,
  readShareFromD1,
  upsertShareRow,
} from './d1-repository.js'
import {
  canonicalPublicBaseUrl,
  DEFAULT_SHARE_SETTINGS,
  shareRecordSchema,
  shareSettingsSchema,
  tokenHashSchema,
  type ShareRecord,
  type ShareSettings,
} from './schema.js'

export const SHARE_SETTINGS_KEY = 'state:share-settings'
export const SHARE_SEQ_KEY = 'state:share-seq'

const ENTITY_KEY = /^share:[A-Za-z0-9_-]{43}$/u
const indexSchema = z.array(tokenHashSchema)
const sequenceSchema = z.object({ next: z.number().int().positive() })

export const shareEntityKey = (tokenHash: string): string => `share:${tokenHash}`
export const userIndexKey = (userId: string): string => `shareidx:user:${userId}`
export const subscriptionIndexKey = (subscriptionId: string): string => `shareidx:sub:${subscriptionId}`
export const shareCompiledPrefix = (tokenHash: string): string => `compiled:share:${tokenHash}:`
export const shareCompiledKey = (tokenHash: string, client: string): string => `${shareCompiledPrefix(tokenHash)}${client}`

function parseShare(raw: string): ShareRecord {
  try {
    return shareRecordSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Share record is corrupt')
  }
}

function indexFilter(key: string): { ownerUserId?: string, subscriptionId?: string } | null {
  if (key.startsWith('shareidx:user:')) return { ownerUserId: key.slice('shareidx:user:'.length) }
  if (key.startsWith('shareidx:sub:')) return { subscriptionId: key.slice('shareidx:sub:'.length) }
  return null
}

export async function readShareSettingsKv(kv: KVNamespace): Promise<ShareSettings> {
  const raw = await kv.get(SHARE_SETTINGS_KEY)
  if (raw === null) return { ...DEFAULT_SHARE_SETTINGS }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Share settings are corrupt')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Share settings are corrupt')
  }
  const parsed = shareSettingsSchema.safeParse({ ...DEFAULT_SHARE_SETTINGS, ...value })
  if (!parsed.success) throw new Error('Share settings are corrupt')
  const publicBaseUrl = canonicalPublicBaseUrl(parsed.data.publicBaseUrl)
  if (publicBaseUrl === null) throw new Error('Share settings are corrupt')
  return { ...parsed.data, publicBaseUrl }
}

async function writeShareSettingsKv(kv: KVNamespace, settings: ShareSettings): Promise<void> {
  const parsed = shareSettingsSchema.parse(settings)
  const publicBaseUrl = canonicalPublicBaseUrl(parsed.publicBaseUrl)
  if (publicBaseUrl === null) throw new Error('Share settings are corrupt')
  await kv.put(SHARE_SETTINGS_KEY, JSON.stringify({ ...parsed, publicBaseUrl }))
}

export async function readShareSettings(env: DataEnv): Promise<ShareSettings> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return getShareSettings(env.DB)
  return readShareSettingsKv(env.DATA)
}

export async function writeShareSettings(env: DataEnv, settings: ShareSettings): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    await putShareSettings(env.DB, settings)
    return
  }
  await writeShareSettingsKv(env.DATA, settings)
}

async function allocateShareIdKv(kv: KVNamespace): Promise<string> {
  const raw = await kv.get(SHARE_SEQ_KEY)
  let next = 1
  if (raw !== null) {
    try {
      next = sequenceSchema.parse(JSON.parse(raw)).next
    } catch {
      throw new Error('Share id sequence is corrupt')
    }
  }
  // The id counter is last-writer-wins. Concurrent creates can allocate the same id; token hashes still differ.
  await kv.put(SHARE_SEQ_KEY, JSON.stringify({ next: next + 1 }))
  return `shr_${next}`
}

export async function readShareSeqKv(kv: KVNamespace): Promise<number> {
  const raw = await kv.get(SHARE_SEQ_KEY)
  if (raw === null) return 1
  try {
    return sequenceSchema.parse(JSON.parse(raw)).next
  } catch {
    throw new Error('Share id sequence is corrupt')
  }
}

export async function allocateShareId(env: DataEnv): Promise<string> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    const next = await readNextShareId(env.DB)
    await putSetting(env.DB, SHARES_SETTING_KEYS.nextShareId, next + 1)
    return `shr_${next}`
  }
  return allocateShareIdKv(env.DATA)
}

export async function readShareKv(kv: KVNamespace, tokenHash: string): Promise<ShareRecord | null> {
  if (!tokenHashSchema.safeParse(tokenHash).success) return null
  const raw = await kv.get(shareEntityKey(tokenHash))
  if (raw === null) return null
  return parseShare(raw)
}

export async function readShare(env: DataEnv, tokenHash: string): Promise<ShareRecord | null> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    const row = await env.DB.prepare('SELECT record_json FROM user_subscription_shares WHERE token_hash=?')
      .bind(tokenHash).first<string>('record_json')
    return row ? parseShare(row) : readShareFromD1(env.DB, tokenHash)
  }
  return readShareKv(env.DATA, tokenHash)
}

export async function writeShareKv(kv: KVNamespace, record: ShareRecord): Promise<void> {
  const parsed = shareRecordSchema.parse(record)
  await kv.put(shareEntityKey(parsed.tokenHash), JSON.stringify(parsed))
}

export async function writeShare(env: DataEnv, record: ShareRecord): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    const accounts = await readAccounts(env)
    await upsertShareRow(env.DB, record, accounts.users)
    return
  }
  await writeShareKv(env.DATA, record)
}

export async function deleteShareKv(kv: KVNamespace, tokenHash: string): Promise<void> {
  await kv.delete(shareEntityKey(tokenHash))
}

export async function deleteShare(env: DataEnv, tokenHash: string): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    await deleteShareByTokenHash(env.DB, tokenHash)
    return
  }
  await deleteShareKv(env.DATA, tokenHash)
}

async function readIndex(kv: KVNamespace, key: string): Promise<string[]> {
  const raw = await kv.get(key)
  if (raw === null) return []
  try {
    const parsed = indexSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) throw new Error('Share index is corrupt')
    return parsed.data
  } catch (error) {
    if (error instanceof Error && error.message === 'Share index is corrupt') throw error
    throw new Error('Share index is corrupt')
  }
}

async function writeIndex(kv: KVNamespace, key: string, hashes: string[]): Promise<void> {
  // shareidx values are the whole tokenHash array. Concurrent writes are last-writer-wins.
  const unique = [...new Set(hashes)]
  if (unique.length === 0) {
    await kv.delete(key)
    return
  }
  await kv.put(key, JSON.stringify(unique))
}

async function listIndexedSharesKv(kv: KVNamespace, key: string): Promise<ShareRecord[]> {
  const hashes = await readIndex(kv, key)
  const records = await Promise.all(hashes.map(async (hash) => {
    const raw = await kv.get(shareEntityKey(hash))
    if (raw === null) return null
    return parseShare(raw)
  }))
  return records.filter((record): record is ShareRecord => record !== null)
}

export async function listIndexedShares(env: DataEnv, key: string): Promise<ShareRecord[]> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    const filter = indexFilter(key)
    if (!filter) return []
    const legacy = await listSharesFromD1(env.DB, filter)
    return filter.ownerUserId ? [...legacy, ...await listUnifiedShares(env, filter.ownerUserId)] : legacy
  }
  return listIndexedSharesKv(env.DATA, key)
}

export async function readShareValuesKv(kv: KVNamespace): Promise<unknown[]> {
  const values: unknown[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const listed = await kv.list({ prefix: 'share:', cursor })
    for (const { name } of listed.keys) {
      if (!ENTITY_KEY.test(name)) continue
      const raw = await kv.get(name)
      if (raw === null) continue
      try {
        values.push(JSON.parse(raw))
      } catch {
        values.push(raw)
      }
    }
    if (listed.list_complete) return values
    cursor = listed.cursor
  }
  throw new Error('Share listing did not finish')
}

export async function listAllSharesKv(kv: KVNamespace): Promise<ShareRecord[]> {
  const records: ShareRecord[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const listed = await kv.list({ prefix: 'share:', cursor })
    const batch = await Promise.all(listed.keys.map(async ({ name }) => {
      if (!ENTITY_KEY.test(name)) return null
      const raw = await kv.get(name)
      if (raw === null) return null
      return parseShare(raw)
    }))
    for (const record of batch) if (record) records.push(record)
    if (listed.list_complete) return records
    cursor = listed.cursor
  }
  throw new Error('Share listing did not finish')
}

export async function listAllShares(env: DataEnv): Promise<ShareRecord[]> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    return [...await listSharesFromD1(env.DB), ...await listUnifiedShares(env)]
  }
  return listAllSharesKv(env.DATA)
}

export async function addIndexHashKv(kv: KVNamespace, key: string, tokenHash: string): Promise<void> {
  const hashes = await readIndex(kv, key)
  if (hashes.includes(tokenHash)) return
  await writeIndex(kv, key, [...hashes, tokenHash])
}

export async function addIndexHash(env: DataEnv, key: string, tokenHash: string): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return
  await addIndexHashKv(env.DATA, key, tokenHash)
}

export async function removeIndexHashKv(kv: KVNamespace, key: string, tokenHash: string): Promise<void> {
  const hashes = await readIndex(kv, key)
  if (!hashes.includes(tokenHash)) return
  await writeIndex(kv, key, hashes.filter((hash) => hash !== tokenHash))
}

export async function removeIndexHash(env: DataEnv, key: string, tokenHash: string): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return
  await removeIndexHashKv(env.DATA, key, tokenHash)
}

export async function replaceIndexHash(
  env: DataEnv,
  key: string,
  previousHash: string,
  nextHash: string,
): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return
  const hashes = await readIndex(env.DATA, key)
  const replaced = hashes.map((hash) => hash === previousHash ? nextHash : hash)
  if (!replaced.includes(nextHash)) replaced.push(nextHash)
  await writeIndex(env.DATA, key, replaced)
}

export async function deleteShareCompiled(kv: KVNamespace, tokenHash: string): Promise<void> {
  try {
    const prefix = shareCompiledPrefix(tokenHash)
    let cursor: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const listed = await kv.list({ prefix, cursor })
      if (listed.keys.length > 0) await Promise.all(listed.keys.map(({ name }) => kv.delete(name)))
      if (listed.list_complete) return
      cursor = listed.cursor
    }
  } catch {
    // Stale share artifacts stay inert: export only reads the current token hash and revisions.
  }
}

export function consumeVerifySlot(env: DataEnv, tokenHash: string, nowMs: number): Promise<boolean> {
  return consumeVerifySlotD1(env.DB, tokenHash, nowMs)
}

export async function claimExportAccess(env: DataEnv, tokenHash: string, nowIso: string): Promise<boolean> {
  const share = await readShare(env, tokenHash)
  if (!share || share.status !== 'active') return false
  if (Date.parse(share.expiresAt) <= Date.parse(nowIso)) return false
  if (share.maxAccessCount !== null && share.accessCount >= share.maxAccessCount) return false
  if (share.scope) {
    const result = await env.DB.prepare(`UPDATE user_subscription_shares SET record_json=json_set(record_json,
      '$.accessCount',json_extract(record_json,'$.accessCount')+1,'$.lastAccessedAt',?)
      WHERE token_hash=? AND json_extract(record_json,'$.status')='active'
        AND json_extract(record_json,'$.expiresAt')>?
        AND (json_extract(record_json,'$.maxAccessCount') IS NULL OR
          json_extract(record_json,'$.accessCount')<json_extract(record_json,'$.maxAccessCount'))`)
      .bind(nowIso, tokenHash, nowIso).run()
    return result.meta.changes === 1
  }
  // accessCount is updated with the share row. Concurrent exports are best-effort.
  await writeShare(env, {
    ...share,
    accessCount: share.accessCount + 1,
    lastAccessedAt: nowIso,
  })
  return true
}

async function listUnifiedShares(env: DataEnv, userId?: string) {
  const statement = userId
    ? env.DB.prepare('SELECT record_json FROM user_subscription_shares WHERE user_id=?').bind(userId)
    : env.DB.prepare('SELECT record_json FROM user_subscription_shares')
  const { results } = await statement.all<{ record_json: string }>()
  return results.map(row => parseShare(row.record_json))
}

export async function writeUnifiedShare(env: DataEnv, actor: string, previous: ShareRecord | null, next: ShareRecord, action: string) {
  const db = env.DB
  const templateId = next.scope?.type === 'template' ? next.scope.templateId : null
  let statement: D1PreparedStatement
  if (previous) {
    statement = db.prepare(`UPDATE user_subscription_shares SET token_hash=?, record_json=json_set(?,
      '$.accessCount',json_extract(record_json,'$.accessCount'),'$.lastAccessedAt',json_extract(record_json,'$.lastAccessedAt'))
      WHERE id=? AND token_hash=? AND json_extract(record_json,'$.updatedAt')=?
        AND json_extract(record_json,'$.status')<>'revoked'`)
      .bind(next.tokenHash, JSON.stringify(next), next.id, previous.tokenHash, previous.updatedAt)
  } else {
    const settings = await readShareSettings(env)
    statement = db.prepare(`INSERT INTO user_subscription_shares (id,user_id,template_id,token_hash,record_json)
      SELECT ?,?,?,?,? WHERE
        (SELECT count(*) FROM user_subscription_shares WHERE user_id=? AND template_id IS ?) < ?
        AND ((SELECT count(*) FROM user_subscription_shares WHERE user_id=?
          AND json_extract(record_json,'$.status')='active') +
          (SELECT count(*) FROM shares WHERE owner_user_id=? AND status='active')) < ?`)
      .bind(next.id, next.ownerUserId, templateId, next.tokenHash, JSON.stringify(next), next.ownerUserId,
        templateId, settings.maxSharesPerSubscription, next.ownerUserId, next.ownerUserId, settings.maxActiveSharesPerUser)
  }
  const audit = auditStatement(db, actor, `subscription.share.${action}`, 'share', next.id, {
    userId: next.ownerUserId, templateId, requestId: crypto.randomUUID(),
    before: previous && { status: previous.status, expiresAt: previous.expiresAt },
    after: { status: next.status, expiresAt: next.expiresAt },
  }, next.updatedAt)
  const [result] = await db.batch([statement, db.prepare(`INSERT INTO system_settings (key,value,updated_at)
    SELECT 'unified_share_conflict',NULL,? WHERE changes()<>1`).bind(next.updatedAt), audit]).catch(error => {
    if (error instanceof Error && error.message.includes('system_settings.value')) {
      throw apiError(409, 'SHARE_CONFLICT', '分享已更新或数量已达上限')
    }
    throw error
  })
  return result
}
