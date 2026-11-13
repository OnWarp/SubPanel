import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import initSql from '../../../migrations/0001_init.sql?raw'
import emailVerificationPurposeSql from '../../../migrations/0002_email_verification_purpose.sql?raw'

export const INIT_MIGRATION_NAME = '0001_init.sql'

export const D1_TABLES = [
  'allowed_email_domains',
  'app_platforms',
  'apps',
  'audit_logs',
  'cron_runs',
  'email_change_requests',
  'email_verifications',
  'group_node_order',
  'group_nodes',
  'group_sources',
  'groups',
  'invitation_redemptions',
  'invitations',
  'migration_runs',
  'node_raw_variants',
  'nodes',
  'rate_limits',
  'shares',
  'sources',
  'subscription_groups',
  'subscriptions',
  'system_settings',
  'users',
] as const

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    if (inLineComment) {
      if (char === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (!inSingle && !inDouble && char === '-' && next === '-') {
      inLineComment = true
      index += 1
      continue
    }
    if (!inSingle && !inDouble && char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }
    if (char === "'" && !inDouble) {
      if (inSingle && next === "'") {
        current += "''"
        index += 1
        continue
      }
      inSingle = !inSingle
      current += char
      continue
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      current += char
      continue
    }
    if (char === ';' && !inSingle && !inDouble) {
      const statement = current.trim()
      if (statement.length > 0) statements.push(statement)
      current = ''
      continue
    }
    current += char
  }

  const tail = current.trim()
  if (tail.length > 0) statements.push(tail)
  return statements
}

// The harness records the whole current schema under the 0001 name:
// initMigration carries the 0001 statements plus the batch-5 0002
// statements, so every test database gets the purpose-aware
// email_verifications table while the d1_migrations bookkeeping stays as
// the foundation tests expect. Production applies the real migration files
// in order through wrangler; baseInitMigration and
// emailVerificationPurposeMigration exist so tests can still exercise the
// 0001 -> 0002 upgrade path explicitly.
const baseInitQueries = splitSqlStatements(initSql)

export const baseInitMigration = {
  name: INIT_MIGRATION_NAME,
  queries: baseInitQueries,
}

export const initMigration = {
  name: INIT_MIGRATION_NAME,
  queries: [...baseInitQueries, ...splitSqlStatements(emailVerificationPurposeSql)],
}

export const EMAIL_VERIFICATION_PURPOSE_MIGRATION_NAME = '0002_email_verification_purpose.sql'

export const emailVerificationPurposeMigration = {
  name: EMAIL_VERIFICATION_PURPOSE_MIGRATION_NAME,
  queries: splitSqlStatements(emailVerificationPurposeSql),
}

export async function applyMigrations(db: D1Database = env.DB): Promise<void> {
  await applyD1Migrations(db, [initMigration])
}

export async function listTables(db: D1Database = env.DB): Promise<string[]> {
  const listed = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>()
  return listed.results.map((row) => row.name).filter((name) => !name.startsWith('_cf_'))
}

export async function emptyDatabase(db: D1Database = env.DB): Promise<void> {
  const names = await listTables(db)
  if (names.length === 0) return
  const sql = [
    'PRAGMA foreign_keys = OFF',
    ...names.map((name) => `DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`),
    'PRAGMA foreign_keys = ON',
  ].join(';\n')
  await db.exec(sql)
}
