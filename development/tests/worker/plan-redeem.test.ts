import { readCatalog } from '../../../worker/catalog/repository'
import { windowStartFor } from '../../../worker/accounts/rate-limit'
import { app } from '../../../worker/app'
import { toBase64Url } from '../../../worker/platform/crypto'
import { EntitlementResolver, readPlanUser } from '../../../worker/plans/entitlements'
import { findRedeemCode, generateRedeemCodes, generateRedeemInput, listCodeRedemptions, listRedeemCodes, redeemForUser, redeemStatements } from '../../../worker/plans/redeem'
import { assignPlan, createDefinition, updateDefinition } from '../../../worker/plans/service'
import { normalizeCode } from '../../../shared/redemption-code'
import schema from '../../../migrations/0031_plan_schema.sql?raw'
import schemaDown from '../../../migrations/down/0031_plan_schema.down.sql?raw'
import groups from '../../../migrations/0032_group_metadata.sql?raw'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { splitSqlStatements } from './d1'
import { createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

const db = env.DB
const actor = 'usr_1'
const password = 'a synthetic test password'
let bindings: Env
let adminCookie: string
let member: { id: string; cookie: string }
let other: { id: string; cookie: string }
let groupIds: string[]
let nodeIds: string[]

const run = (sql: string) => db.batch(splitSqlStatements(sql).map(statement => db.prepare(statement)))
const call = (path: string, cookie: string, body?: object, method = 'POST') => {
  const init = body === undefined
    ? withCookie(cookie, { method, headers: { origin: TEST_ORIGIN } })
    : jsonRequest(body, withCookie(cookie, { method }))
  return app.fetch(new Request(TEST_ORIGIN + path, init), bindings)
}
const counts = async (codeId: string) => ({
  used: await db.prepare('SELECT used_count AS count FROM redeem_codes WHERE id=?').bind(codeId).first<number>('count'),
  plans: await db.prepare('SELECT count(*) AS count FROM user_plans').first<number>('count'),
  redemptions: await db.prepare('SELECT count(*) AS count FROM redemptions').first<number>('count'),
  tokens: await db.prepare("SELECT count(*) AS count FROM subscription_tokens WHERE scope='package'").first<number>('count'),
})
const issue = async (planId: string, overrides: Record<string, unknown> = {}) => {
  const created = await generateRedeemCodes(bindings, actor, generateRedeemInput.parse({ planId, ...overrides }))
  return { ...created.codes[0], batchId: created.batchId }
}
const redeem = (code: string, userId = member.id, requestId = crypto.randomUUID()) =>
  redeemForUser(bindings, userId, code, requestId, undefined, 0)
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
    return ''
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : ''
  }
}

beforeEach(async () => {
  await run(schemaDown)
  await setupContractedAdmin()
  await run(schema)
  const columns = await db.prepare('PRAGMA table_info(groups)').all<{ name: string }>()
  if (!columns.results.some(column => column.name === 'enabled')) await run(groups)
  bindings = { ...env, REDEMPTION_HMAC_KEYS: JSON.stringify({ active: 'v1', keys: { v1: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) } }) }
  const created = await (await createFixtureAccount('member', password)).json<{ user: { id: string } }>()
  const second = await (await createFixtureAccount('other', password)).json<{ user: { id: string } }>()
  adminCookie = await login()
  member = { id: created.user.id, cookie: await login('member', password) }
  other = { id: second.user.id, cookie: await login('other', password) }
  const admin = (path: string, body: unknown) => call(`/api/admin${path}`, adminCookie, body)
  const credentials = btoa('aes-128-gcm:fixture')
  const source = await admin('/catalog/sources', {
    name: 'Fixture source', type: 'manual',
    content: `ss://${credentials}@one.test:8388#Same\nss://${credentials}@two.test:8388#Second`,
  })
  expect(source.status).toBe(201)
  const catalog = await readCatalog(env)
  nodeIds = catalog.nodes.map(node => node.id)
  groupIds = []
  for (const nodeId of nodeIds) {
    const response = await admin('/catalog/groups', {
      name: nodeId, sourceIds: [], includedNodeIds: [nodeId], excludedNodeIds: [], nodeOrder: [],
    })
    expect(response.status).toBe(201)
    groupIds.push((await response.json<{ group: { id: string } }>()).group.id)
  }
})

async function plan(durationSeconds: number | null = 30 * 86400, nodeGroupIds = [groupIds[0]]) {
  return createDefinition(db, {
    nodeGroupIds, name: 'Redeem plan', description: '', enabled: true, remark: null, durationSeconds,
  }, actor)
}

it('creates a new instance per successful redeem and replays the same idempotency key once', async () => {
  const definition = await plan()
  const code = await issue(definition.id, { maxUses: 2, perUserLimit: 2 })
  const key = crypto.randomUUID()
  const first = await redeem(code.code, member.id, key)
  const replay = await redeem(code.code, member.id, key)
  const second = await redeem(code.code)
  const assigned = await assignPlan(env, member.id, definition.id, { durationMode: 'inherit' }, actor)
  expect(replay).toMatchObject({ replayed: true, redemptionId: first.redemptionId, token: first.token, instance: { id: first.instance.id } })
  expect(second.instance.id).not.toBe(first.instance.id)
  expect(second.replayed).toBe(false)
  expect(assigned.instance.id).not.toBe(first.instance.id)
  expect(assigned.instance.source).toBe('admin')
  expect(first.instance.source).toBe('redeem')
  const stored = await db.prepare('SELECT expires_at FROM user_plans WHERE id=?').bind(first.instance.id).first<number>('expires_at')
  expect(stored).toBe(first.instance.expires_at)
  expect(await counts(code.id)).toMatchObject({ used: 2, plans: 3, redemptions: 2, tokens: 3 })
  expect(await db.prepare("SELECT count(*) AS count FROM subscription_tokens WHERE scope='aggregate'").first<number>('count')).toBe(0)
  const otherCode = await issue(definition.id)
  expect(await failure(redeem(otherCode.code, member.id, key))).toBe('CONFLICT')
  expect(await counts(otherCode.id)).toMatchObject({ used: 0, redemptions: 2 })
  const httpReplay = await call('/api/me/redeem', member.cookie, { code: code.code, idempotencyKey: key })
  expect(httpReplay.status).toBe(200)
  expect(await httpReplay.json()).toMatchObject({ replayed: true, instance: { id: first.instance.id, source: 'redeem' } })
  const audit = await db.prepare("SELECT action, detail FROM audit_logs WHERE action LIKE 'plan.%'").all()
  const text = JSON.stringify(audit.results)
  expect(text).not.toContain(normalizeCode(code.code))
  expect(text).not.toContain(first.token)
})

it('lets only one concurrent redeem consume the last use and rolls a failed write all the way back', async () => {
  const definition = await plan(60)
  const code = await issue(definition.id, { maxUses: 1 })
  const results = await Promise.all(Array.from({ length: 8 }, () => redeem(code.code).then(() => 'ok', error =>
    error instanceof Error && 'code' in error ? String(error.code) : 'error')))
  expect(results.filter(result => result === 'ok')).toEqual(['ok'])
  expect(results.filter(result => result === 'CODE_EXHAUSTED')).toHaveLength(7)
  expect(await counts(code.id)).toEqual({ used: 1, plans: 1, redemptions: 1, tokens: 1 })

  const fresh = await issue(definition.id, { maxUses: 1 })
  const normalized = normalizeCode(fresh.code)
  const loaded = await findRedeemCode(bindings, normalized!)
  const prepared = await redeemStatements(bindings, member.id, loaded!, crypto.randomUUID(), Date.now())
  prepared.statements.push(db.prepare("INSERT INTO system_settings(key, value, updated_at) SELECT 'plan_write_conflict', NULL, ''"))
  await expect(db.batch(prepared.statements)).rejects.toThrow(/NOT NULL constraint failed: system_settings.value/)
  expect(await counts(fresh.id)).toMatchObject({ used: 0, plans: 1, redemptions: 1, tokens: 1 })
  const granted = await redeem(fresh.code)
  expect(granted.replayed).toBe(false)
  expect(await counts(fresh.id)).toMatchObject({ used: 1, plans: 2, redemptions: 2, tokens: 2 })
})

it('keeps code lifetime, duration snapshot and issued instances independent', async () => {
  const definition = await plan(30)
  const snap = await issue(definition.id, { maxUses: 4, perUserLimit: 4, validUntil: Date.now() + 86_400_000 })
  await updateDefinition(db, definition.id, 1, { durationSeconds: 10 }, actor)
  const inherited = await issue(definition.id, { durationMode: 'inherit', maxUses: 2, perUserLimit: 2 })
  const snapped = await redeem(snap.code)
  const latest = await redeem(inherited.code)
  expect(snapped.instance.expires_at! - snapped.instance.starts_at).toBe(30_000)
  expect(latest.instance.expires_at! - latest.instance.starts_at).toBe(10_000)
  expect(snapped.instance.expires_at).toBeLessThan(Date.now() + 86_400_000)
  await db.prepare('UPDATE redeem_codes SET enabled=0 WHERE id=?').bind(snap.id).run()
  const user = await readPlanUser(db, member.id)
  expect((await new EntitlementResolver(db).resolve(user!, snapped.instance.id, Date.now())).nodes.map(node => node.id)).toEqual([nodeIds[0]])
  expect(await failure(redeem(snap.code))).toBe('CODE_INVALID')
  const archived = await call(`/api/admin/redeem-codes/${snap.id}`, adminCookie, undefined, 'DELETE')
  expect(archived.status).toBe(200)
  expect(await archived.json()).toMatchObject({ archived: true, code: { enabled: false } })
  expect(await db.prepare('SELECT status FROM user_plans WHERE id=?').bind(snapped.instance.id).first<string>('status')).toBe('active')
  const closed = await issue(definition.id, { validFrom: Date.now() + 60_000 })
  const expired = await issue(definition.id)
  await db.prepare('UPDATE redeem_codes SET valid_until=? WHERE id=?').bind(Date.now() - 1, expired.id).run()
  const invalids = await Promise.all([closed.code, expired.code, 'not-a-code'].map(async value => {
    const response = await call('/api/me/redeem', member.cookie, { code: value, idempotencyKey: crypto.randomUUID() })
    expect(response.status).toBe(422)
    return response.json()
  }))
  expect(invalids[0]).toEqual(invalids[1])
  expect(invalids[1]).toEqual(invalids[2])
  expect(JSON.stringify(invalids[0])).not.toContain(normalizeCode(expired.code))
  const limited = await issue(definition.id, { maxUses: 2, perUserLimit: 1 })
  await redeem(limited.code)
  expect(await failure(redeem(limited.code))).toBe('CODE_USER_LIMIT')
  expect((await redeem(limited.code, other.id)).instance.user_id).toBe(other.id)
  expect(await counts(limited.id)).toMatchObject({ used: 2 })
  const pending = await issue(definition.id)
  await updateDefinition(db, definition.id, 2, {}, actor, true)
  expect(await failure(redeem(pending.code))).toBe('PLAN_NOT_ASSIGNABLE')
  expect(await counts(pending.id)).toMatchObject({ used: 0 })
})

it('resolves a redeemed instance from the live plan groups', async () => {
  const definition = await plan(60, groupIds.slice(0, 1))
  const code = await issue(definition.id)
  const granted = await redeem(code.code)
  const user = (await readPlanUser(db, member.id))!
  const resolver = new EntitlementResolver(db)
  expect((await resolver.resolve(user, granted.instance.id, Date.now())).nodes.map(node => node.id)).toEqual([nodeIds[0]])
  await updateDefinition(db, definition.id, 1, { nodeGroupIds: groupIds }, actor)
  expect((await resolver.resolve(user, null, Date.now())).nodes.map(node => node.id)).toEqual([...nodeIds].sort())
  expect(await db.prepare('SELECT count(*) AS count FROM subscription_tokens WHERE scope=? AND user_id=?')
    .bind('aggregate', member.id).first<number>('count')).toBe(0)
})

it('enforces admin masking, session ownership, csrf and attempt limits', async () => {
  const definition = await plan()
  const code = await issue(definition.id, { quantity: 2, maxUses: 3, perUserLimit: 2 })
  const listed = await listRedeemCodes(db, { limit: 10, offset: 0, planId: definition.id })
  const body = JSON.stringify(listed)
  expect(body).not.toContain(normalizeCode(code.code))
  expect(body).toContain(code.tail)
  expect(listed.every(row => row.masked === `••••${row.tail}` && !('code_digest' in row))).toBe(true)
  const unused = (await listRedeemCodes(db, { limit: 10, offset: 0 })).find(row => row.id !== code.id)!
  const removed = await call(`/api/admin/redeem-codes/${unused.id}`, adminCookie, undefined, 'DELETE')
  expect(removed.status).toBe(204)
  expect(await db.prepare('SELECT id FROM redeem_codes WHERE id=?').bind(unused.id).first()).toBeNull()

  expect((await call('/api/me/redeem', '', { code: code.code, idempotencyKey: crypto.randomUUID() })).status).toBe(401)
  expect((await call(`/api/admin/redeem-codes/${code.id}/redemptions`, member.cookie, undefined, 'GET')).status).toBe(403)
  const forged = await call('/api/me/redeem', member.cookie, { code: code.code, idempotencyKey: crypto.randomUUID(), userId: other.id })
  expect(forged.status).toBe(403)
  expect(await forged.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  expect(await counts(code.id)).toMatchObject({ used: 0, redemptions: 0 })
  const missingOrigin = await app.fetch(new Request(`${TEST_ORIGIN}/api/me/redeem`, {
    method: 'POST', headers: { cookie: member.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.code, idempotencyKey: crypto.randomUUID() }),
  }), bindings)
  expect(missingOrigin.status).toBe(403)
  const key = crypto.randomUUID()
  const created = await call('/api/me/redeem', member.cookie, { code: code.code }, 'POST')
  expect(created.status).toBe(400)
  const header = await app.fetch(new Request(`${TEST_ORIGIN}/api/me/redeem`, jsonRequest({ code: code.code }, withCookie(member.cookie, {
    headers: { 'Idempotency-Key': key },
  }))), bindings)
  expect(header.status).toBe(201)
  const conflict = await app.fetch(new Request(`${TEST_ORIGIN}/api/me/redeem`, jsonRequest({ code: code.code, idempotencyKey: crypto.randomUUID() },
    withCookie(member.cookie, { headers: { 'Idempotency-Key': key } }))), bindings)
  expect(conflict.status).toBe(409)
  expect(await counts(code.id)).toMatchObject({ used: 1, redemptions: 1 })
  const records = await listCodeRedemptions(db, code.id, { limit: 10, offset: 0 })
  expect(records).toMatchObject([{ userId: member.id, requestId: key }])
  expect(JSON.stringify(records)).not.toContain(normalizeCode(code.code))
  const httpRecords = await call(`/api/admin/redeem-codes/${code.id}/redemptions`, adminCookie, undefined, 'GET')
  expect(httpRecords.status).toBe(200)
  expect(await httpRecords.json()).toMatchObject({ redemptions: [{ userId: member.id }] })

  const now = Math.floor(Date.now() / 1000)
  const start = windowStartFor(now, 600)
  await db.prepare(`INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at) VALUES (?,?,?,?,?)
    ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count=excluded.count`)
    .bind('plan_redeem_user', member.id, start, 30, start + 600).run()
  const limited = await call('/api/me/redeem', member.cookie, { code: code.code, idempotencyKey: crypto.randomUUID() })
  expect(limited.status).toBe(429)
  const generationStart = windowStartFor(now, 3600)
  await db.prepare(`INSERT INTO rate_limits (bucket, subject, window_start, count, expires_at) VALUES (?,?,?,?,?)
    ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count=excluded.count`)
    .bind('plan_redeem_generation', actor, generationStart, 30, generationStart + 3600).run()
  expect((await call('/api/admin/redeem-codes', adminCookie, { planId: definition.id, quantity: 1 })).status).toBe(429)
  expect((await call('/api/admin/redeem-codes', adminCookie, { planId: definition.id, quantity: 101 })).status).toBe(422)
})
