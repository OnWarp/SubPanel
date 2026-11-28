import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { requireAuth } from '../accounts/auth.js'
import { subscriptionNotFound } from '../delivery/user-access.js'
import { DomainService } from '../domains/domain-service.js'
import { readJson } from '../platform/http.js'
import { apiError } from '../platform/api-error.js'
import { EntitlementNotFound, EntitlementResolver, instanceDisplayStatus, instanceStatuses, listInstances, planUserEnabled, readPlanUser } from './entitlements.js'
import { assignPlan, changeToken, createDefinition, definitionDetail, duplicateDefinition, listActiveTokens, listDefinitions,
  mutateInstance, readOwnedInstance, updateDefinition } from './service.js'

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
  planId: id, startsAt: timestamp.optional(), remark: remark.optional(),
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

export const adminPhase3Routes = new Hono<AppEnv>()
const definitions = '/plan-definitions'
adminPhase3Routes.get(definitions, async c => {
  const page = parsePage(definitionFilters, c.req.query())
  return c.json({ plans: await listDefinitions(c.env.DB, page) })
})
adminPhase3Routes.post(definitions, async c =>
  c.json({ plan: await createDefinition(c.env.DB, await readJson(c, createInput), c.get('principal').id) }, 201))
adminPhase3Routes.get(`${definitions}/:id`, async c =>
  c.json({ plan: await definitionDetail(c.env.DB, c.req.param('id')) }))
adminPhase3Routes.patch(`${definitions}/:id`, async c => {
  const { version: expected, ...input } = await readJson(c, editInput)
  return c.json({ plan: await updateDefinition(c.env.DB, c.req.param('id'), expected, input, c.get('principal').id) })
})
adminPhase3Routes.delete(`${definitions}/:id`, async c => {
  const input = await readJson(c, versionInput)
  await updateDefinition(c.env.DB, c.req.param('id'), input.version, {}, c.get('principal').id, true)
  return c.body(null, 204)
})
adminPhase3Routes.post(`${definitions}/:id/duplicate`, async c =>
  c.json({ plan: await duplicateDefinition(c.env.DB, c.req.param('id'), c.get('principal').id) }, 201))
adminPhase3Routes.get(`${definitions}/:id/users`, async c => {
  const page = parsePage(instanceFilters, c.req.query())
  const plan = await definitionDetail(c.env.DB, c.req.param('id'))
  return c.json({ instances: await listInstances(c.env.DB, { planId: plan.id }, page) })
})

adminPhase3Routes.get('/users/:id/plans', async c => {
  const page = parsePage(instanceFilters, c.req.query())
  const user = await readPlanUser(c.env.DB, c.req.param('id'))
  if (!user || user.deleted_at !== null) throw subscriptionNotFound()
  return c.json({ instances: await listInstances(c.env.DB, { userId: user.id }, page) })
})
adminPhase3Routes.post('/users/:id/plans', async c => {
  const { planId, ...input } = await readJson(c, assignmentInput)
  return c.json(await assignPlan(c.env, c.req.param('id'), planId, input, c.get('principal').id), 201)
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
adminPhase3Routes.post(`${instance}/reset-token`, async c => {
  const row = await readOwnedInstance(c.env.DB, c.req.param('id'))
  if (!row) throw subscriptionNotFound()
  const { raw } = await changeToken(c.env, row.user_id, row.id, c.get('principal').id, 'reset')
  return c.json({ token: raw })
})
adminPhase3Routes.post('/users/:id/reset-aggregate-token', async c => {
  const { raw } = await changeToken(c.env, c.req.param('id'), null, c.get('principal').id, 'reset')
  return c.json({ token: raw })
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
userPhase3Routes.get('/plans', async c => {
  const page = parsePage(instanceFilters, c.req.query())
  const user = await readPlanUser(c.env.DB, c.get('principal').id)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  const now = Date.now()
  const [instances, { nodeCounts }] = await Promise.all([
    listInstances(c.env.DB, { userId: user.id }, page, now), resolveForApi(c.env.DB, user, null, now),
  ])
  return c.json({ plans: instances.map(row => ({
    id: row.id, planId: row.plan_id, name: row.name, status: instanceDisplayStatus(row, now),
    startsAt: row.starts_at, expiresAt: row.expires_at, source: row.source, nodeCount: nodeCounts.get(row.id) ?? 0,
  })) })
})
userPhase3Routes.get('/subscriptions', async c => {
  const page = parsePage(instanceFilters, c.req.query())
  const user = await readPlanUser(c.env.DB, c.get('principal').id)
  if (!planUserEnabled(user)) throw subscriptionNotFound()
  const [instances, { nodes, nodeCounts }, origin, tokens] = await Promise.all([
    listInstances(c.env.DB, { userId: user.id }, page),
    resolveForApi(c.env.DB, user, null, Date.now()), new DomainService(c.env.DB).getOrigin('subscription'),
    listActiveTokens(c.env.DB, user.id),
  ])
  const links = new Map(tokens.map(token => [token.user_plan_id, token.token_ciphertext !== null]))
  const masked = origin ? `${origin}/s/••••••••` : null
  return c.json({
    aggregate: { subscriptionUrl: masked, issued: links.has(null), copyable: links.get(null) ?? true, nodeCount: nodes.length },
    packages: instances.filter(row => row.status !== 'revoked').map(row => ({
      instanceId: row.id, subscriptionUrl: masked, issued: links.has(row.id), copyable: links.get(row.id) ?? true, nodeCount: nodeCounts.get(row.id) ?? 0,
    })),
  })
})
userPhase3Routes.post('/subscriptions/copy', async c => {
  const { instanceId } = await readJson(c, z.strictObject({ instanceId: id.nullable().default(null) }))
  const userId = c.get('principal').id
  const { raw } = await changeToken(c.env, userId, instanceId, userId, 'copy')
  const subscriptionUrl = await new DomainService(c.env.DB).buildUnifiedSubscriptionUrl(raw)
  return c.json({ subscriptionUrl })
})
