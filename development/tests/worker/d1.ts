import domainBindingsSql from '../../../migrations/0029_domain_bindings.sql?raw'
import platformRendererSql from '../../../migrations/0034_subscription_platform_renderer.sql?raw'
import contractSql from '../../../docs/unified-subscription-pr6-full-NOT-EXECUTED.sql?raw'
import backfillSql from '../../../migrations/0028_unified_subscription_backfill.sql?raw'
import operationsSql from '../../../migrations/0027_unified_subscription_operations.sql?raw'
import unifiedSql from '../../../migrations/0026_unified_subscription.sql?raw'
import coreGSql from '../../../migrations/0025_core_g.sql?raw'
import subscriptionV2P3Sql from '../../../migrations/0023_subscription_v2_p3.sql?raw'
import compileJobsSql from '../../../migrations/0024_compile_jobs.sql?raw'
import subscriptionV2P2Sql from '../../../migrations/0022_subscription_v2_p2.sql?raw'
import subscriptionV2Sql from '../../../migrations/0021_subscription_v2_p1.sql?raw'
import conversionProfilesSql from '../../../migrations/0020_conversion_profiles.sql?raw'
import catalogSyncSql from '../../../migrations/0019_catalog_sync.sql?raw'
import subscriptionPlansSql from '../../../migrations/0018_subscription_plans.sql?raw'
import sourceKeepOnFailureSql from '../../../migrations/0016_source_keep_on_failure.sql?raw'
import templateEnhancementsSql from '../../../migrations/0017_template_enhancements.sql?raw'
import templatesSql from '../../../migrations/0015_subscription_templates.sql?raw'
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
  'binding_redemption_records',
  'catalog_sync_leases',
  'catalog_sync_runs',
  'compile_job_items',
  'compile_jobs',
  'conversion_bindings',
  'conversion_local_rule_sets',
  'conversion_profile_versions',
  'conversion_profiles',
  'conversion_rule_sources',
  'conversion_rule_version_snapshots',
  'cron_runs',
  'domain_bindings',
  'domain_verification_challenges',
  'domains',
  'email_change_requests',
  'email_verifications',
  'entitlement_plan_policies',
  'entitlement_template_versions',
  'entitlement_templates',
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
  'private_entitlement_templates',
  'rate_limits',
  'redemption_batches',
  'redemption_codes',
  'redemption_records',
  'shares',
  'sources',
  'subscription_creation',
  'subscription_domains',
  'subscription_groups',
  'subscription_nodes',
  'subscription_plan_migration',
  'subscription_platform_settings',
  'subscription_template_bindings',
  'subscription_template_default',
  'subscription_template_origins',
  'subscription_template_versions',
  'subscription_templates',
  'subscriptions',
  'system_settings',
  'ticket_replies',
  'tickets',
  'user_binding_requests',
  'user_entitlements_legacy',
  'user_subscription_access',
  'user_subscription_reminders',
  'user_subscription_shares',
  'user_template_bindings',
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

export const domainBindingsMigration = {
  name: '0029_domain_bindings.sql',
  queries: splitSqlStatements(domainBindingsSql),
}

export const platformRendererMigration = {
  name: '0034_subscription_platform_renderer.sql',
  queries: splitSqlStatements(platformRendererSql),
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

export const templatesMigration = {
  name: '0015_subscription_templates.sql',
  queries: splitSqlStatements(templatesSql),
}

export const templateEnhancementsMigration = {
  name: '0017_template_enhancements.sql',
  queries: splitSqlStatements(templateEnhancementsSql),
}

const triggerPattern = /CREATE TRIGGER [\s\S]*?\nEND;/gu
export const conversionProfilesMigration = {
  name: '0020_conversion_profiles.sql',
  queries: [
    ...splitSqlStatements(conversionProfilesSql.replace(triggerPattern, '')),
    ...(conversionProfilesSql.match(triggerPattern) ?? []),
  ],
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
    templatesMigration,
    { name: '0016_source_keep_on_failure.sql', queries: splitSqlStatements(sourceKeepOnFailureSql) },
    templateEnhancementsMigration,
    { name: '0018_subscription_plans.sql', queries: splitSqlStatements(subscriptionPlansSql) },
    { name: '0019_catalog_sync.sql', queries: splitSqlStatements(catalogSyncSql) },
    conversionProfilesMigration,
    { name: '0021_subscription_v2_p1.sql', queries: splitSqlStatements(subscriptionV2Sql) },
    { name: '0022_subscription_v2_p2.sql', queries: [
      ...splitSqlStatements(subscriptionV2P2Sql.replace(triggerPattern, '')),
      ...(subscriptionV2P2Sql.match(triggerPattern) ?? []),
    ] },
    { name: '0023_subscription_v2_p3.sql', queries: [
      ...splitSqlStatements(subscriptionV2P3Sql.replace(triggerPattern, '')),
      ...(subscriptionV2P3Sql.match(triggerPattern) ?? []),
    ] },
    { name: '0024_compile_jobs.sql', queries: [
      ...splitSqlStatements(compileJobsSql.replace(triggerPattern, '')),
      ...(compileJobsSql.match(triggerPattern) ?? []),
    ] },
    { name: '0025_core_g.sql', queries: coreGSql.trim().split(/;\s*\n(?=(?:ALTER|DROP|CREATE)|$)/u).filter(Boolean) },
  ])
  await applyUnifiedMigration(db)
  await applyD1Migrations(db, [domainBindingsMigration, platformRendererMigration])
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
    'DROP VIEW IF EXISTS all_redemption_records',
    'DROP VIEW IF EXISTS conversion_effective_bindings',
    'DROP VIEW IF EXISTS conversion_profile_catalog',
    'DROP VIEW IF EXISTS conversion_profile_outputs',
    ...names.map((name) => `DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`),
    'PRAGMA foreign_keys = ON',
  ].join(';\n')
  await db.exec(sql)
}

export async function applyUnifiedMigration(db: D1Database = env.DB) {
  await applyD1Migrations(db, [{
    name: '0026_unified_subscription.sql',
    queries: [
      ...splitSqlStatements(unifiedSql.replace(triggerPattern, '')),
      ...(unifiedSql.match(triggerPattern) ?? []),
    ],
  }, { name: '0027_unified_subscription_operations.sql', queries: splitSqlStatements(operationsSql) }])
}

export async function applyBackfillMigration(db: D1Database = env.DB) {
  await applyD1Migrations(db, [{ name: '0028_unified_subscription_backfill.sql', queries: [
    ...splitSqlStatements(backfillSql.replace(triggerPattern, '')),
    ...(backfillSql.match(triggerPattern) ?? []),
  ] }])
}

export async function applyContraction(db: D1Database = env.DB) {
  await applyMigrations(db)
  await applyBackfillMigration(db)
  const flags = [
    'accounts_d1_ready', 'apps_d1_ready', 'catalog_d1_ready', 'delivery_d1_ready',
    'shares_d1_ready', 'unified_subscription_ready', 'unified_subscription_public_ready',
  ]
  await db.batch(flags.map(flag => db.prepare(
    "INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,'true',?)",
  ).bind(flag, new Date().toISOString())))
  // Protect trigger-body semicolons while preserving statement order in the atomic batch.
  const triggers = contractSql.match(triggerPattern) ?? []
  const queries = splitSqlStatements(contractSql.replace(triggerPattern, () => 'PR6_TRIGGER_PLACEHOLDER;'))
    .map(query => query === 'PR6_TRIGGER_PLACEHOLDER' ? triggers.shift()! : query)
  await applyD1Migrations(db, [{ name: 'pr6-full-contraction', queries }])
}
