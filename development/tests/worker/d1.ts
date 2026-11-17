import inviteRegistrationSql from '../../../migrations/0012_invite_registration.sql?raw'
import subscriptionPoolSql from '../../../migrations/0014_subscription_pool.sql?raw'
import stage3Sql from '../../../migrations/0010_stage3_admin.sql?raw'
import entitlementsSql from '../../../migrations/0008_entitlements.sql?raw'
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import initSql from '../../../migrations/0001_init.sql?raw'
import emailVerificationPurposeSql from '../../../migrations/0002_email_verification_purpose.sql?raw'
import sharesFkSql from '../../../migrations/0003_shares_subscription_fk.sql?raw'
import softDeleteSql from '../../../migrations/0004_user_soft_delete.sql?raw'
import registrationSql from '../../../migrations/0005_registration.sql?raw'
import appRefactorSql from '../../../migrations/0006_app_downloads_refactor.sql?raw'
import domainsSql from '../../../migrations/0007_domain_stage.sql?raw'
import ticketsNoticesSql from '../../../migrations/0009_tickets_notices.sql?raw'
import knowledgeBaseSql from '../../../migrations/0011_knowledge_base.sql?raw'

export const INIT_MIGRATION_NAME = '0001_init.sql'
export const SOFT_DELETE_MIGRATION_NAME = '0004_user_soft_delete.sql'

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
  'invite_code_redemptions',
  'invite_codes',
  'kb_articles',
  'kb_categories',
  'mail_broadcasts',
  'mail_templates',
  'migration_runs',
  'node_raw_variants',
  'nodes',
  'notices',
  'panel_domains',
  'plan_groups',
  'plans',
  'rate_limits',
  'shares',
  'sources',
  'subscription_domains',
  'subscription_groups',
  'subscription_platform_settings',
  'subscriptions',
  'system_settings',
  'ticket_replies',
  'tickets',
  'user_entitlements',
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

// Each migration file is applied under its own name, in production order,
// so tests exercise the same d1_migrations bookkeeping wrangler produces.
// baseInitMigration stays as an alias of initMigration so the batch-5
// upgrade-path tests can still build a pre-0002 database and then apply
// emailVerificationPurposeMigration on top of it.
export const initMigration = {
  name: INIT_MIGRATION_NAME,
  queries: splitSqlStatements(initSql),
}

export const baseInitMigration = initMigration

export const EMAIL_VERIFICATION_PURPOSE_MIGRATION_NAME = '0002_email_verification_purpose.sql'

export const emailVerificationPurposeMigration = {
  name: EMAIL_VERIFICATION_PURPOSE_MIGRATION_NAME,
  queries: splitSqlStatements(emailVerificationPurposeSql),
}

export const SHARES_FK_MIGRATION_NAME = '0003_shares_subscription_fk.sql'

export const sharesFkMigration = {
  name: SHARES_FK_MIGRATION_NAME,
  queries: splitSqlStatements(sharesFkSql),
}

export const softDeleteMigration = {
  name: SOFT_DELETE_MIGRATION_NAME,
  queries: splitSqlStatements(softDeleteSql),
}

export const REGISTRATION_MIGRATION_NAME = '0005_registration.sql'

export const registrationMigration = {
  name: REGISTRATION_MIGRATION_NAME,
  queries: splitSqlStatements(registrationSql),
}

export const APP_REFACTOR_MIGRATION_NAME = '0006_app_downloads_refactor.sql'

export const appRefactorMigration = {
  name: APP_REFACTOR_MIGRATION_NAME,
  queries: splitSqlStatements(appRefactorSql),
}

export const DOMAINS_MIGRATION_NAME = '0007_domain_stage.sql'

export const domainsMigration = {
  name: DOMAINS_MIGRATION_NAME,
  queries: splitSqlStatements(domainsSql),
}

export const TICKETS_NOTICES_MIGRATION_NAME = '0009_tickets_notices.sql'

export const ticketsNoticesMigration = {
  name: TICKETS_NOTICES_MIGRATION_NAME,
  queries: splitSqlStatements(ticketsNoticesSql),
}

export const KNOWLEDGE_BASE_MIGRATION_NAME = '0011_knowledge_base.sql'

export const knowledgeBaseMigration = {
  name: KNOWLEDGE_BASE_MIGRATION_NAME,
  queries: splitSqlStatements(knowledgeBaseSql),
}

export async function applyMigrations(db: D1Database = env.DB): Promise<void> {
  await applyD1Migrations(db, [
    initMigration,
    emailVerificationPurposeMigration,
    sharesFkMigration,
    softDeleteMigration,
    registrationMigration,
    appRefactorMigration,
    domainsMigration,
    { name: '0008_entitlements.sql', queries: splitSqlStatements(entitlementsSql) },
    ticketsNoticesMigration,
    { name: '0010_stage3_admin.sql', queries: splitSqlStatements(stage3Sql) },
    knowledgeBaseMigration,
    { name: '0012_invite_registration.sql', queries: splitSqlStatements(inviteRegistrationSql) },
    { name: '0014_subscription_pool.sql', queries: splitSqlStatements(subscriptionPoolSql) },
  ])
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
