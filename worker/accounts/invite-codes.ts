import { queryFirst, type AppDatabase } from '../db/db.js'
import { apiError } from '../platform/api-error.js'
import { hashToken, randomToken, toBase64Url } from '../platform/crypto.js'

// Registration invitation codes (batch 6). Two kinds share one table:
// 'multi' — a single code many people can redeem, optionally capped by
// max_uses (NULL = unlimited) and an expiry; 'single' — batch-generated
// one-time codes (max_uses fixed at 1). Only the SHA-256 hash and an 8-char
// prefix are stored; the plaintext code is returned once at creation.
export type InviteCodeType = 'multi' | 'single'

export interface InviteCodeRow {
  id: string
  token_hash: string
  token_prefix: string
  type: InviteCodeType
  max_uses: number | null
  used_count: number
  expires_at: string | null
  disabled: number
  created_by: string | null
  created_at: string
}

const CODE_COLUMNS =
  'id, token_hash, token_prefix, type, max_uses, used_count, expires_at, disabled, created_by, created_at'

export interface CreatedInviteCode {
  id: string
  code: string
  prefix: string
  type: InviteCodeType
  maxUses: number | null
  expiresAt: string | null
  createdAt: string
}

export interface PublicInviteCode {
  id: string
  prefix: string
  type: InviteCodeType
  maxUses: number | null
  usedCount: number
  remaining: number | null
  expiresAt: string | null
  disabled: boolean
  createdBy: string | null
  createdAt: string
}

export const toPublicInviteCode = (row: InviteCodeRow): PublicInviteCode => ({
  id: row.id,
  prefix: row.token_prefix,
  type: row.type,
  maxUses: row.max_uses,
  usedCount: row.used_count,
  remaining: row.max_uses === null ? null : Math.max(row.max_uses - row.used_count, 0),
  expiresAt: row.expires_at,
  disabled: row.disabled === 1,
  createdBy: row.created_by,
  createdAt: row.created_at,
})

export async function findInviteCodeByTokenHash(
  db: AppDatabase,
  tokenHash: string,
): Promise<InviteCodeRow | null> {
  return queryFirst<InviteCodeRow>(
    db.prepare(`SELECT ${CODE_COLUMNS} FROM invite_codes WHERE token_hash = ?`).bind(tokenHash),
  )
}

export async function findInviteCodeByCode(
  db: AppDatabase,
  code: string,
): Promise<InviteCodeRow | null> {
  return findInviteCodeByTokenHash(db, await hashToken(code))
}

export async function createInviteCodes(
  db: AppDatabase,
  createdBy: string,
  input: { type: 'multi' | 'batch'; maxUses?: number | null; expiresAt?: string | null; count?: number },
  now = new Date(),
): Promise<CreatedInviteCode[]> {
  const nowIso = now.toISOString()
  // 'multi' creates one reusable code; 'batch' creates count one-time codes
  // (stored with type 'single').
  const storedType: InviteCodeType = input.type === 'multi' ? 'multi' : 'single'
  const total = input.type === 'multi' ? 1 : Math.min(Math.max(Math.floor(input.count ?? 1), 1), 200)
  const created: CreatedInviteCode[] = []
  const statements: D1PreparedStatement[] = []
  for (let index = 0; index < total; index += 1) {
    const code = randomToken()
    const id = `inv_${toBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`
    const maxUses = input.type === 'multi' ? (input.maxUses ?? null) : 1
    statements.push(
      db
        .prepare(
          `INSERT INTO invite_codes (id, token_hash, token_prefix, type, max_uses, used_count, expires_at, disabled, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
        )
        .bind(id, await hashToken(code), code.slice(0, 8), storedType, maxUses, input.expiresAt ?? null, createdBy, nowIso),
    )
    created.push({
      id,
      code,
      prefix: code.slice(0, 8),
      type: storedType,
      maxUses,
      expiresAt: input.expiresAt ?? null,
      createdAt: nowIso,
    })
  }
  await db.batch(statements)
  return created
}

export async function listInviteCodes(db: AppDatabase): Promise<PublicInviteCode[]> {
  const listed = await db
    .prepare(`SELECT ${CODE_COLUMNS} FROM invite_codes ORDER BY created_at DESC, id ASC`)
    .all<InviteCodeRow>()
  return listed.results.map(toPublicInviteCode)
}

export async function disableInviteCode(db: AppDatabase, id: string): Promise<void> {
  const existing = await queryFirst<{ id: string }>(
    db.prepare('SELECT id FROM invite_codes WHERE id = ?').bind(id),
  )
  if (!existing) throw apiError(404, 'INVITE_CODE_NOT_FOUND', '邀请码不存在')
  await db.prepare('UPDATE invite_codes SET disabled = 1 WHERE id = ?').bind(id).run()
}
