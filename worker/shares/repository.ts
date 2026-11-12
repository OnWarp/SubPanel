import { z } from 'zod'
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

export async function readShareSettings(kv: KVNamespace): Promise<ShareSettings> {
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

export async function writeShareSettings(kv: KVNamespace, settings: ShareSettings): Promise<void> {
  const parsed = shareSettingsSchema.parse(settings)
  const publicBaseUrl = canonicalPublicBaseUrl(parsed.publicBaseUrl)
  if (publicBaseUrl === null) throw new Error('Share settings are corrupt')
  await kv.put(SHARE_SETTINGS_KEY, JSON.stringify({ ...parsed, publicBaseUrl }))
}

export async function allocateShareId(kv: KVNamespace): Promise<string> {
  const raw = await kv.get(SHARE_SEQ_KEY)
  let next = 1
  if (raw !== null) {
    try {
      next = sequenceSchema.parse(JSON.parse(raw)).next
    } catch {
      throw new Error('Share id sequence is corrupt')
    }
  }
  // ponytail: the id counter is last-writer-wins. Concurrent creates can allocate the same id; token hashes still differ.
  await kv.put(SHARE_SEQ_KEY, JSON.stringify({ next: next + 1 }))
  return `shr_${next}`
}

export async function readShare(kv: KVNamespace, tokenHash: string): Promise<ShareRecord | null> {
  if (!tokenHashSchema.safeParse(tokenHash).success) return null
  const raw = await kv.get(shareEntityKey(tokenHash))
  if (raw === null) return null
  return parseShare(raw)
}

export async function writeShare(kv: KVNamespace, record: ShareRecord): Promise<void> {
  const parsed = shareRecordSchema.parse(record)
  await kv.put(shareEntityKey(parsed.tokenHash), JSON.stringify(parsed))
}

export async function deleteShare(kv: KVNamespace, tokenHash: string): Promise<void> {
  await kv.delete(shareEntityKey(tokenHash))
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
  // ponytail: shareidx:* 的值是 tokenHash 数组的整表 JSON。并发写入后写者胜，语义与 state:accounts / state:catalog / state:delivery 相同。
  const unique = [...new Set(hashes)]
  if (unique.length === 0) {
    await kv.delete(key)
    return
  }
  await kv.put(key, JSON.stringify(unique))
}

export async function listIndexedShares(kv: KVNamespace, key: string): Promise<ShareRecord[]> {
  const hashes = await readIndex(kv, key)
  const records = await Promise.all(hashes.map(async (hash) => readShare(kv, hash)))
  return records.filter((record): record is ShareRecord => record !== null)
}

export async function listAllShares(kv: KVNamespace): Promise<ShareRecord[]> {
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

export async function addIndexHash(kv: KVNamespace, key: string, tokenHash: string): Promise<void> {
  const hashes = await readIndex(kv, key)
  if (hashes.includes(tokenHash)) return
  await writeIndex(kv, key, [...hashes, tokenHash])
}

export async function removeIndexHash(kv: KVNamespace, key: string, tokenHash: string): Promise<void> {
  const hashes = await readIndex(kv, key)
  if (!hashes.includes(tokenHash)) return
  await writeIndex(kv, key, hashes.filter((hash) => hash !== tokenHash))
}

export async function replaceIndexHash(
  kv: KVNamespace,
  key: string,
  previousHash: string,
  nextHash: string,
): Promise<void> {
  const hashes = await readIndex(kv, key)
  const replaced = hashes.map((hash) => hash === previousHash ? nextHash : hash)
  if (!replaced.includes(nextHash)) replaced.push(nextHash)
  await writeIndex(kv, key, replaced)
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

export async function consumeVerifySlot(kv: KVNamespace, tokenHash: string, nowMs: number): Promise<boolean> {
  const minute = Math.floor(nowMs / VERIFY_WINDOW_MS)
  const keys = Array.from({ length: VERIFY_WINDOW_COUNT }, (_, index) => shareLimitKey(tokenHash, minute - index))
  const values = await Promise.all(keys.map((key) => kv.get(key)))
  const counts = values.map((value) => value !== null && /^\d+$/u.test(value) ? Number(value) : 0)
  if (counts.reduce((sum, count) => sum + count, 0) >= VERIFY_LIMIT) return false
  // ponytail: sharelimit:{tokenHash}:{分钟窗} 按分钟分桶，合计最近 10 个桶得到 10 次/10 分钟。读改写后写者胜，并发 verify 下是尽力限制。
  await kv.put(keys[0], String(counts[0] + 1), { expirationTtl: 11 * 60 })
  return true
}

export async function claimExportAccess(kv: KVNamespace, tokenHash: string, nowIso: string): Promise<boolean> {
  const share = await readShare(kv, tokenHash)
  if (!share || share.status !== 'active') return false
  if (Date.parse(share.expiresAt) <= Date.parse(nowIso)) return false
  if (share.maxAccessCount !== null && share.accessCount >= share.maxAccessCount) return false
  // ponytail: accessCount 随整条分享记录读改写。KV 后写者胜，次数上限在并发导出下是尽力保证。
  await writeShare(kv, {
    ...share,
    accessCount: share.accessCount + 1,
    lastAccessedAt: nowIso,
  })
  return true
}
