import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { requireAuth } from '../accounts/auth.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { DomainService } from '../domains/domain-service.js'
import { readJson } from '../platform/http.js'
import { apiError } from '../platform/api-error.js'
import { EntitlementNotFound, EntitlementResolver, instanceDisplayStatus, instanceStatuses, listInstances, planUserEnabled, readPlanUser } from './entitlements.js'
import { archiveRedeemCode, generateRedeemCodes, generateRedeemInput, instanceView, listCodeRedemptions, listRedeemCodes,
  redeemForUser, updateRedeemCode, updateRedeemInput, type RedeemedGrant } from './redeem.js'
import { listMyPlans, planFilters, planListItem, planNodeGroupCounts, readMyPlanDetail, readOverview, readPlanPage, readPlanSummary, type PlanFilter } from './me.js'
import { assignPlan, changeToken, createDefinition, definitionDetail, duplicateDefinition, listActiveTokens,
  mutateInstance, nodeCountsForPlans, previewDefinitionGroups, readOwnedInstance, updateDefinition, listDefinitions } from './service.js'

const id = z.string().min(1).max(512)
const version = z.number().int().positive()
const timestamp = z.number().int()
const seconds = z.number().int().positive()
const remark = z.string().max(2000).nullable()
const fields = z.strictObject({
  name: z.string().trim().min(1).max(200), description: z.string().max(2000),
  durationSeconds: seconds.nullable(), enabled: z.boolean(), remark, nodeGroupIds: z.array(id).max(1000),
})
const createInput = fields.extend({
  description: fields.shape.description.default(''), enabled: z.boolean().default(true), remark: remark.default(null),
})
const editInput = fields.partial().extend({ version })
const versionInput = z.strictObject({ version })
const instanceEditInput = z.strictObject({
  version, startsAt: timestamp.optional(), expiresAt: timestamp.nullable().optional(), remark: remark.optional(),
})
const assignment = {
  planId: id, startsAt: timestamp.optional(), remark: remark.optional(), idempotencyKey: z.uuid().optional(),
}
const assignmentInput = z.union([
  z.strictObject({ ...assignment, durationMode: z.enum(['inherit', 'permanent']) }),
  z.strictObject({ ...assignment, durationMode: z.literal('custom'), expiresAt: timestamp }),
  z.strictObject({ ...assignment, durationMode: z.literal('custom'), durationSeconds: seconds }),
])
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
})
const instanceFilters = pagination.extend({ status: z.enum(instanceStatuses).optional() })
const definitionFilters = pagination.extend({ status: z.enum(['enabled', 'disabled', 'archived']).optional() })

function parsePage<T extends z.ZodType>(schema: T, query: Record<string, string>): z.output<T> {
  const result = schema.safeParse(query)
  if (!result.success) throw apiError(400, 'INVALID_INPUT', '分页参数无效')
  return result.data
}

const redeemCodeFilters = pagination.extend({
  planId: id.optional(),
  status: z.enum(['active', 'disabled', 'expired', 'exhausted']).optional(),
})
const previewInput = z.strictObject({ nodeGroupIds: z.array(id).max(1000) })

export function isDefinitionCollectionQuery(query: Record<string, string | undefined>) {
  return query.resource === 'definition' || query.limit !== undefined || query.offset !== undefined
    || query.search !== undefined || query.status !== undefined
}

export async function listDefinitionsResponse(c: Context<AppEnv>) {
  const page = parsePage(definitionFilters, c.req.query())
  return c.json({ plans: await listDefinitions(c.env.DB, page) })
}

export async function createDefinitionResponse(c: Context<AppEnv>, body: unknown) {
  const parsed = createInput.safeParse(body)
  if (!parsed.success) throw apiError(400, 'INVALID_INPUT', '套餐参数无效')
  return c.json({ plan: await createDefinition(c.env.DB, parsed.data, c.get('principal').id) }, 201)
}

export async function archiveDefinitionResponse(c: Context<AppEnv>, planId: string, body: unknown) {
  const parsed = versionInput.safeParse(body)
  if (!parsed.success) throw apiError(400, 'INVALID_INPUT', '缺少套餐版本')
  await updateDefinition(c.env.DB, planId, parsed.data.version, {}, c.get('principal').id, true)
  return c.body(null, 204)
}

export const adminPhase3Routes = new Hono<AppEnv>()

function mountPlanCollection(prefix: '/plan-definitions' | '/plans') {
  adminPhase3Routes.post(`${prefix}/preview`, async c =>
    c.json(await previewDefinitionGroups(c.env.DB, (await readJson(c, previewInput)).nodeGroupIds)))
  adminPhase3Routes.get(`${prefix}/:id`, async c =>
    c.json({ plan: await definitionDetail(c.env.DB, c.req.param('id')) }))
  adminPhase3Routes.patch(`${prefix}/:id`, async c => {
    const { version: expected, ...input } = await readJson(c, editInput)
    return c.json({ plan: await updateDefinition(c.env.DB, c.req.param('id'), expected, input, c.get('principal').id) })
  })
  adminPhase3Routes.post(`${prefix}/:id/duplicate`, async c =>
    c.json({ plan: await duplicateDefinition(c.env.DB, c.req.param('id'), c.get('principal').id) }, 201))
  adminPhase3Routes.get(`${prefix}/:id/users`, async c => {
    const page = parsePage(instanceFilters, c.req.query())
    const plan = await definitionDetail(c.env.DB, c.req.param('id'))
    const instances = await listInstances(c.env.DB, { planId: plan.id }, page)
    const userIds = [...new Set(instances.map(row => row.user_id))]
    const names = userIds.length
      ? await c.env.DB.prepare('SELECT id, username FROM users WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(userIds)).all<{ id: string; username: string }>()
      : { results: [] as { id: string; username: string }[] }
    const usernames = new Map(names.results.map(user => [user.id, user.username]))
    return c.json({ instances: instances.map(row => ({ ...row, nodeCount: plan.nodeCount, username: usernames.get(row.user_id) ?? row.user_id })), plan: {
      id: plan.id, name: plan.name, nodeCount: plan.nodeCount, instanceCount: plan.instanceCount, userCount: plan.userCount, stats: plan.stats,
    } })
  })
  adminPhase3Routes.get(`${prefix}/:id/preview`, async c => {
    const plan = await definitionDetail(c.env.DB, c.req.param('id'))
    return c.json({ nodeCount: plan.nodeCount, nodeGroups: plan.nodeGroups, emptyGroupIds: plan.nodeGroups.filter(group => group.empty).map(group => group.id) })
  })
}

adminPhase3Routes.get('/plan-definitions', listDefinitionsResponse)
adminPhase3Routes.post('/plan-definitions', async c =>
  c.json({ plan: await createDefinition(c.env.DB, await readJson(c, createInput), c.get('principal').id) }, 201))
adminPhase3Routes.delete('/plan-definitions/:id', async c => archiveDefinitionResponse(c, c.req.param('id'), await readJson(c, versionInput)))
mountPlanCollection('/plan-definitions')
// /plans collection GET, POST and DELETE stay on the legacy catalog router and dispatch here when the request is a definition.
mountPlanCollection('/plans')

adminPhase3Routes.get('/users/:id/plans', async c => {
  const page = parsePage(instanceFilters, c.req.query())
  const user = await readPlanUser(c.env.DB, c.req.param('id'))
  if (!user || user.deleted_at !== null) throw subscriptionNotFound()
  const now = Date.now()
  const instances = await listInstances(c.env.DB, { userId: user.id }, page, now)
  const nodeCounts = await nodeCountsForPlans(c.env.DB, instances.map(row => row.plan_id))
  const tokens = await listActiveTokens(c.env.DB, user.id)
  const links = new Map(tokens.map(token => [token.user_plan_id, token.token_ciphertext !== null]))
  const origin = await new DomainService(c.env.DB).getOrigin('subscription')
  const masked = origin ? `${origin}/s/••••••••` : null
  let aggregateNodes = 0
  if (planUserEnabled(user)) {
    aggregateNodes = (await resolveForApi(c.env.DB, user, null, now)).nodes.length
  }
  return c.json({
    aggregate: { subscriptionUrl: masked, issued: links.has(null), copyable: links.get(null) ?? true, nodeCount: aggregateNodes },
    instances: instances.map(row => ({ ...row, nodeCount: nodeCounts.get(row.plan_id) ?? 0, copyable: links.get(row.id) ?? true })),
  })
})
adminPhase3Routes.post('/users/:id/plans', async c => {
  const { planId, ...input } = await readJson(c, assignmentInput)
  const result = await assignPlan(c.env, c.req.param('id'), planId, input, c.get('principal').id)
  return c.json(result, result.replayed ? 200 : 201)
})
const instance = '/user-plans/:id'
adminPhase3Routes.patch(instance, async c => {
  const { version: expected, ...input } = await readJson(c, instanceEditInput)
  return c.json({ instance: await mutateInstance(c.env.DB, c.req.param('id'), { action: 'patch', ...input },
    c.get('principal').id, expected) })
})
adminPhase3Routes.post(`${instance}/renew`, async c => {
  const input = await readJson(c, z.strictObject({ durationSeconds: seconds, version: version.optional() }))
  return c.json({ instance: await mutateInstance(c.env.DB, c.req.param('id'),
    { action: 'renew', durationSeconds: input.durationSeconds }, c.get('principal').id, input.version) })
})
for (const action of ['pause', 'resume'] as const) {
  adminPhase3Routes.post(`${instance}/${action}`, async c =>
    c.json({ instance: await mutateInstance(c.env.DB, c.req.param('id'), { action }, c.get('principal').id) }))
}
adminPhase3Routes.delete(instance, async c => {
  await mutateInstance(c.env.DB, c.req.param('id'), { action: 'revoke' }, c.get('principal').id)
  return c.body(null, 204)
})
async function subscriptionLink(c: Context<AppEnv>, userId: string, instanceId: string | null, mode: 'copy' | 'reset') {
  const { raw } = await changeToken(c.env, userId, instanceId, c.get('principal').id, mode)
  const subscriptionUrl = await new DomainService(c.env.DB).buildUnifiedSubscriptionUrl(raw)
  return c.json({ token: raw, subscriptionUrl })
}
adminPhase3Routes.post(`${instance}/reset-token`, async c => {
  const row = await readOwnedInstance(c.env.DB, c.req.param('id'))
  if (!row) throw subscriptionNotFound()
  return subscriptionLink(c, row.user_id, row.id, 'reset')
})
adminPhase3Routes.post(`${instance}/subscription-link`, async c => {
  const row = await readOwnedInstance(c.env.DB, c.req.param('id'))
  if (!row) throw subscriptionNotFound()
  return subscriptionLink(c, row.user_id, row.id, 'copy')
})
adminPhase3Routes.post('/users/:id/reset-aggregate-token', async c => subscriptionLink(c, c.req.param('id'), null, 'reset'))
adminPhase3Routes.post('/users/:id/aggregate-subscription-link', async c => subscriptionLink(c, c.req.param('id'), null, 'copy'))
adminPhase3Routes.get('/redeem-codes', async c => {
  const page = parsePage(redeemCodeFilters, c.req.query())
  return c.json({ codes: await listRedeemCodes(c.env.DB, page) })
})
adminPhase3Routes.post('/redeem-codes', async c =>
  c.json(await generateRedeemCodes(c.env, c.get('principal').id, await readJson(c, generateRedeemInput)), 201))
adminPhase3Routes.patch('/redeem-codes/:id', async c =>
  c.json({ code: await updateRedeemCode(c.env.DB, c.req.param('id'), await readJson(c, updateRedeemInput), c.get('principal').id) }))
adminPhase3Routes.delete('/redeem-codes/:id', async c => {
  const result = await archiveRedeemCode(c.env.DB, c.req.param('id'), c.get('principal').id)
  return result.archived ? c.json(result) : c.body(null, 204)
})
adminPhase3Routes.get('/redeem-codes/:id/redemptions', async c => {
  const page = parsePage(pagination, c.req.query())
  return c.json({ redemptions: await listCodeRedemptions(c.env.DB, c.req.param('id'), page) })
})

adminPhase3Routes.get(`${instance}/preview`, async c => {
  const row = await readOwnedInstance(c.env.DB, c.req.param('id'))
  if (!row) throw subscriptionNotFound()
  const user = await readPlanUser(c.env.DB, row.user_id)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  const { nodes } = await resolveForApi(c.env.DB, user, row.id, Date.now())
  return c.json({ nodeCount: nodes.length, nodes: nodes.map(({ id, displayName, protocol }) => ({ id, displayName, protocol })) })
})

export async function resolveForApi(db: D1Database, user: NonNullable<Awaited<ReturnType<typeof readPlanUser>>>,
  instanceId: string | null, now: number) {
  try {
    return await new EntitlementResolver(db).resolve(user, instanceId, now)
  } catch (error) {
    if (error instanceof EntitlementNotFound) throw subscriptionNotFound()
    throw error
  }
}

export const userPhase3Routes = new Hono<AppEnv>()
userPhase3Routes.use('*', requireAuth, async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})

const planListQuery = z.object({
  status: z.enum(planFilters).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).max(64).optional(),
  search: z.string().trim().max(200).optional(),
})

function parsePlanList(query: Record<string, string>): { status: PlanFilter; limit: number; offset: number; search?: string } {
  const parsed = planListQuery.safeParse(query)
  if (!parsed.success) throw apiError(400, 'INVALID_INPUT', '套餐列表参数无效')
  const { offset } = readPlanPage(parsed.data)
  return { status: parsed.data.status, limit: parsed.data.limit, offset, search: parsed.data.search || undefined }
}

userPhase3Routes.get('/overview', async c =>
  c.json(await readOverview(c.env, c.get('principal').id)))

userPhase3Routes.get('/plans', async c => {
  const user = await readPlanUser(c.env.DB, c.get('principal').id)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  const page = parsePlanList(c.req.query())
  const now = Date.now()
  const [{ rows, nextCursor }, summary] = await Promise.all([
    listMyPlans(c.env.DB, user.id, page, now),
    readPlanSummary(c.env.DB, user.id, now),
  ])
  return c.json({ items: rows.map(planListItem), nextCursor, summary, serverTime: new Date(now).toISOString() })
})

userPhase3Routes.get('/plans/:instanceId', async c => {
  const user = await readPlanUser(c.env.DB, c.get('principal').id)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  return c.json({ plan: await readMyPlanDetail(c.env.DB, user.id, c.req.param('instanceId')) })
})

userPhase3Routes.get('/subscriptions', async c => {
  const page = parsePage(instanceFilters, c.req.query())
  const user = await readPlanUser(c.env.DB, c.get('principal').id)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  const now = Date.now()
  const [instances, { nodes, nodeCounts }, summary, origin, tokens, groupCounts] = await Promise.all([
    listInstances(c.env.DB, { userId: user.id }, page, now),
    resolveForApi(c.env.DB, user, null, now), readPlanSummary(c.env.DB, user.id, now),
    new DomainService(c.env.DB).getOrigin('subscription'), listActiveTokens(c.env.DB, user.id),
    planNodeGroupCounts(c.env.DB, user.id),
  ])
  const links = new Map(tokens.map(token => [token.user_plan_id, token.token_ciphertext !== null]))
  const masked = origin ? `${origin}/s/••••••••` : null
  return c.json({
    plans: summary,
    aggregate: {
      subscriptionUrl: masked,
      issued: links.has(null),
      copyable: links.get(null) ?? true,
      nodeCount: nodes.length,
      hasAvailableNodes: nodes.length > 0,
    },
    packages: instances.filter(row => row.status !== 'revoked').map(row => ({
      instanceId: row.id,
      planId: row.plan_id,
      name: row.name,
      status: instanceDisplayStatus(row, now),
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      nodeGroupCount: groupCounts.get(row.id) ?? 0,
      subscriptionUrl: masked,
      issued: links.has(row.id),
      copyable: links.get(row.id) ?? true,
      nodeCount: nodeCounts.get(row.id) ?? 0,
    })),
  })
})
const redeemBody = z.strictObject({
  code: z.string().min(1).max(100),
  idempotencyKey: z.uuid().optional(),
  userId: z.string().min(1).max(100).optional(),
})

function idempotencyKey(header: string | undefined, body: string | undefined) {
  const trimmed = header?.trim()
  if (trimmed && body && trimmed !== body) throw apiError(409, 'CONFLICT', '幂等键不一致')
  const key = body ?? trimmed
  if (!key || !z.uuid().safeParse(key).success) throw apiError(400, 'INVALID_INPUT', '缺少有效幂等键')
  return key
}

async function redeemPayload(c: Context<AppEnv>, grant: RedeemedGrant) {
  const user = await readPlanUser(c.env.DB, c.get('principal').id)
  const nodeCount = planUserEnabled(user)
    ? (await resolveForApi(c.env.DB, user, grant.instance.id, Date.now())).nodeCounts.get(grant.instance.id) ?? 0
    : 0
  return instanceView(grant, nodeCount)
}

async function redeemHandler(c: Context<AppEnv>) {
  const body = await readJson(c, redeemBody)
  const principal = c.get('principal')
  if (body.userId && body.userId !== principal.id) throw apiError(403, 'FORBIDDEN', '无权为其他用户兑换')
  const grant = await redeemForUser(c.env, principal.id, body.code, idempotencyKey(c.req.header('Idempotency-Key'), body.idempotencyKey),
    c.req.header('cf-connecting-ip'), principal.sessionVersion)
  return c.json(await redeemPayload(c, grant), grant.replayed ? 200 : 201)
}

// `/plans/redeem` is the Phase 6 alias of the Phase 4 `/redeem`. Both call the
// same redemption service; neither can consume a code the other would not.
userPhase3Routes.post('/redeem', redeemHandler)
userPhase3Routes.post('/plans/redeem', redeemHandler)

userPhase3Routes.post('/subscriptions/copy', async c => {
  const { instanceId } = await readJson(c, z.strictObject({ instanceId: id.nullable().default(null) }))
  const userId = c.get('principal').id
  const { raw } = await changeToken(c.env, userId, instanceId, userId, 'copy')
  const subscriptionUrl = await new DomainService(c.env.DB).buildUnifiedSubscriptionUrl(raw)
  return c.json({ subscriptionUrl })
})
