import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import schemaSql from '../../../migrations/0031_plan_schema.sql?raw'
import groupsSql from '../../../migrations/0032_group_metadata.sql?raw'
import backfillSql from '../../../migrations/0033_plan_backfill.sql?raw'
import schemaDown from '../../../migrations/down/0031_plan_schema.down.sql?raw'
import groupsDown from '../../../migrations/down/0032_group_metadata.down.sql?raw'
import backfillDown from '../../../migrations/down/0033_plan_backfill.down.sql?raw'
import seedSql from '../fixtures/plans/production-shape.sql?raw'
import { planDefinitions, redeemCodes, redemptions, subscriptionTokens, userPlans } from '../../../worker/plans/repository.js'
import { applyContraction, splitSqlStatements } from './d1.js'

const db = env.DB
const stamp = '2026-01-01T00:00:00Z'

function run(sql: string) {
  return db.batch(splitSqlStatements(sql).map((statement) => db.prepare(statement)))
}

function scalar<T>(sql: string) {
  return db.prepare(sql).first<T>('value')
}

function count(table: string) {
  return scalar<number>(`SELECT count(*) AS value FROM ${table}`)
}

async function groupColumns() {
  const { results } = await db.prepare('PRAGMA table_info(groups)').all<{ name: string }>()
  return results.map(({ name }) => name)
}

describe('Phase 2 plan data on D1', () => {
  beforeAll(async () => {
    await applyContraction(db)
    await run(seedSql)
    await run(schemaSql)
    await run(groupsSql)
    await run(backfillSql)
  })

  it('maps the production-shaped fixture, replays safely, and preserves source rows through rollback', async () => {
    const expectedCounts = {
      plan_definitions: 7, plan_node_groups: 7, user_plans: 4, subscription_tokens: 1,
      redeem_codes: 1, redemptions: 1, legacy_subscription_routes: 0,
    }
    await run(schemaSql)
    await run(backfillSql)
    for (const [table, expected] of Object.entries(expectedCounts)) {
      expect(await count(table), table).toBe(expected)
    }
    expect(await scalar("SELECT count(*) AS value FROM sqlite_schema WHERE name = 'subscriptions'")).toBe(0)
    expect(await scalar("SELECT count(*) AS value FROM plan_definitions WHERE owner_user_id = 'usr_2'")).toBe(4)
    const privatePlan = await planDefinitions.get(db, 'migration:template:template_3')
    expect(privatePlan).toMatchObject({ owner_user_id: 'usr_2', duration_seconds: 259200, version: 3 })
    expect(JSON.parse(privatePlan!.remark!).direct_node_ids).toEqual(['node_1'])
    expect(await planDefinitions.get(db, 'migration:legacy-plan:legacy_1')).toMatchObject({ duration_seconds: 604800 })
    expect(await userPlans.get(db, 'migration:binding:["usr_2","template_3"]')).toMatchObject({
      starts_at: 1700000000123, expires_at: 1800000000555, version: 4, status: 'active',
    })
    expect(await userPlans.get(db, 'migration:binding:["usr_2","template_4"]')).toMatchObject({ expires_at: null })
    expect(await subscriptionTokens.get(db, 'migration:access:usr_2')).toMatchObject({
      scope: 'aggregate', token_digest: 'A'.repeat(43), token_ciphertext: expect.stringContaining('"AES-GCM"'), revoked_at: null,
    })
    expect(await redeemCodes.get(db, 'migration:code:code_1')).toMatchObject({
      plan_id: 'migration:template:template_1', batch_id: 'batch_1', duration_mode: 'fixed',
      duration_seconds: 2592000, valid_until: 1790000000000, used_count: 1, max_uses: 1,
    })
    expect(await redemptions.get(db, 'migration:legacy-receipt:receipt_1')).toMatchObject({
      issued_subscription_id: 'sub_99', user_plan_id: null,
    })
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    const sourceTables = [
      'plans', 'plan_groups', 'groups', 'entitlement_templates', 'entitlement_template_versions',
      'private_entitlement_templates', 'user_template_bindings', 'user_subscription_access',
      'redemption_batches', 'redemption_codes', 'redemption_records', 'legacy_subscriptions_archive', 'subscription_groups',
    ]
    const readSources = () => Promise.all(sourceTables.map(table => db.prepare(`SELECT * FROM ${table}`).all()))
    const before = (await readSources()).map(({ results }) => results)
    expect(await count('legacy_subscriptions_archive')).toBe(4)
    expect(await count('subscription_groups')).toBe(9)
    await run(backfillDown)
    await run(backfillDown)
    for (const table of Object.keys(expectedCounts)) expect(await count(table), table).toBe(0)
    await run(groupsDown)
    await run(schemaDown)
    await run(schemaDown)
    expect((await readSources()).map(({ results }) => results)).toEqual(before)
    expect(await groupColumns()).toEqual(expect.arrayContaining(['enabled', 'remark']))
    expect(await scalar("SELECT count(*) AS value FROM sqlite_schema WHERE name = 'user_plans_user_status_expiry'")).toBe(0)
    await run(schemaSql)
    await run(backfillSql)
    expect(await count('plan_definitions')).toBe(7)
  })

  it('preserves both binding receipts when one legacy binding was renewed', async () => {
    await run(`
      INSERT INTO user_template_bindings (user_id,template_id,starts_at,expires_at,status,revision,created_at,updated_at)
      VALUES ('usr_2','template_1',1700000000123,1800000000555,'active',1,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
      INSERT INTO redemption_codes (id,batch_id,digest_key_version,code_digest,tail,max_uses,used_count)
      VALUES ('code_2','batch_1','v1','other','EFGH',1,1),('code_3','batch_1','v1','third','IJKL',1,1);
      INSERT INTO binding_redemption_records (id,code_id,user_id,template_id,subscription_name,
        redeemed_at,idempotency_key,replay_verifier)
      VALUES ('receipt_2','code_2','usr_2','template_1','Fixture','2026-01-02T00:00:00Z','earlier','fixture'),
        ('receipt_3','code_3','usr_2','template_1','Fixture','2026-01-03T00:00:00Z','later','fixture');
    `)
    await run(backfillSql)
    expect(await redemptions.get(db, 'migration:binding-receipt:receipt_2')).toMatchObject({ user_plan_id: null })
    expect(await redemptions.get(db, 'migration:binding-receipt:receipt_3')).toMatchObject({
      user_plan_id: 'migration:binding:["usr_2","template_1"]',
    })
  })

  it('enforces checks and foreign keys while supporting repeat instances and receipts', async () => {
    const legacyPlan = (await planDefinitions.get(db, 'migration:legacy-plan:legacy_1'))!
    const plan = { ...legacyPlan, id: 'test-plan', source_type: null, source_id: null }
    await expect(planDefinitions.create(db, { ...plan, duration_seconds: 0 })).rejects.toThrow(/CHECK/)
    await planDefinitions.create(db, { ...plan, duration_seconds: null, owner_user_id: 'usr_1' })
    expect(await planDefinitions.list(db, { limit: 1 }, { by: 'userId', id: 'usr_1' })).toMatchObject([{ id: plan.id }])

    const instance = {
      id: 'instance-1', user_id: 'usr_1', plan_id: plan.id, starts_at: 100, expires_at: 200,
      status: 'active', source: 'redeem', source_id: null, remark: null, version: 1,
      created_at: stamp, updated_at: stamp,
    } as const
    await expect(userPlans.create(db, { ...instance, expires_at: 100 })).rejects.toThrow(/CHECK/)
    await userPlans.create(db, instance)
    await userPlans.create(db, { ...instance, id: 'instance-2' })
    const page = await userPlans.list(db, { limit: 1, offset: 1 }, { by: 'planId', id: plan.id })
    expect(page.map(({ id }) => id)).toEqual(['instance-2'])
    expect(await userPlans.list(db, { limit: 10 }, { by: 'userId', id: 'usr_1' })).toHaveLength(2)

    const token = {
      id: 'token-1', scope: 'aggregate', user_id: 'usr_1', user_plan_id: null,
      token_digest: 'B'.repeat(43), token_ciphertext: null, revoked_at: null, created_at: stamp,
    } as const
    await subscriptionTokens.create(db, token)
    const replacement = { ...token, id: 'token-2', token_digest: 'C'.repeat(43) }
    await expect(subscriptionTokens.create(db, replacement)).rejects.toThrow(/UNIQUE/)
    await db.prepare("UPDATE subscription_tokens SET revoked_at = ? WHERE id = 'token-1'").bind(stamp).run()
    await subscriptionTokens.create(db, replacement)
    const packageToken = { ...token, id: 'package-1', token_digest: 'D'.repeat(43), scope: 'package', user_plan_id: instance.id } as const
    await expect(subscriptionTokens.create(db, { ...packageToken, user_id: 'usr_2' })).rejects.toThrow(/FOREIGN KEY/)
    await subscriptionTokens.create(db, packageToken)
    await expect(subscriptionTokens.create(db, { ...packageToken, id: 'package-2', token_digest: 'E'.repeat(43) })).rejects.toThrow(/UNIQUE/)
    expect(await subscriptionTokens.list(db, { limit: 10 }, { by: 'planId', id: plan.id })).toEqual([packageToken])

    const migratedCode = (await redeemCodes.get(db, 'migration:code:code_1'))!
    const code = {
      ...migratedCode, id: 'new-code', plan_id: plan.id, batch_id: null, code_digest: 'new-digest',
      max_uses: 2, used_count: 0, per_user_limit: 2,
    }
    await expect(redeemCodes.create(db, { ...code, code_digest: migratedCode.code_digest })).rejects.toThrow(/UNIQUE/)
    await expect(redeemCodes.create(db, { ...code, used_count: 3 })).rejects.toThrow(/CHECK/)
    await redeemCodes.create(db, code)

    const receipt = {
      id: 'new-receipt', code_id: code.id, user_id: 'usr_1', user_plan_id: instance.id,
      redeemed_at: stamp, request_id: 'request-1', issued_subscription_id: null,
    }
    await redemptions.create(db, receipt)
    await expect(redemptions.create(db, { ...receipt, id: 'dup-instance', request_id: 'request-2' })).rejects.toThrow(/UNIQUE/)
    const second = { ...receipt, id: 'second-receipt', user_plan_id: 'instance-2' }
    await expect(redemptions.create(db, second)).rejects.toThrow(/UNIQUE/)
    await redemptions.create(db, { ...second, request_id: 'request-2' })
    expect(await redemptions.list(db, { limit: 10 }, { by: 'userId', id: 'usr_1' })).toHaveLength(2)
    expect(await redeemCodes.list(db, { limit: 10 }, { by: 'userId', id: 'usr_1' })).toEqual([code])

    await expect(db.prepare('DELETE FROM plan_definitions WHERE id = ?').bind(plan.id).run()).rejects.toThrow(/FOREIGN KEY/)
    await db.prepare("INSERT INTO plan_node_groups VALUES (?, 'grp_7')").bind(plan.id).run()
    await db.prepare("DELETE FROM groups WHERE id = 'grp_7'").run()
    expect(await scalar("SELECT count(*) AS value FROM plan_node_groups WHERE group_id = 'grp_7'")).toBe(0)
  })
})
