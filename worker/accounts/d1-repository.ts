import { batch, queryFirst, type AppDatabase } from '../db/db.js'
import {
  ACCOUNTS_D1_READY_KEY,
  ACCOUNTS_SETTING_KEYS,
  deleteSettings,
  readSettingMap,
  upsertSettingStatement,
} from '../db/module-switch.js'
import {
  accountsSnapshotSchema,
  emptyAccountsSnapshot,
  type AccountUser,
  type AccountsSnapshot,
  type User,
} from './schema.js'

interface UserRow {
  id: string
  username: string
  role: 'admin' | 'user'
  enabled: number
  password_algorithm: string
  password_iterations: number
  password_salt: string
  password_hash: string
  session_version: number
  email: string | null
  email_normalized: string | null
  email_verified_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

const rowToAccountUser = (row: UserRow): AccountUser => ({
  id: row.id,
  username: row.username,
  role: row.role,
  enabled: row.enabled === 1,
  password: {
    algorithm: 'PBKDF2-SHA-256',
    iterations: row.password_iterations,
    salt: row.password_salt,
    hash: row.password_hash,
  },
  sessionVersion: row.session_version,
  deletedAt: row.deleted_at,
  email: row.email,
  emailNormalized: row.email_normalized,
  emailVerifiedAt: row.email_verified_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const rowToUser = (row: UserRow): User => {
  const { email: _email, emailNormalized: _n, emailVerifiedAt: _v, ...user } = rowToAccountUser(row)
  return user
}

const USER_COLUMNS =
  'id, username, role, enabled, password_algorithm, password_iterations, password_salt, password_hash, session_version, email, email_normalized, email_verified_at, deleted_at, created_at, updated_at'

async function findUserWhere(db: AppDatabase, where: string, value: string): Promise<AccountUser | null> {
  const row = await queryFirst<UserRow>(db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE ${where} = ?`).bind(value))
  return row ? rowToAccountUser(row) : null
}

export async function findUserById(db: AppDatabase, id: string): Promise<AccountUser | null> {
  return findUserWhere(db, 'id', id)
}

export async function findUserByUsername(db: AppDatabase, username: string): Promise<AccountUser | null> {
  return findUserWhere(db, 'username', username)
}

export async function findUserByEmailNormalized(
  db: AppDatabase,
  emailNormalized: string,
): Promise<AccountUser | null> {
  return findUserWhere(db, 'email_normalized', emailNormalized)
}

export async function readAccountsFromD1(db: AppDatabase): Promise<AccountsSnapshot> {
  const settings = await readSettingMap(db, Object.values(ACCOUNTS_SETTING_KEYS))
  const listed = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY CAST(substr(id, 5) AS INTEGER) ASC`)
    .all<UserRow>()
  const users = listed.results.map(rowToUser)
  const revision = settings.get(ACCOUNTS_SETTING_KEYS.revision)
  if (users.length === 0 && revision === undefined) return emptyAccountsSnapshot()

  const maxUserId = users.reduce((max, user) => Math.max(max, Number(user.id.slice('usr_'.length))), 0)
  const storedNext = settings.get(ACCOUNTS_SETTING_KEYS.nextUserId)
  const storedUpdatedAt = settings.get(ACCOUNTS_SETTING_KEYS.updatedAt)
  const snapshot = {
    schemaVersion: 1 as const,
    revision: typeof revision === 'number' ? revision : 0,
    updatedAt: typeof storedUpdatedAt === 'string' ? storedUpdatedAt : '1970-01-01T00:00:00.000Z',
    nextUserId: typeof storedNext === 'number' ? storedNext : maxUserId + 1,
    users,
  }
  try {
    return accountsSnapshotSchema.parse(snapshot)
  } catch {
    throw new Error('Accounts snapshot is corrupt')
  }
}

// Per-entity persistence for a whole snapshot: upsert each user row and
// delete rows the snapshot no longer contains. The email columns are NOT
// part of the snapshot shape, so upserts deliberately leave them untouched;
// only the binding flow (setUserEmail) writes them.
export async function persistAccountsSnapshot(db: AppDatabase, snapshot: AccountsSnapshot): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const user of snapshot.users) {
    statements.push(
      db.prepare(
        `INSERT INTO users (
           id, username, role, enabled, password_algorithm, password_iterations,
           password_salt, password_hash, session_version, deleted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           role = excluded.role,
           enabled = excluded.enabled,
           password_algorithm = excluded.password_algorithm,
           password_iterations = excluded.password_iterations,
           password_salt = excluded.password_salt,
           password_hash = excluded.password_hash,
           session_version = excluded.session_version,
           deleted_at = excluded.deleted_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      ).bind(
        user.id,
        user.username,
        user.role,
        user.enabled ? 1 : 0,
        user.password.algorithm,
        user.password.iterations,
        user.password.salt,
        user.password.hash,
        user.sessionVersion,
        user.deletedAt,
        user.createdAt,
        user.updatedAt,
      ),
    )
  }
  if (snapshot.users.length > 0) {
    const placeholders = snapshot.users.map(() => '?').join(', ')
    statements.push(
      db.prepare(`DELETE FROM users WHERE id NOT IN (${placeholders})`).bind(...snapshot.users.map((user) => user.id)),
    )
  } else {
    statements.push(db.prepare('DELETE FROM users'))
  }
  statements.push(
    upsertSettingStatement(db, ACCOUNTS_SETTING_KEYS.schemaVersion, snapshot.schemaVersion, snapshot.updatedAt),
    upsertSettingStatement(db, ACCOUNTS_SETTING_KEYS.revision, snapshot.revision, snapshot.updatedAt),
    upsertSettingStatement(db, ACCOUNTS_SETTING_KEYS.updatedAt, snapshot.updatedAt, snapshot.updatedAt),
    upsertSettingStatement(db, ACCOUNTS_SETTING_KEYS.nextUserId, snapshot.nextUserId, snapshot.updatedAt),
  )
  await batch(db, statements)
}

export async function setUserEmail(
  db: AppDatabase,
  userId: string,
  fields: { email: string; emailNormalized: string; emailVerifiedAt: string },
  now: string,
): Promise<void> {
  await db
    .prepare('UPDATE users SET email = ?, email_normalized = ?, email_verified_at = ?, updated_at = ? WHERE id = ?')
    .bind(fields.email, fields.emailNormalized, fields.emailVerifiedAt, now, userId)
    .run()
}

export async function clearAccountsStorage(db: AppDatabase): Promise<void> {
  await batch(db, [
    db.prepare('DELETE FROM users'),
    db.prepare('DELETE FROM email_verifications'),
    db.prepare('DELETE FROM email_change_requests'),
    db.prepare('DELETE FROM rate_limits'),
  ])
  await deleteSettings(db, [...Object.values(ACCOUNTS_SETTING_KEYS), ACCOUNTS_D1_READY_KEY])
}

// ---------------------------------------------------------------------------
// Admin user management (batch 8). The list query aggregates subscription
// counts with a single LEFT JOIN so a page never degrades into N+1 lookups.
// ---------------------------------------------------------------------------

export interface AdminUserFilters {
  query: string | null
  role: 'admin' | 'user' | null
  enabled: boolean | null
  deleted: 'active' | 'only' | 'all'
}

export type AdminUser = AccountUser & { subscriptionCount: number }

interface AdminUserRow extends UserRow {
  subscription_count: number
}

function adminUserWhere(filters: AdminUserFilters): { clause: string, binds: Array<string | number> } {
  const clauses: string[] = []
  const binds: Array<string | number> = []
  if (filters.deleted === 'active') clauses.push('u.deleted_at IS NULL')
  if (filters.deleted === 'only') clauses.push('u.deleted_at IS NOT NULL')
  if (filters.role !== null) {
    clauses.push('u.role = ?')
    binds.push(filters.role)
  }
  if (filters.enabled !== null) {
    clauses.push('u.enabled = ?')
    binds.push(filters.enabled ? 1 : 0)
  }
  if (filters.query !== null && filters.query !== '') {
    clauses.push('(instr(lower(u.username), ?) > 0 OR instr(lower(coalesce(u.email, \'\')), ?) > 0)')
    binds.push(filters.query, filters.query)
  }
  return { clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', binds }
}

export async function listAdminUsers(
  db: AppDatabase,
  filters: AdminUserFilters,
  limit: number,
  offset: number,
): Promise<AdminUser[]> {
  const { clause, binds } = adminUserWhere(filters)
  const listed = await db
    .prepare(
      `SELECT ${USER_COLUMNS.split(', ').map((column) => `u.${column}`).join(', ')}, COUNT(s.id) AS subscription_count
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       ${clause}
       GROUP BY u.id
       ORDER BY CAST(substr(u.id, 5) AS INTEGER) ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<AdminUserRow>()
  return listed.results.map((row) => ({ ...rowToAccountUser(row), subscriptionCount: Number(row.subscription_count) }))
}

export async function countAdminUsers(db: AppDatabase, filters: AdminUserFilters): Promise<number> {
  const { clause, binds } = adminUserWhere(filters)
  const row = await queryFirst<{ count: number }>(
    db.prepare(`SELECT COUNT(*) AS count FROM users u ${clause}`).bind(...binds),
  )
  return Number(row?.count ?? 0)
}

export interface AdminUserSubscription {
  id: string
  name: string
  tokenPrefix: string
  enabled: boolean
  defaultClient: string
  revision: number
  startsAt: number | null
  expiresAt: number | null
  groupIds: string[]
  createdAt: string
  updatedAt: string
}

interface SubscriptionRow {
  id: string
  name: string
  token_prefix: string
  enabled: number
  default_client: string
  revision: number
  starts_at: number | null
  expires_at: number | null
  created_at: string
  updated_at: string
}

export async function listAdminUserSubscriptions(db: AppDatabase, userId: string): Promise<AdminUserSubscription[]> {
  const listed = await db
    .prepare(
      `SELECT id, name, token_prefix, enabled, default_client, revision, starts_at, expires_at, created_at, updated_at
       FROM subscriptions WHERE user_id = ? ORDER BY CAST(substr(id, 5) AS INTEGER) ASC`,
    )
    .bind(userId)
    .all<SubscriptionRow>()
  if (listed.results.length === 0) return []
  const ids = listed.results.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')
  const links = await db
    .prepare(
      `SELECT subscription_id, group_id FROM subscription_groups
       WHERE subscription_id IN (${placeholders}) ORDER BY subscription_id, position ASC`,
    )
    .bind(...ids)
    .all<{ subscription_id: string, group_id: string }>()
  const groupIds = new Map<string, string[]>()
  for (const link of links.results) {
    const owned = groupIds.get(link.subscription_id) ?? []
    owned.push(link.group_id)
    groupIds.set(link.subscription_id, owned)
  }
  return listed.results.map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    enabled: row.enabled === 1,
    defaultClient: row.default_client,
    revision: row.revision,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    groupIds: groupIds.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export interface AdminInvitationRedemption {
  id: number
  invitationId: string
  invitationUsername: string
  redeemedAt: string
}

export async function listAdminUserRedemptions(db: AppDatabase, userId: string): Promise<AdminInvitationRedemption[]> {
  const listed = await db
    .prepare(
      `SELECT r.id AS id, r.invitation_id AS invitation_id, r.redeemed_at AS redeemed_at, i.username AS invitation_username
       FROM invitation_redemptions r
       JOIN invitations i ON i.id = r.invitation_id
       WHERE r.user_id = ?
       ORDER BY r.id ASC`,
    )
    .bind(userId)
    .all<{ id: number, invitation_id: string, redeemed_at: string, invitation_username: string }>()
  return listed.results.map((row) => ({
    id: row.id,
    invitationId: row.invitation_id,
    invitationUsername: row.invitation_username,
    redeemedAt: row.redeemed_at,
  }))
}

// Permanent deletion, ordered so no foreign key is ever violated mid-batch:
// shares reference both the user and their subscriptions with RESTRICT, so
// they go first; subscriptions (RESTRICT from users) precede the user row;
// redemptions reference both users and the user's own invitations; the
// CASCADE tables (email_verifications, email_change_requests) are deleted
// explicitly anyway so the batch does not depend on FK enforcement being on.
// Returns the purged subscriptions' token hashes so the caller can drop
// their compiled artifacts from KV.
export async function purgeUserFromD1(
  db: AppDatabase,
  user: { id: string, username: string, emailNormalized: string | null },
): Promise<{ tokenHashes: string[] }> {
  const listed = await db
    .prepare('SELECT token_hash FROM subscriptions WHERE user_id = ?')
    .bind(user.id)
    .all<{ token_hash: string }>()
  const tokenHashes = listed.results.map((row) => row.token_hash)

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `DELETE FROM shares
       WHERE owner_user_id = ?
          OR subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?)`,
    ).bind(user.id, user.id),
    db.prepare(
      `DELETE FROM subscription_groups
       WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?)`,
    ).bind(user.id),
    db.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(user.id),
    db.prepare(
      `DELETE FROM invitation_redemptions
       WHERE user_id = ?
          OR invitation_id IN (SELECT id FROM invitations WHERE user_id = ?)`,
    ).bind(user.id, user.id),
    db.prepare('DELETE FROM invitations WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM email_change_requests WHERE user_id = ?').bind(user.id),
  ]
  const subjects = [user.username, user.emailNormalized].filter((value): value is string => value !== null && value !== '')
  if (subjects.length > 0) {
    const placeholders = subjects.map(() => '?').join(', ')
    statements.push(
      db.prepare(`DELETE FROM rate_limits WHERE subject IN (${placeholders})`).bind(...subjects),
    )
  }
  statements.push(db.prepare('DELETE FROM users WHERE id = ?').bind(user.id))
  await batch(db, statements)
  return { tokenHashes }
}
