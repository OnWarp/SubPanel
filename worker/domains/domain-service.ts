import { VERIFY_FAILURES } from './verification-contract.js'
import { apiError } from '../platform/api-error.js'
import { type AppDatabase, queryFirst } from '../db/db.js'
import { decodeSettingJson, getSetting, putSetting } from '../db/settings-repository.js'
import { subscriptionLinks, subscriptionPath } from '../delivery/links.js'
import { listPlatformSettings } from './service.js'

export type DomainKind = 'panel' | 'subscription'
type VerificationStatus = 'pending' | 'verified' | 'failed'

type DomainRow = {
  id: string
  domainId: string
  hostname: string
  purpose: DomainKind
  note: string
  enabled: number
  isPrimary: number
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  lastCheckAt: string | null
  lastCheckError: string | null
  createdAt: string
  updatedAt: string
}

const SAFE_CHECK_ERRORS = new Set<string>(VERIFY_FAILURES)

function toBinding({ domainId: _, enabled, isPrimary, lastCheckError, ...row }: DomainRow) {
  return {
    ...row,
    enabled: enabled === 1,
    isPrimary: isPrimary === 1,
    health: row.verificationStatus,
    lastCheckError: lastCheckError && !SAFE_CHECK_ERRORS.has(lastCheckError) ? 'LEGACY_CHECK_FAILED' : lastCheckError,
  }
}

export type DomainBinding = ReturnType<typeof toBinding>

const BINDINGS = `SELECT b.id, b.domain_id AS domainId, d.hostname, b.purpose, b.note, b.enabled,
  b.is_primary AS isPrimary, d.verification_status AS verificationStatus, d.verified_at AS verifiedAt,
  d.last_checked_at AS lastCheckAt, d.last_error_code AS lastCheckError, b.created_at AS createdAt,
  MAX(b.updated_at, d.updated_at) AS updatedAt FROM domain_bindings b JOIN domains d ON d.id = b.domain_id`

const conflict = () => apiError(409, 'VERSION_CONFLICT', '域名配置已更改，请刷新后重试')
const notVerified = () => apiError(409, 'NOT_VERIFIED', '域名须先通过验证')
const protectedPrimary = () => apiError(409, 'PRIMARY_PROTECTED', '请先指定新的主域名')

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Normalizes an admin-entered hostname per plan §7.2: trims whitespace,
 * lowercases, and rejects anything that is not a bare legal hostname
 * (no scheme, path, query, fragment, credentials or port).
 */
export function normalizeHostname(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (/[^ -~]/u.test(trimmed)) return null
  const value = trimmed.toLowerCase()
  if (value.length === 0 || value.length > 253) return null
  if (/[\s/?#@:[\]\\]/.test(value)) return null
  const labels = value.split('.')
  if (labels.length < 2) return null
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return null
  const lastLabel = labels.at(-1)!
  // A numeric final label triggers the browser's IPv4 parser, including octal and hex forms.
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/u.test(lastLabel) || lastLabel === 'localhost') return null
  return value
}

export class DomainService {
  private readonly db: AppDatabase

  constructor(db: AppDatabase) {
    this.db = db
  }

  private async changeGate(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results = await this.db.batch([...statements, bumpGateRevision(this.db)])
    invalidateGateCache(this.db)
    return results
  }

  async list(purpose: DomainKind): Promise<DomainBinding[]> {
    const rows = await this.db.prepare(`${BINDINGS} WHERE b.purpose = ? ORDER BY b.created_at, b.id`)
      .bind(purpose).all<DomainRow>()
    return rows.results.map(toBinding)
  }

  async requireRow(purpose: DomainKind, id: string): Promise<DomainRow> {
    const row = await queryFirst<DomainRow>(this.db.prepare(`${BINDINGS} WHERE b.purpose = ? AND b.id = ?`)
      .bind(purpose, id))
    if (!row) throw apiError(404, 'NOT_FOUND', '域名不存在')
    return row
  }

  async get(purpose: DomainKind, id: string): Promise<DomainBinding> {
    return toBinding(await this.requireRow(purpose, id))
  }

  async create(purpose: DomainKind, input: { hostname: string; note?: string }): Promise<DomainBinding> {
    const hostname = normalizeHostname(input.hostname)
    if (!hostname) throw apiError(400, 'INVALID_HOSTNAME', '域名格式无效')
    const id = `dom_${crypto.randomUUID().replaceAll('-', '')}`
    const now = new Date().toISOString()
    const [, binding] = await this.changeGate([
      this.db.prepare(`INSERT INTO domains (id, hostname, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(hostname) DO NOTHING`).bind(crypto.randomUUID(), hostname, now, now),
      this.db.prepare(`INSERT INTO domain_bindings (id, domain_id, purpose, note, created_at, updated_at)
        SELECT ?, id, ?, ?, ?, ? FROM domains WHERE hostname = ?
        ON CONFLICT(domain_id, purpose) DO NOTHING`).bind(id, purpose, (input.note ?? '').trim(), now, now, hostname),
    ])
    if (!binding.meta.changes) throw apiError(409, 'DOMAIN_EXISTS', '该用途已绑定此域名')
    return this.get(purpose, id)
  }

  async update(purpose: DomainKind, id: string, input: { enabled?: boolean; note?: string }) {
    const before = await this.requireRow(purpose, id)
    if (input.enabled === true && (before.verificationStatus !== 'verified' || before.verifiedAt === null)) throw notVerified()
    if (input.enabled === false && before.isPrimary) throw protectedPrimary()
    const enabled = input.enabled === undefined ? null : Number(input.enabled)
    const [result] = await this.changeGate([
      this.db.prepare(`UPDATE domain_bindings SET note = COALESCE(?, note), enabled = COALESCE(?, enabled),
        is_primary = CASE WHEN ? = 1 AND enabled = 0 AND NOT EXISTS (
          SELECT 1 FROM domain_bindings AS current WHERE current.purpose = ? AND current.is_primary = 1
        ) THEN 1 ELSE is_primary END, updated_at = ?
        WHERE id = ? AND (? IS NULL OR enabled = ? AND is_primary = ?)
          AND (? IS NULL OR ? = 1 AND EXISTS (
          SELECT 1 FROM domains WHERE domains.id = domain_bindings.domain_id AND verification_status = 'verified' AND verified_at IS NOT NULL
        ) OR ? = 0 AND is_primary = 0)
        RETURNING is_primary AS isPrimary`).bind(input.note?.trim() ?? null, enabled, enabled, purpose,
        new Date().toISOString(), id, enabled, before.enabled, before.isPrimary, enabled, enabled, enabled),
    ])
    if (!result.results.length) throw conflict()
    return {
      domain: await this.get(purpose, id),
      autoPrimary: input.enabled === true && before.enabled === 0
        && (result.results[0] as { isPrimary: number }).isPrimary === 1,
    }
  }

  async delete(purpose: DomainKind, id: string): Promise<void> {
    const row = await this.requireRow(purpose, id)
    if (row.isPrimary) throw protectedPrimary()
    const [result] = await this.changeGate([
      this.db.prepare('DELETE FROM domain_bindings WHERE id = ? AND is_primary = 0').bind(id),
      this.db.prepare(`DELETE FROM domains WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM domain_bindings WHERE domain_id = domains.id)`).bind(row.domainId),
    ])
    if (!result.meta.changes) throw conflict()
  }

  async getPrimary(purpose: DomainKind): Promise<DomainBinding | null> {
    const row = await queryFirst<DomainRow>(this.db.prepare(`${BINDINGS} WHERE b.purpose = ? AND b.is_primary = 1`)
      .bind(purpose))
    return row ? toBinding(row) : null
  }

  async setPrimary(purpose: DomainKind, id: string): Promise<DomainBinding> {
    const [target, current] = await Promise.all([this.requireRow(purpose, id), this.getPrimary(purpose)])
    if (target.verificationStatus !== 'verified' || target.verifiedAt === null) throw notVerified()
    if (!target.enabled) throw apiError(409, 'DOMAIN_DISABLED', '请先启用域名')
    if (current?.id === id) return toBinding(target)
    const now = new Date().toISOString()
    const [, promoted] = await this.changeGate([
      this.db.prepare(`UPDATE domain_bindings SET is_primary = 0, updated_at = ?
        WHERE id = ? AND is_primary = 1 AND EXISTS (
          SELECT 1 FROM domain_bindings b JOIN domains d ON d.id = b.domain_id
          WHERE b.id = ? AND b.enabled = 1 AND d.verification_status = 'verified' AND verified_at IS NOT NULL
        )`).bind(now, current?.id ?? null, id),
      this.db.prepare(`UPDATE domain_bindings SET is_primary = 1, updated_at = ?
        WHERE id = ? AND enabled = 1 AND (? IS NULL OR changes() = 1)
          AND NOT EXISTS (SELECT 1 FROM domain_bindings WHERE purpose = ? AND is_primary = 1)
          AND EXISTS (SELECT 1 FROM domains WHERE domains.id = domain_bindings.domain_id
            AND verification_status = 'verified' AND verified_at IS NOT NULL)`).bind(now, id, current?.id ?? null, purpose),
    ])
    if (!promoted.meta.changes) throw conflict()
    return this.get(purpose, id)
  }

  async resolveAccess(hostname: string, purpose: DomainKind): Promise<{ allowed: boolean; reason: string }> {
    const state = await getGateState(this.db)
    if (!state) return { allowed: true, reason: 'RESTRICTION_OFF' }
    const allowed = state[purpose].has(hostname.toLowerCase())
    return { allowed, reason: allowed ? 'DOMAIN_ALLOWED' : 'DOMAIN_NOT_ALLOWED' }
  }

  async getOrigin(purpose: DomainKind): Promise<string | null> {
    const binding = await this.getPrimary(purpose)
    return binding?.enabled && binding.verifiedAt !== null ? `https://${binding.hostname}` : null
  }

  async buildPanelUrl(path: string): Promise<string | null> {
    const origin = await this.getOrigin('panel')
    return origin ? `${origin}/${path.replace(/^\/+/, '')}` : null
  }

  async buildSubscriptionUrl(token: string, platform = 'auto'): Promise<string | null> {
    const origin = await this.getOrigin('subscription')
    return origin ? `${origin}${subscriptionPath(token, platform)}` : null
  }

  async buildUnifiedSubscriptionUrl(token: string): Promise<string | null> {
    const origin = await this.getOrigin('subscription')
    return origin ? `${origin}/s/${token}` : null
  }

  async buildSubscriptionLinks(token: string): Promise<Record<string, string> | null> {
    const origin = await this.getOrigin('subscription')
    if (!origin) return null
    return subscriptionLinks(origin, token, await listPlatformSettings(this.db))
  }
}

const RESTRICTION_KEY = 'domain_restriction_enabled'
const GATE_REVISION_KEY = 'domain_gate_revision'

export function bumpGateRevision(db: AppDatabase): D1PreparedStatement {
  return db.prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(GATE_REVISION_KEY, JSON.stringify(crypto.randomUUID()), new Date().toISOString())
}

export async function getDomainRestrictionEnabled(db: AppDatabase): Promise<boolean> {
  const raw = await getSetting(db, RESTRICTION_KEY)
  return decodeRestriction(raw)
}

function decodeRestriction(raw: string | null): boolean {
  if (raw === null) return false
  const value = decodeSettingJson(raw)
  if (typeof value !== 'boolean') throw new Error('Setting value is corrupt')
  return value
}

export async function putDomainRestrictionEnabled(db: AppDatabase, enabled: boolean): Promise<void> {
  await putSetting(db, RESTRICTION_KEY, enabled)
  invalidateGateCache(db)
}

type GateHosts = Record<DomainKind, Set<string>>
const gateCache = new WeakMap<AppDatabase, { revision: string | null; expiresAt: number; state: Promise<GateHosts> }>()

export function invalidateGateCache(db: AppDatabase): void {
  gateCache.delete(db)
}

async function getGateState(db: AppDatabase): Promise<GateHosts | null> {
  // Read the revision on every request so a mutation in another isolate invalidates the host sets.
  const settings = await db.prepare('SELECT key, value FROM system_settings WHERE key IN (?, ?)')
    .bind(RESTRICTION_KEY, GATE_REVISION_KEY).all<{ key: string; value: string }>().catch((error: unknown) => {
      // A database awaiting its initial migration has no restriction setting.
      if (error instanceof Error && /no such table: (?:main\.)?system_settings\b/i.test(error.message)) return null
      throw error
    })
  if (!settings || !decodeRestriction(settings.results.find(setting => setting.key === RESTRICTION_KEY)?.value ?? null)) {
    invalidateGateCache(db)
    return null
  }
  const { results } = settings
  const revision = results.find(setting => setting.key === GATE_REVISION_KEY)?.value ?? null
  const now = Date.now()
  const cached = gateCache.get(db)
  if (cached && cached.revision === revision && cached.expiresAt > now) return cached.state
  const state = loadGateState(db).catch((error: unknown) => {
    if (gateCache.get(db)?.state === state) invalidateGateCache(db)
    throw error
  })
  gateCache.set(db, { revision, expiresAt: now + 15_000, state })
  return state
}

async function loadGateState(db: AppDatabase): Promise<GateHosts> {
  const rows = await db.prepare(`SELECT b.purpose, d.hostname
    FROM domain_bindings b JOIN domains d ON d.id = b.domain_id
    WHERE b.enabled = 1 AND d.verified_at IS NOT NULL`)
    .all<{ purpose: DomainKind; hostname: string }>()
  const hosts: GateHosts = { panel: new Set(), subscription: new Set() }
  for (const { purpose, hostname } of rows.results) hosts[purpose].add(hostname)
  return hosts
}
