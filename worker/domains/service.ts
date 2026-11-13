import { ApiError } from '../platform/api-error.js'
import { queryFirst, type AppDatabase } from '../db/db.js'
import {
  decodeSettingJson,
  getSetting,
  putSetting,
} from '../db/settings-repository.js'
import { SUBSCRIPTION_LINK_PLATFORM_KEYS, SUBSCRIPTION_LINK_PLATFORMS } from './platforms.js'

export type DomainKind = 'panel' | 'subscription'
export type VerificationStatus = 'pending' | 'verified' | 'failed'

export type DomainRecord = {
  id: string
  kind: DomainKind
  hostname: string
  enabled: boolean
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  lastCheckAt: string | null
  lastCheckError: string | null
  note: string
  createdAt: string
  updatedAt: string
}

export type PlatformSetting = {
  platform: string
  displayName: string
  enabled: boolean
  sortOrder: number
}

const DOMAIN_TABLES: Record<DomainKind, string> = {
  panel: 'panel_domains',
  subscription: 'subscription_domains',
}

export const PRIMARY_DOMAIN_ID_KEYS: Record<DomainKind, string> = {
  panel: 'primary_panel_domain_id',
  subscription: 'primary_subscription_domain_id',
}

export const DOMAIN_RESTRICTION_ENABLED_KEY = 'domain_restriction_enabled'
export const INSTANCE_ID_KEY = 'instance_id'

export class DomainError extends ApiError {}

function domainError(status: 404 | 409 | 422, code: string, message: string): DomainError {
  return new DomainError(status, code, message)
}

type DomainRow = {
  id: string
  hostname: string
  enabled: number
  verification_status: VerificationStatus
  verified_at: string | null
  last_check_at: string | null
  last_check_error: string | null
  note: string
  created_at: string
  updated_at: string
}

const DOMAIN_COLUMNS =
  'id, hostname, enabled, verification_status, verified_at, last_check_at, last_check_error, note, created_at, updated_at'

function toDomainRecord(kind: DomainKind, row: DomainRow): DomainRecord {
  return {
    id: row.id,
    kind,
    hostname: row.hostname,
    enabled: row.enabled === 1,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    lastCheckAt: row.last_check_at,
    lastCheckError: row.last_check_error,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Normalizes an admin-entered hostname per plan §7.2: trims whitespace,
 * lowercases, and rejects anything that is not a bare legal hostname
 * (no scheme, path, query, fragment, credentials or port).
 */
export function normalizeHostname(input: string): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim().toLowerCase()
  if (value.length === 0 || value.length > 253) return null
  if (/[\s/?#@:[\]\\]/.test(value)) return null
  const labels = value.split('.')
  if (labels.length < 2) return null
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return null
  return value
}

function newDomainId(): string {
  return `dom_${crypto.randomUUID().replaceAll('-', '')}`
}

export async function listDomains(db: AppDatabase, kind: DomainKind): Promise<DomainRecord[]> {
  const listed = await db
    .prepare(`SELECT ${DOMAIN_COLUMNS} FROM ${DOMAIN_TABLES[kind]} ORDER BY created_at, id`)
    .all<DomainRow>()
  return listed.results.map((row) => toDomainRecord(kind, row))
}

export async function getDomain(
  db: AppDatabase,
  kind: DomainKind,
  id: string,
): Promise<DomainRecord | null> {
  const row = await queryFirst<DomainRow>(
    db.prepare(`SELECT ${DOMAIN_COLUMNS} FROM ${DOMAIN_TABLES[kind]} WHERE id = ?`).bind(id),
  )
  return row ? toDomainRecord(kind, row) : null
}

async function requireDomain(db: AppDatabase, kind: DomainKind, id: string): Promise<DomainRecord> {
  const record = await getDomain(db, kind, id)
  if (!record) throw domainError(404, 'DOMAIN_NOT_FOUND', '域名不存在')
  return record
}

export async function createDomain(
  db: AppDatabase,
  kind: DomainKind,
  input: { hostname: string; note?: string },
  now = new Date().toISOString(),
): Promise<DomainRecord> {
  const hostname = normalizeHostname(input.hostname)
  if (!hostname) throw domainError(422, 'DOMAIN_INVALID', '域名格式无效')
  const note = (input.note ?? '').trim()
  if (note.length > 200) throw domainError(422, 'DOMAIN_INVALID', '备注过长')
  const existing = await queryFirst<{ id: string }>(
    db.prepare(`SELECT id FROM ${DOMAIN_TABLES[kind]} WHERE hostname = ?`).bind(hostname),
  )
  if (existing) throw domainError(409, 'DOMAIN_DUPLICATE', '该域名已存在')
  const id = newDomainId()
  await db
    .prepare(
      `INSERT INTO ${DOMAIN_TABLES[kind]} (
        id, hostname, enabled, verification_status, verified_at, last_check_at, last_check_error, note, created_at, updated_at
      ) VALUES (?, ?, 0, 'pending', NULL, NULL, NULL, ?, ?, ?)`,
    )
    .bind(id, hostname, note, now, now)
    .run()
  invalidateGateCache(db)
  return requireDomain(db, kind, id)
}

export async function updateDomainNote(
  db: AppDatabase,
  kind: DomainKind,
  id: string,
  note: string,
  now = new Date().toISOString(),
): Promise<DomainRecord> {
  const record = await requireDomain(db, kind, id)
  const trimmed = note.trim()
  if (trimmed.length > 200) throw domainError(422, 'DOMAIN_INVALID', '备注过长')
  await db
    .prepare(`UPDATE ${DOMAIN_TABLES[kind]} SET note = ?, updated_at = ? WHERE id = ?`)
    .bind(trimmed, now, record.id)
    .run()
  return requireDomain(db, kind, id)
}

export async function getPrimaryDomainId(db: AppDatabase, kind: DomainKind): Promise<string | null> {
  const raw = await getSetting(db, PRIMARY_DOMAIN_ID_KEYS[kind])
  if (raw === null) return null
  const value = decodeSettingJson(raw)
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('Setting value is corrupt')
  return value
}

async function putPrimaryDomainId(
  db: AppDatabase,
  kind: DomainKind,
  id: string | null,
  now: string,
): Promise<void> {
  await putSetting(db, PRIMARY_DOMAIN_ID_KEYS[kind], id, now)
}

/**
 * Resolves the configured primary domain record. A dangling reference (the
 * record vanished outside the service layer) resolves to null instead of
 * throwing, so link generation can report "not configured".
 */
export async function resolvePrimaryDomain(
  db: AppDatabase,
  kind: DomainKind,
): Promise<DomainRecord | null> {
  const id = await getPrimaryDomainId(db, kind)
  if (!id) return null
  return getDomain(db, kind, id)
}

/**
 * The canonical absolute origin for a domain kind, or null when no usable
 * primary is configured. A primary whose latest re-verification failed is
 * still the configured primary (plan §7.4): only a missing or disabled
 * record makes the origin unusable.
 */
export async function primaryDomainOrigin(
  db: AppDatabase,
  kind: DomainKind,
): Promise<string | null> {
  const record = await resolvePrimaryDomain(db, kind)
  if (!record || !record.enabled) return null
  return `https://${record.hostname}`
}

/** Fail-soft variant for hot paths that predate migration 0007. */
export async function primaryDomainOriginSafe(
  db: AppDatabase,
  kind: DomainKind,
): Promise<string | null> {
  try {
    return await primaryDomainOrigin(db, kind)
  } catch {
    return null
  }
}

export async function setPrimaryDomain(
  db: AppDatabase,
  kind: DomainKind,
  id: string,
  now = new Date().toISOString(),
): Promise<DomainRecord> {
  const record = await requireDomain(db, kind, id)
  if (!record.enabled || record.verificationStatus !== 'verified') {
    throw domainError(422, 'DOMAIN_NOT_VERIFIED', '主域名必须已启用且验证通过')
  }
  await putPrimaryDomainId(db, kind, record.id, now)
  invalidateGateCache(db)
  return record
}

export async function setDomainEnabled(
  db: AppDatabase,
  kind: DomainKind,
  id: string,
  enabled: boolean,
  now = new Date().toISOString(),
): Promise<DomainRecord> {
  const record = await requireDomain(db, kind, id)
  if (enabled && record.verificationStatus !== 'verified') {
    throw domainError(422, 'DOMAIN_NOT_VERIFIED', '域名验证通过后才能启用')
  }
  if (!enabled) {
    const primaryId = await getPrimaryDomainId(db, kind)
    if (primaryId === record.id) {
      throw domainError(409, 'DOMAIN_PRIMARY_LOCKED', '主域名不能停用，请先指定新的主域名')
    }
  }
  await db
    .prepare(`UPDATE ${DOMAIN_TABLES[kind]} SET enabled = ?, updated_at = ? WHERE id = ?`)
    .bind(enabled ? 1 : 0, now, record.id)
    .run()
  invalidateGateCache(db)
  return requireDomain(db, kind, id)
}

export async function deleteDomain(db: AppDatabase, kind: DomainKind, id: string): Promise<void> {
  const record = await requireDomain(db, kind, id)
  const primaryId = await getPrimaryDomainId(db, kind)
  if (primaryId === record.id) {
    throw domainError(409, 'DOMAIN_PRIMARY_LOCKED', '主域名不能删除，请先指定新的主域名')
  }
  await db.prepare(`DELETE FROM ${DOMAIN_TABLES[kind]} WHERE id = ?`).bind(record.id).run()
  invalidateGateCache(db)
}

// ---------------------------------------------------------------------------
// Instance identity + domain verification (plan §7.3, brief: single manual
// request, 5s timeout, zero retries, never touches subscription content).

export async function getOrCreateInstanceId(db: AppDatabase): Promise<string> {
  const raw = await getSetting(db, INSTANCE_ID_KEY)
  if (raw !== null) {
    const value = decodeSettingJson(raw)
    if (typeof value !== 'string' || value.length === 0) throw new Error('Setting value is corrupt')
    return value
  }
  const id = `ins_${crypto.randomUUID().replaceAll('-', '')}`
  await putSetting(db, INSTANCE_ID_KEY, id)
  return id
}

const VERIFY_TIMEOUT_MS = 5_000

function checkErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return '验证请求超时'
    return `验证请求失败：${error.message}`.slice(0, 200)
  }
  return '验证请求失败'
}

export async function verifyDomain(
  db: AppDatabase,
  kind: DomainKind,
  id: string,
  fetcher: typeof fetch = fetch,
  now = new Date().toISOString(),
): Promise<DomainRecord> {
  const record = await requireDomain(db, kind, id)
  const instanceId = await getOrCreateInstanceId(db)
  let failure: string | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetcher(`https://${record.hostname}/api/system/instance`, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'SubPanel domain verification' },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      failure = `验证端点返回 HTTP ${response.status}`
    } else {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = null
      }
      const returned =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>).instanceId
          : undefined
      if (returned !== instanceId) failure = '域名返回的实例标识与本机不一致'
    }
  } catch (error) {
    failure = checkErrorSummary(error)
  }
  await db
    .prepare(
      `UPDATE ${DOMAIN_TABLES[kind]} SET
         verification_status = ?, verified_at = ?, last_check_at = ?, last_check_error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      failure === null ? 'verified' : 'failed',
      failure === null ? now : record.verifiedAt,
      now,
      failure,
      now,
      record.id,
    )
    .run()
  return requireDomain(db, kind, id)
}

// ---------------------------------------------------------------------------
// Subscription platform display settings.

type PlatformRow = {
  platform: string
  display_name: string
  enabled: number
  sort_order: number
}

export async function listPlatformSettings(db: AppDatabase): Promise<PlatformSetting[]> {
  const listed = await db
    .prepare(
      'SELECT platform, display_name, enabled, sort_order FROM subscription_platform_settings ORDER BY sort_order, platform',
    )
    .all<PlatformRow>()
  const byKey = new Map(listed.results.map((row) => [row.platform, row]))
  // Rows are seeded by migration 0007; if a row is missing (older test
  // fixture), fall back to the canonical seed shape instead of dropping the
  // platform from the admin list.
  return SUBSCRIPTION_LINK_PLATFORMS.map((seed, index) => {
    const row = byKey.get(seed.platform)
    if (!row) {
      return { platform: seed.platform, displayName: seed.displayName, enabled: true, sortOrder: index * 10 }
    }
    return {
      platform: row.platform,
      displayName: row.display_name,
      enabled: row.enabled === 1,
      sortOrder: row.sort_order,
    }
  }).sort((a, b) => a.sortOrder - b.sortOrder || a.platform.localeCompare(b.platform))
}

export async function listEnabledPlatforms(db: AppDatabase): Promise<PlatformSetting[]> {
  return (await listPlatformSettings(db)).filter((entry) => entry.enabled)
}

export async function updatePlatformSettings(
  db: AppDatabase,
  entries: Array<{ platform: string; enabled: boolean }>,
  now = new Date().toISOString(),
): Promise<PlatformSetting[]> {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!SUBSCRIPTION_LINK_PLATFORM_KEYS.has(entry.platform) || seen.has(entry.platform)) {
      throw domainError(422, 'PLATFORM_INVALID', '平台配置无效')
    }
    seen.add(entry.platform)
  }
  if (seen.size !== SUBSCRIPTION_LINK_PLATFORM_KEYS.size) {
    throw domainError(422, 'PLATFORM_INVALID', '平台配置不完整')
  }
  const statements = entries.map((entry, index) =>
    db
      .prepare(
        `INSERT INTO subscription_platform_settings (platform, display_name, enabled, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform) DO UPDATE SET
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      )
      .bind(
        entry.platform,
        SUBSCRIPTION_LINK_PLATFORMS.find((seed) => seed.platform === entry.platform)?.displayName ?? entry.platform,
        entry.enabled ? 1 : 0,
        index * 10,
        now,
      ),
  )
  await db.batch(statements)
  return listPlatformSettings(db)
}

// ---------------------------------------------------------------------------
// Domain restriction switch + host gate state.

export async function getDomainRestrictionEnabled(db: AppDatabase): Promise<boolean> {
  const raw = await getSetting(db, DOMAIN_RESTRICTION_ENABLED_KEY)
  if (raw === null) return false
  const value = decodeSettingJson(raw)
  if (typeof value !== 'boolean') throw new Error('Setting value is corrupt')
  return value
}

export async function putDomainRestrictionEnabled(
  db: AppDatabase,
  enabled: boolean,
  now = new Date().toISOString(),
): Promise<void> {
  await putSetting(db, DOMAIN_RESTRICTION_ENABLED_KEY, enabled, now)
  invalidateGateCache(db)
}

async function listEnabledHostnames(db: AppDatabase, kind: DomainKind): Promise<string[]> {
  const listed = await db
    .prepare(`SELECT hostname FROM ${DOMAIN_TABLES[kind]} WHERE enabled = 1`)
    .all<{ hostname: string }>()
  return listed.results.map((row) => row.hostname)
}

export type GateState = {
  restrictionEnabled: boolean
  panelHosts: ReadonlySet<string>
  subscriptionHosts: ReadonlySet<string>
}

const GATE_CACHE_TTL_MS = 15_000
const gateCache = new WeakMap<object, { expiresAt: number; state: GateState }>()

export function invalidateGateCache(db?: AppDatabase): void {
  if (db) gateCache.delete(db)
}

/**
 * Gate state with a short in-isolate cache. Any storage failure (for
 * example a database that predates migration 0007) fails open: the gate
 * must never take the panel down on its own.
 */
export async function getGateState(db: AppDatabase): Promise<GateState> {
  const cached = gateCache.get(db)
  if (cached && cached.expiresAt > Date.now()) return cached.state
  let state: GateState
  try {
    const restrictionEnabled = await getDomainRestrictionEnabled(db)
    if (!restrictionEnabled) {
      state = { restrictionEnabled: false, panelHosts: new Set(), subscriptionHosts: new Set() }
    } else {
      const [panelHosts, subscriptionHosts] = await Promise.all([
        listEnabledHostnames(db, 'panel'),
        listEnabledHostnames(db, 'subscription'),
      ])
      state = {
        restrictionEnabled: true,
        panelHosts: new Set(panelHosts),
        subscriptionHosts: new Set(subscriptionHosts),
      }
    }
  } catch {
    return { restrictionEnabled: false, panelHosts: new Set(), subscriptionHosts: new Set() }
  }
  gateCache.set(db, { expiresAt: Date.now() + GATE_CACHE_TTL_MS, state })
  return state
}
