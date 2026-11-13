import { env as workerEnv } from 'cloudflare:workers'
import { batch, queryFirst, type AppDatabase } from '../db/db.js'
import { apiError } from '../platform/api-error.js'
import { fromBase64Url, readCryptoMaterial, toBase64Url } from '../platform/crypto.js'
import { sendEmailVerificationCode } from './email.js'
import { clearWindowHits, countWindowHits, recordWindowHit } from './rate-limit.js'
import { normalizeEmail } from './schema.js'

// Unified email verification codes for every account flow (register, bind
// email, change email, reset password). Codes are 6 digits, live 10 minutes,
// and are stored as HMAC hashes keyed by a secret derived from SESSION_KEY,
// so a database leak does not expose brute-forceable plain SHA-256 hashes of
// a 6-digit space (the batch-4 hardening item). Batch-4 rows hashed with
// plain SHA-256 are not compatible and simply expire within 10 minutes.
export type VerificationPurpose = 'register' | 'bind_email' | 'change_email' | 'reset_password'

const CODE_TTL_MS = 10 * 60 * 1_000
const RESEND_COOLDOWN_MS = 60 * 1_000
const MAX_CODE_ATTEMPTS = 5
const ATTEMPT_BUCKET = 'email_code_attempt'
const CODE_KEY_INFO = 'subpanel:email-verification-code:v1'

const encoder = new TextEncoder()

interface VerificationRow {
  id: number
  user_id: string | null
  email: string
  email_normalized: string
  purpose: VerificationPurpose
  token_hash: string
  expires_at: string
  consumed_at: string | null
  created_at: string
}

export interface PendingVerification {
  id: number
  userId: string | null
  email: string
  emailNormalized: string
  purpose: VerificationPurpose
  expiresAt: string
  createdAt: string
}

export function generateVerificationCode(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return String(value).padStart(6, '0')
}

// Key material resolution: an explicit override (tests), then the
// SESSION_KEY Worker secret, then the session key inside the crypto material
// (env secrets pair or the KV `system:crypto` record). The derived HMAC key
// itself never leaves this module.
let secretOverride: string | null = null

export function setVerificationCodeSecret(secret: string | null): void {
  secretOverride = secret
}

async function resolveSessionKey(): Promise<string> {
  if (secretOverride !== null) return secretOverride
  try {
    const fromEnv = workerEnv.SESSION_KEY?.trim()
    if (fromEnv) return fromEnv
  } catch {
    // Ambient bindings are unavailable outside a Worker request context.
  }
  try {
    const material = await readCryptoMaterial(workerEnv.DATA)
    return material.sessionKey
  } catch {
    // Fall through to the explicit configuration error below.
  }
  throw new Error('Verification code secret is unavailable: set the SESSION_KEY secret or configure crypto material')
}

let derivedKeyCache: { source: string; key: CryptoKey } | null = null

async function deriveCodeKey(sessionKey: string): Promise<CryptoKey> {
  if (derivedKeyCache?.source === sessionKey) return derivedKeyCache.key
  const material = await crypto.subtle.importKey('raw', fromBase64Url(sessionKey), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('subpanel'),
      info: encoder.encode(CODE_KEY_INFO),
    },
    material,
    256,
  )
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  derivedKeyCache = { source: sessionKey, key }
  return key
}

async function hashVerificationCode(
  purpose: VerificationPurpose,
  emailNormalized: string,
  code: string,
): Promise<string> {
  const key = await deriveCodeKey(await resolveSessionKey())
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${purpose}:${emailNormalized}:${code}`),
  )
  return toBase64Url(new Uint8Array(signature))
}

const PENDING_COLUMNS =
  'id, user_id, email, email_normalized, purpose, token_hash, expires_at, consumed_at, created_at'

async function latestPendingRow(
  db: AppDatabase,
  purpose: VerificationPurpose,
  where: 'email_normalized' | 'user_id',
  value: string,
): Promise<VerificationRow | null> {
  return queryFirst<VerificationRow>(
    db
      .prepare(
        `SELECT ${PENDING_COLUMNS} FROM email_verifications
         WHERE ${where} = ? AND purpose = ? AND consumed_at IS NULL
         ORDER BY id DESC`,
      )
      .bind(value, purpose),
  )
}

const toPending = (row: VerificationRow): PendingVerification => ({
  id: row.id,
  userId: row.user_id,
  email: row.email,
  emailNormalized: row.email_normalized,
  purpose: row.purpose,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
})

// Latest unconsumed verification for a purpose, addressed by mailbox or by
// account. Routes use it to report precise states (no pending code, expired)
// that the boolean verify contract intentionally collapses.
export async function findPendingVerification(
  db: AppDatabase,
  input: { purpose: VerificationPurpose; email?: string; userId?: string },
): Promise<PendingVerification | null> {
  if (input.email !== undefined) {
    const row = await latestPendingRow(db, input.purpose, 'email_normalized', normalizeEmail(input.email))
    return row ? toPending(row) : null
  }
  if (input.userId !== undefined) {
    const row = await latestPendingRow(db, input.purpose, 'user_id', input.userId)
    return row ? toPending(row) : null
  }
  throw new Error('findPendingVerification requires an email or a userId')
}

export async function issueVerificationCode(
  db: AppDatabase,
  input: { email: string; purpose: VerificationPurpose; userId?: string },
): Promise<{ expiresAt: string }> {
  const email = normalizeEmail(input.email)
  const now = new Date()
  const nowIso = now.toISOString()

  // Resend cooldown: a still-valid code for the same mailbox and purpose
  // blocks re-issue for 60 seconds. An expired leftover never blocks, which
  // keeps the batch-4 bind flow (re-request after expiry) working unchanged.
  const pending = await latestPendingRow(db, input.purpose, 'email_normalized', email)
  if (
    pending &&
    Date.parse(pending.expires_at) > now.getTime() &&
    now.getTime() - Date.parse(pending.created_at) < RESEND_COOLDOWN_MS
  ) {
    throw apiError(429, 'CODE_TOO_SOON', '验证码发送过于频繁，请稍后再试')
  }

  const code = generateVerificationCode()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString()
  const tokenHash = await hashVerificationCode(input.purpose, email, code)
  await batch(db, [
    db
      .prepare(
        'DELETE FROM email_verifications WHERE email_normalized = ? AND purpose = ? AND consumed_at IS NULL',
      )
      .bind(email, input.purpose),
    db
      .prepare(
        `INSERT INTO email_verifications (user_id, email, email_normalized, purpose, token_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(input.userId ?? null, email, email, input.purpose, tokenHash, expiresAt, nowIso),
  ])

  let username: string | undefined
  if (input.userId !== undefined) {
    const owner = await queryFirst<{ username: string }>(
      db.prepare('SELECT username FROM users WHERE id = ?').bind(input.userId),
    )
    username = owner?.username
  }
  await sendEmailVerificationCode({ to: email, code, purpose: input.purpose, username })
  return { expiresAt }
}

export async function verifyVerificationCode(
  db: AppDatabase,
  input: { email: string; purpose: VerificationPurpose; code: string },
): Promise<boolean> {
  const email = normalizeEmail(input.email)
  const now = new Date()
  const row = await latestPendingRow(db, input.purpose, 'email_normalized', email)
  if (!row) return false
  if (Date.parse(row.expires_at) <= now.getTime()) return false

  // Failed attempts are counted on the shared rate_limits table, keyed by
  // the verification row with its creation time as the fixed window start
  // (the batch-4 scheme). Reaching the limit locks the code: even a correct
  // code is then refused with a 429 so the caller can ask for a fresh one.
  const windowStart = Math.floor(Date.parse(row.created_at) / 1_000)
  const attempts = await countWindowHits(db, ATTEMPT_BUCKET, String(row.id), windowStart)
  if (attempts >= MAX_CODE_ATTEMPTS) {
    throw apiError(429, 'TOO_MANY_ATTEMPTS', '验证码尝试次数过多，请重新获取')
  }
  if ((await hashVerificationCode(input.purpose, email, input.code)) !== row.token_hash) {
    await recordWindowHit(
      db,
      ATTEMPT_BUCKET,
      String(row.id),
      windowStart,
      Math.floor(Date.parse(row.expires_at) / 1_000),
    )
    return false
  }

  await db
    .prepare('UPDATE email_verifications SET consumed_at = ? WHERE id = ?')
    .bind(now.toISOString(), row.id)
    .run()
  await clearWindowHits(db, ATTEMPT_BUCKET, String(row.id))
  return true
}
