import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../../../worker/app'
import { readDelivery } from '../../../worker/delivery/repository'
import { toBase64Url } from '../../../worker/platform/crypto'
import { applyMigrations } from './d1'
import { createFixtureAccount, enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const batches = '/api/admin/redemption-batches'
const me = '/api/me/redemptions'
const templates = '/api/admin/subscription-templates'
const catalog = '/api/admin/catalog'
const config = {
  duration: { value: 1, unit: 'month' }, quotaBytes: 15 * 1024 ** 3,
  resetPolicy: 'none', limits: { speedLimitMbps: 0 }, nodeIds: [],
}
const newKey = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
let oldKey: string
let bindings: Env

beforeEach(async () => {
  await resetData()
  await applyMigrations()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM redemption_records'),
    env.DB.prepare('DELETE FROM redemption_codes'),
    env.DB.prepare('DELETE FROM redemption_batches'),
    env.DB.prepare("DELETE FROM audit_logs WHERE target_type='redemption_batches'"),
    env.DB.prepare("DELETE FROM rate_limits WHERE bucket GLOB 'redemption_*'"),
    env.DB.prepare("UPDATE entitlement_templates SET status='archived'"),
  ])
  await enableD1Modules()
  await setupAdmin()
  oldKey = newKey()
  bindings = { ...env, REDEMPTION_HMAC_KEYS: JSON.stringify({ active: 'v1', keys: { v1: oldKey } }) }
})

function call(path: string, cookie: string, body?: object, method?: string) {
  const request = body ? jsonRequest(body, withCookie(cookie, { method })) : withCookie(cookie)
  return app.fetch(new Request(TEST_ORIGIN + path, request), bindings)
}

async function account(index: number) {
  const username = `redeemer-${index}`
  const password = crypto.randomUUID()
  const { user } = await (await createFixtureAccount(username, password)).json<{ user: { id: string } }>()
  return { id: user.id, cookie: await login(username, password) }
}

type Template = { id: string; revision: number; currentVersion: { id: string } }
type Batch = { id: string; codes: string[] }
type ConfirmInput = { code: string; previewProof: string; idempotencyKey: string }
type ConfirmOutput = { subscription: { id: string; name: string; expiresAt: number } }

async function fixture() {
  const admin = await login()
  const sourceResponse = await call(`${catalog}/sources`, admin, {
    type: 'manual', name: 'Redemption test',
    content: `ss://${btoa(`aes-128-gcm:${crypto.randomUUID()}`)}@redemption.example.test:8388#Redemption`,
  })
  expect(sourceResponse.status).toBe(201)
  const { source } = await sourceResponse.json<{ source: { id: string } }>()
  const groupResponse = await call(`${catalog}/groups`, admin, {
    name: 'Redeem group', sourceIds: [source.id], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [],
  })
  expect(groupResponse.status).toBe(201)
  const { group } = await groupResponse.json<{ group: { id: string } }>()
  const templateResponse = await call(templates, admin, { name: 'Redeem monthly', allowRedemption: true, config: { ...config, groupIds: [group.id] } })
  expect(templateResponse.status).toBe(201)
  const { template } = await templateResponse.json<{ template: Template }>()
  const issue = async (overrides: object = {}) => {
    const input = {
      name: 'Batch', templateVersionId: template.currentVersion.id, quantity: 3,
      redeemDeadline: Date.now() + 60_000, idempotencyKey: crypto.randomUUID(), ...overrides,
    }
    const response = await call(batches, admin, input)
    expect(response.status).toBe(201)
    return { ...await response.json<Batch>(), input }
  }
  return { admin, template, group, issue }
}

async function preview(cookie: string, code: string) {
  const response = await call(`${me}/preview`, cookie, { code })
  expect(response.status).toBe(200)
  const { preview } = await response.json<{ preview: { previewProof: string; quotaBytes: number } }>()
  return { code, previewProof: preview.previewProof, idempotencyKey: crypto.randomUUID() }
}
const confirm = (cookie: string, input: ConfirmInput) => call(me, cookie, input)

async function unavailable(response: Response) {
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({ error: { code: 'REDEMPTION_CODE_UNAVAILABLE', message: '兑换码不可用，请检查后重试' } })
}

it('pins batch entitlements across template changes, rotation and disabling issuance, with safe audit and ownership', async () => {
  const { admin, template, group, issue } = await fixture()
  const holder = await account(1)
  const outsider = await account(2)
  const { id, codes, input } = await issue()
  expect(new Set(codes).size).toBe(3)
  codes.forEach((code) => expect(code).toMatch(/^[2-9A-HJ-KM-NP-TV-Z]{4}(?:-[2-9A-HJ-KM-NP-TV-Z]{4}){6}$/u))
  const duplicate = await call(batches, admin, input)
  expect(duplicate.status).toBe(409)
  expect(await duplicate.text()).not.toContain(codes[0])
  const list = await call(`${batches}/${id}/codes`, admin)
  const codeList = await list.json<{ items: { id: string; tail: string }[] }>()
  expect(codeList.items.map((item) => item.tail).sort()).toEqual(codes.map((code) => code.slice(-4)).sort())
  expect(JSON.stringify(codeList)).not.toContain(codes[0])
  expect((await call(batches, holder.cookie)).status).toBe(403)
  expect((await call(me, '')).status).toBe(401)
  const changed = await call(`${templates}/${template.id}`, admin, {
    expectedRevision: template.revision, status: 'disabled', config: { ...config, groupIds: [group.id], quotaBytes: 20 * 1024 ** 3 },
  }, 'PATCH')
  expect(changed.status).toBe(200)
  const newRelease = await call(batches, admin, { ...input, idempotencyKey: crypto.randomUUID() })
  expect(newRelease.status).toBe(409)
  bindings = { ...bindings, REDEMPTION_HMAC_KEYS: JSON.stringify({ active: 'v2', keys: { v1: oldKey, v2: newKey() } }) }

  const revoked = codeList.items.find((item) => item.tail === codes[2].slice(-4))!
  expect((await call(`/api/admin/redemption-codes/${revoked.id}/revoke`, admin, {})).status).toBe(200)
  await unavailable(await call(`${me}/preview`, holder.cookie, { code: codes[2] }))
  const request = await preview(holder.cookie, codes[0].toLowerCase())
  expect((await call(me, holder.cookie, { ...request, userId: outsider.id })).status).toBe(422)
  await unavailable(await confirm(outsider.cookie, request))
  const result = await confirm(holder.cookie, request)
  expect(result.status).toBe(200)
  const { subscription } = await result.json<ConfirmOutput>()
  const { subscriptions } = await readDelivery(bindings)
  expect(subscriptions).toHaveLength(1)
  expect(subscriptions[0]).toMatchObject({
    id: subscription.id, userId: holder.id, trafficGb: 15, sourceType: 'redemption', templateVersionId: template.currentVersion.id,
  })
  expect((await call(`/api/me/subscriptions/${subscription.id}`, outsider.cookie)).status).toBe(404)
  const other = await preview(holder.cookie, codes[1])
  expect((await confirm(holder.cookie, { ...other, idempotencyKey: request.idempotencyKey })).status).toBe(409)
  expect((await call(`${batches}/${id}/disable`, admin, {})).status).toBe(200)
  await unavailable(await confirm(holder.cookie, other))
  expect(await (await confirm(holder.cookie, request)).json()).toEqual({ subscription })
  bindings = { ...bindings, REDEMPTION_HMAC_KEYS: JSON.stringify({ active: 'v2', keys: { v2: newKey() } }) }
  expect(await (await confirm(holder.cookie, request)).json()).toEqual({ subscription })
  expect((await call(`/api/me/subscriptions/${subscription.id}`, holder.cookie)).status).toBe(200)
  expect(await (await call(me, outsider.cookie)).json()).toMatchObject({ total: 0 })
  expect(await (await call(me, holder.cookie)).json()).toMatchObject({ total: 1, items: [{ subscriptionId: subscription.id }] })
  const audit = await (await call(`${batches}/${id}/audit`, admin)).text()
  expect(audit).toContain('redemption.confirm')
  expect(audit).toContain('redemption.batch.release')
  expect(audit).not.toContain(codes[0])
})

it('accepts exactly one of ten concurrent users for a single-use code and replays with no duplicate writes', async () => {
  const { issue } = await fixture()
  const { codes: [code] } = await issue({ quantity: 1 })
  const holders = []
  for (let index = 1; index <= 10; index += 1) holders.push(await account(index))
  const requests = await Promise.all(holders.map((holder) => preview(holder.cookie, code)))
  const results = await Promise.all(holders.map((holder, index) => confirm(holder.cookie, requests[index])))
  expect(results.map(({ status }) => status).sort()).toEqual([200, ...Array.from({ length: 9 }, () => 422)])
  const index = results.findIndex(({ ok }) => ok)
  const receipt = await results[index].json<ConfirmOutput>()
  const repeats = await Promise.all(Array.from({ length: 5 }, () => confirm(holders[index].cookie, requests[index])))
  for (const repeat of repeats) expect(await repeat.json()).toEqual(receipt)
  expect(await env.DB.prepare('SELECT used_count FROM redemption_codes').first()).toEqual({ used_count: 1 })
  expect(await env.DB.prepare('SELECT count(*) AS total FROM redemption_records').first()).toEqual({ total: 1 })
  expect(await env.DB.prepare("SELECT count(*) AS total FROM audit_logs WHERE action='redemption.confirm'").first()).toEqual({ total: 1 })
  expect((await readDelivery(bindings)).subscriptions).toHaveLength(1)
})

it('deduplicates simultaneous retries and rolls back quota, subscription and history on audit failure', async () => {
  const { issue } = await fixture()
  const holder = await account(1)
  const { codes: [code] } = await issue({ quantity: 1, maxUses: 2 })
  const request = await preview(holder.cookie, code)
  await env.DB.prepare(`CREATE TRIGGER fail_redemption_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action='redemption.confirm' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`).run()
  try {
    expect((await confirm(holder.cookie, request)).status).toBe(500)
  } finally {
    await env.DB.prepare('DROP TRIGGER fail_redemption_audit').run()
  }
  expect(await env.DB.prepare('SELECT used_count FROM redemption_codes').first()).toEqual({ used_count: 0 })
  expect(await env.DB.prepare('SELECT count(*) AS total FROM redemption_records').first()).toEqual({ total: 0 })
  expect((await readDelivery(bindings)).subscriptions).toHaveLength(0)
  const results = await Promise.all([confirm(holder.cookie, request), confirm(holder.cookie, request)])
  expect(results.map(({ status }) => status)).toEqual([200, 200])
  expect(await results[0].json()).toEqual(await results[1].json())
  await unavailable(await confirm(holder.cookie, { ...request, idempotencyKey: crypto.randomUUID() }))
  const another = await account(2)
  const next = await preview(another.cookie, code)
  await env.DB.prepare('UPDATE redemption_batches SET redeem_deadline=?').bind(Date.now() - 1).run()
  await unavailable(await confirm(another.cookie, next))
  expect((await confirm(holder.cookie, request)).status).toBe(200)
  expect((await readDelivery(bindings)).subscriptions).toHaveLength(1)
})

it('caps batch generation and account-level attempts, including malformed codes without echoing input', async () => {
  const { admin, issue } = await fixture()
  const { codes: [code], input } = await issue({ quantity: 500 })
  const invalidRequest = await call(batches, admin, { ...input, quantity: 501 })
  expect(invalidRequest.status).toBe(422)
  for (let index = 0; index < 4; index += 1) await issue({ quantity: 1 })
  expect((await call(batches, admin, { ...input, idempotencyKey: crypto.randomUUID() })).status).toBe(429)
  const holder = await account(1)
  const invalid = await call(`${me}/preview`, holder.cookie, { [code]: true })
  expect(invalid.status).toBe(422)
  expect(await invalid.text()).not.toContain(code)
  for (let index = 0; index < 19; index += 1) await unavailable(await call(`${me}/preview`, holder.cookie, { code: 'wrong' }))
  expect((await call(`${me}/preview`, holder.cookie, { code })).status).toBe(429)
})
