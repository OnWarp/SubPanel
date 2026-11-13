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
  'id, username, role, enabled, password_algorithm, password_iterations, password_salt, password_hash, session_version, email, email_normalized, email_verified_at, created_at, updated_at'

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
           password_salt, password_hash, session_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           role = excluded.role,
           enabled = excluded.enabled,
           password_algorithm = excluded.password_algorithm,
           password_iterations = excluded.password_iterations,
           password_salt = excluded.password_salt,
           password_hash = excluded.password_hash,
           session_version = excluded.session_version,
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
