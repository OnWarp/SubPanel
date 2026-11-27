import type { VerifyFailure } from './verification-contract.js'
import { type AppDatabase, queryFirst } from '../db/db.js'
import { decodeSettingJson, getSetting } from '../db/settings-repository.js'
import { apiError } from '../platform/api-error.js'
import { randomToken, readCryptoMaterial, signHmac, verifyHmac } from '../platform/crypto.js'
import { bumpGateRevision, DomainService, invalidateGateCache, normalizeHostname, type DomainKind } from './domain-service.js'

const INSTANCE_ID_KEY = 'instance_id'
const VERIFY_BUCKET = 'domain_verify'
const HOUR_MS = 3_600_000
const CHALLENGE_MS = 120_000

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

export async function issueDomainChallenge(db: AppDatabase, purpose: DomainKind, id: string) {
  const { domainId, hostname } = await new DomainService(db).requireRow(purpose, id)
  if (normalizeHostname(hostname) !== hostname) throw apiError(400, 'INVALID_HOSTNAME', '域名格式无效')
  const nonce = randomToken()
  const hash = await hashToken(nonce)
  const challengeId = crypto.randomUUID()
  const time = Date.now()
  const now = new Date(time).toISOString()
  const expiresAt = new Date(time + CHALLENGE_MS).toISOString()
  const [, issued] = await db.batch([
    db.prepare(`UPDATE domain_verification_challenges SET consumed_at = ? WHERE domain_id = ? AND consumed_at IS NULL
      AND EXISTS (SELECT 1 FROM domain_bindings WHERE id = ?)`).bind(now, domainId, id),
    db.prepare(`INSERT INTO domain_verification_challenges (id, domain_id, challenge_hash, expires_at, created_at)
      SELECT ?, domain_id, ?, ?, ? FROM domain_bindings WHERE id = ?`)
      .bind(challengeId, hash, expiresAt, now, id),
  ])
  if (!issued.meta.changes) throw apiError(409, 'VERSION_CONFLICT', '域名配置已更改，请刷新后重试')
  return { nonce, expiresAt, challengeId }
}

export type DomainProof = {
  version: 1
  hostname: string
  challengeId: string
  expiresAt: string
  instanceId: string
  signature: string
}

type VerificationInput = {
  proof?: DomainProof
  challengeId?: string
  reason?: 'PROBE_FAILED'
}

export function encodeProof({ hostname, challengeId, expiresAt, instanceId }: Omit<DomainProof, 'signature'>): string {
  return ['v1', hostname, challengeId, expiresAt, instanceId].join('\n')
}

type Challenge = { id: string; expires_at: string; created_at: string; consumed_at: string | null }

function isHttpChallenge(challenge: Challenge): boolean {
  return Date.parse(challenge.expires_at) - Date.parse(challenge.created_at) === CHALLENGE_MS
}

export async function createDomainProof(env: Env, hostname: string, nonce: string): Promise<DomainProof | null> {
  const challenge = await queryFirst<Challenge>(env.DB.prepare(`SELECT c.id, c.expires_at, c.created_at, c.consumed_at
    FROM domains d JOIN domain_verification_challenges c ON c.domain_id = d.id
    WHERE d.hostname = ? AND c.challenge_hash = ? AND c.consumed_at IS NULL AND c.expires_at > ?`)
    .bind(hostname, await hashToken(nonce), new Date().toISOString()))
  if (!challenge || !isHttpChallenge(challenge)) return null
  const proof = {
    version: 1 as const,
    hostname,
    challengeId: challenge.id,
    expiresAt: challenge.expires_at,
    instanceId: await getOrCreateInstanceId(env.DB),
  }
  const { sessionKey } = await readCryptoMaterial(env.DATA, env)
  return { ...proof, signature: await signHmac(encodeProof(proof), sessionKey) }
}

export async function allowDomainProbe(db: AppDatabase, address: string): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 60_000) * 60
  const result = await db.prepare(`INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at)
    VALUES ('domain_probe', ?, ?, 1, ?)
    ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count = count + 1 WHERE count < 60`)
    .bind(address, windowStart, windowStart + 60).run()
  return result.meta.changes === 1
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

async function validateProof(env: Env, input: VerificationInput, hostname: string, challenge: Challenge) {
  if (input.reason) return input.reason
  const { proof } = input
  if (!proof || proof.hostname !== hostname || proof.expiresAt !== challenge.expires_at) return 'PROOF_INVALID'
  try {
    const { sessionKey } = await readCryptoMaterial(env.DATA, env)
    const validSignature = await verifyHmac(encodeProof(proof), proof.signature, sessionKey)
    if (proof.instanceId !== await getOrCreateInstanceId(env.DB)) return 'INSTANCE_MISMATCH'
    return validSignature ? null : 'PROOF_INVALID'
  } catch {
    return 'TIMEOUT'
  }
}

export async function verifyDomain(env: Env, purpose: DomainKind, id: string, input: VerificationInput) {
  const { DB: db } = env
  const service = new DomainService(db)
  const { domainId, hostname } = await service.requireRow(purpose, id)
  await reserveAttempt(db, id, Date.now())
  const challengeId = input.proof?.challengeId ?? input.challengeId
  const challenge = challengeId ? await queryFirst<Challenge>(db.prepare(`SELECT id, expires_at, created_at, consumed_at
    FROM domain_verification_challenges WHERE domain_id = ? AND id = ?`).bind(domainId, challengeId)) : null
  const rejected = async (failure: VerifyFailure) => ({ domain: await service.get(purpose, id), failure })
  if (!challengeId) return rejected('PROOF_INVALID')
  if (!challenge || challenge.consumed_at || !isHttpChallenge(challenge)) return rejected('CHALLENGE_INVALID')

  let failure: VerifyFailure | null = challenge.expires_at <= new Date().toISOString()
    ? 'CHALLENGE_EXPIRED' : await validateProof(env, input, hostname, challenge)
  const now = new Date().toISOString()
  if (challenge.expires_at <= now) failure = 'CHALLENGE_EXPIRED'

  // Both writes have the same eligibility predicate and commit in one D1 batch.
  // A competing issuance or finalization makes both writes no-ops.
  const eligible = `id = ? AND consumed_at IS NULL
    AND EXISTS (SELECT 1 FROM domain_bindings WHERE id = ? AND domain_id = ?)`
  const eligibilityArgs = [challenge.id, id, domainId]
  const [, consumed] = await db.batch([
    db.prepare(`UPDATE domains SET verification_status = ?, verified_at = COALESCE(?, verified_at),
      last_checked_at = ?, last_error_code = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM domain_verification_challenges WHERE ${eligible})`)
      .bind(failure ? 'failed' : 'verified', failure ? null : now, now, failure, now, domainId, ...eligibilityArgs),
    db.prepare(`UPDATE domain_verification_challenges SET consumed_at = ? WHERE ${eligible}`).bind(now, ...eligibilityArgs),
    bumpGateRevision(db),
  ])
  if (!consumed.meta.changes) return rejected('CHALLENGE_INVALID')
  invalidateGateCache(db)
  return { domain: await service.get(purpose, id), failure }
}
