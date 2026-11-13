import type { User } from '../accounts/schema.js'
import type { AppDatabase } from './db.js'

// Subscriptions and shares reference users. Accounts stay in KV, so a missing
// D1 row is inserted from that snapshot and never updated.
export function userAnchorStatement(db: AppDatabase, user: User): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO users (
      id, username, role, enabled,
      password_algorithm, password_iterations, password_salt, password_hash,
      session_version, email, email_normalized, email_verified_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
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
  )
}

export function userAnchorStatements(
  db: AppDatabase,
  users: readonly User[],
  ids: readonly string[],
): D1PreparedStatement[] {
  const byId = new Map(users.map((user) => [user.id, user]))
  const statements: D1PreparedStatement[] = []
  for (const id of new Set(ids)) {
    const user = byId.get(id)
    if (!user) throw new Error('Referenced user is missing')
    statements.push(userAnchorStatement(db, user))
  }
  return statements
}
