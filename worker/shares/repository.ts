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
export const shareLimitKey = (tokenHash: string, minuteWindow: number): string => `sharelimit:${tokenHash}:${minuteWindow}`
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

export async function readShare(env: DataEnv, tokenHash: string): Promise<ShareRecord | null> {
  if (!tokenHashSchema.safeParse(tokenHash).success) return null
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return readShareFromD1(env.DB, tokenHash)
  const raw = await env.DATA.get(shareEntityKey(tokenHash))
  if (raw === null) return null
  return parseShare(raw)
}

async function writeShareKv(kv: KVNamespace, record: ShareRecord): Promise<void> {
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

export async function deleteShare(env: DataEnv, tokenHash: string): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    await deleteShareByTokenHash(env.DB, tokenHash)
    return
  }
  await env.DATA.delete(shareEntityKey(tokenHash))
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
    return listSharesFromD1(env.DB, filter)
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

export async function listAllShares(env: DataEnv): Promise<ShareRecord[]> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return listSharesFromD1(env.DB)
  const records: ShareRecord[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const listed = await env.DATA.list({ prefix: 'share:', cursor })
    const batch = await Promise.all(listed.keys.map(async ({ name }) => {
      if (!ENTITY_KEY.test(name)) return null
      const raw = await env.DATA.get(name)
      if (raw === null) return null
      return parseShare(raw)
    }))
    for (const record of batch) if (record) records.push(record)
    if (listed.list_complete) return records
    cursor = listed.cursor
  }
  throw new Error('Share listing did not finish')
}

export async function addIndexHash(env: DataEnv, key: string, tokenHash: string): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return
  const hashes = await readIndex(env.DATA, key)
  if (hashes.includes(tokenHash)) return
  await writeIndex(env.DATA, key, [...hashes, tokenHash])
}

export async function removeIndexHash(env: DataEnv, key: string, tokenHash: string): Promise<void> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return
  const hashes = await readIndex(env.DATA, key)
  if (!hashes.includes(tokenHash)) return
  await writeIndex(env.DATA, key, hashes.filter((hash) => hash !== tokenHash))
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

const VERIFY_WINDOW_MS = 60_000
const VERIFY_WINDOW_COUNT = 10
const VERIFY_LIMIT = 10

export async function consumeVerifySlot(env: DataEnv, tokenHash: string, nowMs: number): Promise<boolean> {
  if (await isModuleReady(env.DB, SHARES_D1_READY_KEY)) return consumeVerifySlotD1(env.DB, tokenHash, nowMs)
  const minute = Math.floor(nowMs / VERIFY_WINDOW_MS)
  const keys = Array.from({ length: VERIFY_WINDOW_COUNT }, (_, index) => shareLimitKey(tokenHash, minute - index))
  const values = await Promise.all(keys.map((key) => env.DATA.get(key)))
  const counts = values.map((value) => value !== null && /^\d+$/u.test(value) ? Number(value) : 0)
  if (counts.reduce((sum, count) => sum + count, 0) >= VERIFY_LIMIT) return false
  // Minute buckets over the last 10 minutes. The read-modify-write is last-writer-wins.
  await env.DATA.put(keys[0], String(counts[0] + 1), { expirationTtl: 11 * 60 })
  return true
}

export async function claimExportAccess(env: DataEnv, tokenHash: string, nowIso: string): Promise<boolean> {
  const share = await readShare(env, tokenHash)
  if (!share || share.status !== 'active') return false
  if (Date.parse(share.expiresAt) <= Date.parse(nowIso)) return false
  if (share.maxAccessCount !== null && share.accessCount >= share.maxAccessCount) return false
  // accessCount is updated with the share row. Concurrent exports are best-effort.
  await writeShare(env, {
    ...share,
    accessCount: share.accessCount + 1,
    lastAccessedAt: nowIso,
  })
  return true
}
