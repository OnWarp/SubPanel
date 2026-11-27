import { queryFirst, type AppDatabase } from '../db/db.js'

type Flag = 0 | 1
type Identified = { id: string }

export interface PlanDefinitionRow extends Identified {
  name: string
  description: string
  remark: string | null
  duration_seconds: number | null
  enabled: Flag
  archived_at: string | null
  owner_user_id: string | null
  source_type: 'template' | 'legacy_plan' | null
  source_id: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface PlanNodeGroupRow {
  plan_id: string
  group_id: string
}

export interface UserPlanRow extends Identified {
  user_id: string
  plan_id: string
  starts_at: number
  expires_at: number | null
  status: 'active' | 'paused' | 'revoked'
  source: 'admin' | 'redeem' | 'manual' | 'migration' | 'trial'
  source_id: string | null
  remark: string | null
  created_at: string
  updated_at: string
  version: number
}

export type SubscriptionScope = 'aggregate' | 'package'

export interface SubscriptionTokenRow extends Identified {
  scope: SubscriptionScope
  user_id: string
  user_plan_id: string | null
  token_digest: string
  token_ciphertext: string | null
  revoked_at: string | null
  created_at: string
}

export interface RedeemCodeRow extends Identified {
  code_digest: string
  digest_key_version: string
  tail: string
  plan_id: string
  duration_mode: 'plan_default' | 'fixed' | 'permanent'
  duration_seconds: number | null
  valid_from: number | null
  valid_until: number | null
  max_uses: number
  used_count: number
  per_user_limit: number
  enabled: Flag
  remark: string | null
  batch_id: string | null
}

export interface RedemptionRow extends Identified {
  code_id: string
  user_id: string
  user_plan_id: string | null
  redeemed_at: string
  request_id: string
  issued_subscription_id: string | null
}

export interface LegacySubscriptionRouteRow {
  legacy_token_digest: string
  target_scope: SubscriptionScope
  target_id: string
  revoked_at: string | null
}

export interface PlanPage {
  limit: number
  offset?: number
}

// Table names, columns and predicates come only from the declarations below.
function repository<Row extends Identified>() {
  return <Filter extends string>(table: string, columns: readonly (keyof Row & string)[], filters: Record<Filter, string>) => {
    const fields = columns.join(', ')
    const placeholders = columns.map(() => '?').join(', ')
    function prepareCreate(db: AppDatabase, row: Row): D1PreparedStatement {
      return db.prepare(`INSERT INTO ${table} (${fields}) VALUES (${placeholders})`)
        .bind(...columns.map((column) => row[column]))
    }
    return {
      prepareCreate,
      async create(db: AppDatabase, row: Row): Promise<void> {
        await prepareCreate(db, row).run()
      },
      get(db: AppDatabase, id: string): Promise<Row | null> {
        return queryFirst<Row>(db.prepare(`SELECT ${fields} FROM ${table} WHERE id = ?`).bind(id))
      },
      async list(db: AppDatabase, page: PlanPage, filter?: { by: Filter; id: string }): Promise<Row[]> {
        const { limit, offset = 0 } = page
        if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
          throw new RangeError('Invalid plan repository pagination')
        }
        const where = filter ? `WHERE ${filters[filter.by]}` : ''
        const params = filter ? [filter.id, limit, offset] : [limit, offset]
        const result = await db.prepare(`SELECT ${fields} FROM ${table} ${where} ORDER BY id LIMIT ? OFFSET ?`)
          .bind(...params).all<Row>()
        return result.results
      },
    }
  }
}

export const planDefinitions = repository<PlanDefinitionRow>()('plan_definitions', [
  'id', 'name', 'description', 'remark', 'duration_seconds', 'enabled', 'archived_at', 'owner_user_id',
  'source_type', 'source_id', 'version', 'created_at', 'updated_at',
], { userId: 'owner_user_id = ?', planId: 'id = ?' })

export const userPlans = repository<UserPlanRow>()('user_plans', [
  'id', 'user_id', 'plan_id', 'starts_at', 'expires_at', 'status', 'source', 'source_id',
  'remark', 'created_at', 'updated_at', 'version',
], { userId: 'user_id = ?', planId: 'plan_id = ?' })

export const subscriptionTokens = repository<SubscriptionTokenRow>()('subscription_tokens', [
  'id', 'scope', 'user_id', 'user_plan_id', 'token_digest', 'token_ciphertext', 'revoked_at', 'created_at',
], {
  userId: 'user_id = ?',
  userPlanId: 'user_plan_id = ?',
  planId: 'user_plan_id IN (SELECT id FROM user_plans WHERE plan_id = ?)',
})

export const redeemCodes = repository<RedeemCodeRow>()('redeem_codes', [
  'id', 'code_digest', 'digest_key_version', 'tail', 'plan_id', 'duration_mode', 'duration_seconds',
  'valid_from', 'valid_until', 'max_uses', 'used_count', 'per_user_limit', 'enabled', 'remark', 'batch_id',
], {
  planId: 'plan_id = ?',
  userId: 'id IN (SELECT code_id FROM redemptions WHERE user_id = ?)',
})

export const redemptions = repository<RedemptionRow>()('redemptions', [
  'id', 'code_id', 'user_id', 'user_plan_id', 'redeemed_at', 'request_id', 'issued_subscription_id',
], {
  userId: 'user_id = ?',
  planId: 'code_id IN (SELECT id FROM redeem_codes WHERE plan_id = ?)',
  codeId: 'code_id = ?',
})
