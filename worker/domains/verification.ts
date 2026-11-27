import { type AppDatabase, queryFirst } from '../db/db.js'
import { decodeSettingJson, getSetting } from '../db/settings-repository.js'
import { apiError } from '../platform/api-error.js'
import { bumpGateRevision, DomainService, invalidateGateCache, normalizeHostname, type DomainKind } from './domain-service.js'

const INSTANCE_ID_KEY = 'instance_id'
const VERIFY_BUCKET = 'domain_verify'
const HOUR_MS = 3_600_000

export async function getOrCreateInstanceId(db: AppDatabase): Promise<string> {
  let raw = await getSetting(db, INSTANCE_ID_KEY)
  if (raw === null) {
    const id = `ins_${crypto.randomUUID().replaceAll('-', '')}`
    await db.prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING`).bind(INSTANCE_ID_KEY, JSON.stringify(id), new Date().toISOString()).run()
    raw = await getSetting(db, INSTANCE_ID_KEY)
  }
  const value = raw === null ? null : decodeSettingJson(raw)
  if (typeof value !== 'string' || !value) throw new Error('Setting value is corrupt')
  return value
}

async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function txtNameFor(hostname: string): string {
  return `_subpanel-verify.${hostname}`
}

export async function issueDomainChallenge(db: AppDatabase, purpose: DomainKind, id: string) {
  const { domainId, hostname } = await new DomainService(db).requireRow(purpose, id)
  const random = crypto.getRandomValues(new Uint8Array(32))
  const txtValue = btoa(String.fromCharCode(...random)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  const hash = await hashToken(txtValue)
  const time = Date.now()
  const now = new Date(time).toISOString()
  const expiresAt = new Date(time + 24 * HOUR_MS).toISOString()
  const [, issued] = await db.batch([
    db.prepare(`UPDATE domain_verification_challenges SET consumed_at = ? WHERE domain_id = ? AND consumed_at IS NULL
      AND EXISTS (SELECT 1 FROM domain_bindings WHERE id = ?)`).bind(now, domainId, id),
    db.prepare(`INSERT INTO domain_verification_challenges (id, domain_id, challenge_hash, expires_at, created_at)
      SELECT ?, domain_id, ?, ?, ? FROM domain_bindings WHERE id = ?`)
      .bind(crypto.randomUUID(), hash, expiresAt, now, id),
  ])
  if (!issued.meta.changes) throw apiError(409, 'VERSION_CONFLICT', '域名配置已更改，请刷新后重试')
  invalidateGateCache(db)
  return { txtName: txtNameFor(hostname), txtValue, expiresAt }
}

type DnsFailure = 'DNS_NOT_FOUND' | 'DNS_MISMATCH' | 'TIMEOUT'
type VerifyFailure = DnsFailure | 'INSTANCE_MISMATCH'
type Challenge = { id: string; challenge_hash: string; expires_at: string }

async function checkDns(hostname: string, hash: string, fetcher: typeof fetch): Promise<DnsFailure | null> {
  const normalized = normalizeHostname(hostname)
  if (normalized === null) return 'DNS_NOT_FOUND'
  const url = new URL('https://cloudflare-dns.com/dns-query')
  url.searchParams.set('name', txtNameFor(normalized))
  url.searchParams.set('type', 'TXT')
  try {
    const response = await fetcher(url, {
      headers: { Accept: 'application/dns-json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return 'TIMEOUT'
    const body = await response.json<{ Status?: number; Answer?: Array<{ name?: string; type?: number; data?: string }> }>()
    if (body.Status === 3) return 'DNS_NOT_FOUND'
    if (body.Status !== 0) return 'TIMEOUT'
    const name = txtNameFor(normalized)
    const answers = (body.Answer ?? []).filter(answer =>
      answer.type === 16 && answer.name?.toLowerCase().replace(/\.$/, '') === name && typeof answer.data === 'string')
    if (answers.length === 0) return 'DNS_NOT_FOUND'
    for (const { data } of answers) {
      const value = data!.replace(/^"|"$/g, '').replace(/"\s+"/g, '')
      if (await hashToken(value) === hash) return null
    }
    return 'DNS_MISMATCH'
  } catch {
    return 'TIMEOUT'
  }
}

async function reserveAttempt(db: AppDatabase, id: string, now: number): Promise<void> {
  // Millisecond windows preserve the rolling hour, including concurrent attempts.
  // expires_at stays in seconds for the shared rate-limit cleanup job.
  const result = await db.prepare(`INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at)
    SELECT ?, ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM domain_bindings WHERE id = ?)
      AND COALESCE((SELECT SUM(count) FROM rate_limits
        WHERE bucket = ? AND subject = ? AND window_start > ?), 0) < 10
    ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count = count + 1`)
    .bind(VERIFY_BUCKET, id, now, Math.ceil((now + HOUR_MS) / 1000), id, VERIFY_BUCKET, id, now - HOUR_MS).run()
  if (!result.meta.changes) {
    if (!await db.prepare('SELECT id FROM domain_bindings WHERE id = ?').bind(id).first()) {
      throw apiError(409, 'VERSION_CONFLICT', '域名配置已更改，请刷新后重试')
    }
    throw apiError(429, 'VERIFY_RATE_LIMITED', '验证次数已达上限，请稍后再试')
  }
}

export async function verifyDomain(
  db: AppDatabase,
  purpose: DomainKind,
  id: string,
  observedInstanceId: string,
  fetcher: typeof fetch = fetch,
) {
  const service = new DomainService(db)
  const { domainId, hostname } = await service.requireRow(purpose, id)
  const started = Date.now()
  await reserveAttempt(db, id, started)
  const activeChallenge = `SELECT id, challenge_hash, expires_at FROM domain_verification_challenges
    WHERE domain_id = ? AND consumed_at IS NULL AND expires_at > ?`
  const startedAt = new Date(started).toISOString()
  const challenge = await queryFirst<Challenge>(db.prepare(activeChallenge).bind(domainId, startedAt))

  let failure: VerifyFailure | null = challenge ? await checkDns(hostname, challenge.challenge_hash, fetcher) : 'DNS_NOT_FOUND'
  if (!failure && observedInstanceId !== await getOrCreateInstanceId(db)) failure = 'INSTANCE_MISMATCH'

  const now = new Date().toISOString()
  if (challenge && challenge.expires_at <= now) failure = 'DNS_NOT_FOUND'
  const challengeId = challenge?.id ?? null
  const statements = [
    db.prepare(`UPDATE domains SET verification_status = ?, verified_at = COALESCE(?, verified_at),
      last_checked_at = ?, last_error_code = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM domain_bindings WHERE id = ?)
      AND (SELECT id FROM (${activeChallenge})) IS ?`)
      .bind(failure ? 'failed' : 'verified', failure ? null : now, now, failure, now, domainId, id,
        domainId, startedAt, challengeId),
  ]
  if (!failure) {
    statements.push(db.prepare(`UPDATE domain_verification_challenges SET consumed_at = ?
      WHERE id = ? AND changes() = 1`).bind(now, challengeId))
  }
  const [updated] = await db.batch([...statements, bumpGateRevision(db)])
  if (!updated.meta.changes) throw apiError(409, 'VERSION_CONFLICT', '验证挑战已更改，请刷新后重试')
  invalidateGateCache(db)
  return { domain: await service.get(purpose, id), failure }
}
