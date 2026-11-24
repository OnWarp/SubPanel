import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashToken } from '../../../worker/platform/crypto'
import { compiledPrefix } from '../../../worker/delivery/repository'
import { subscriptionLink } from '../../../worker/delivery/links'
import { presentSubscriptionStatus } from '../../../worker/delivery/lifecycle'
import { createDeliveryFixturePlan, createFixtureAccount, enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const ssLine = (name: string, host = 'ss.example.com') =>
  `ss://${btoa('aes-128-gcm:password')}@${host}:8388#${encodeURIComponent(name)}`

type SubscriptionView = {
  id: string
  name: string
  planState?: string
  status?: string
  statusLabel?: string
  statusReason?: string
  statusFix?: { label: string; href?: string } | null
  planId?: string | null
  enabled: boolean
  links: Record<string, string>
  formats?: Array<{ platform: string; capabilityLabel: string; compatible: boolean; note: string | null }>
  fetch?: { lastFetchAt: string | null; lastPlatform: string | null; lastOk: boolean | null; lastStatus: number | null; success: number; failure: number }
  authorizedGroupIds?: string[]
  tokenPrefix?: string
}

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

async function createGroup(cookie: string, name: string, content: string) {
  const sourceResponse = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/sources`,
    jsonRequest({ type: 'manual', name: `${name} source`, content }, withCookie(cookie)),
  )
  expect(sourceResponse.status).toBe(201)
  const sourceId = (await sourceResponse.json() as { source: { id: string } }).source.id
  const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(cookie))).json() as { nodes: Array<{ id: string; displayName: string }> }
  const node = catalog.nodes.find((item) => item.displayName === name) ?? catalog.nodes[catalog.nodes.length - 1]
  const groupResponse = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/groups`,
    jsonRequest({ name, sourceIds: [sourceId], includedNodeIds: [], excludedNodeIds: [], nodeOrder: node ? [node.id] : [] }, withCookie(cookie)),
  )
  expect(groupResponse.status).toBe(201)
  return { groupId: (await groupResponse.json() as { group: { id: string } }).group.id, nodeId: node?.id }
}

async function createOwner(username = 'life-user') {
  const response = await createFixtureAccount(username, 'life user password')
  const user = (await response.json() as { user: { id: string } }).user
  return { id: user.id, cookie: await login(username, 'life user password') }
}

async function createSubscription(admin: string, body: Record<string, unknown>) {
  const response = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/subscriptions`,
    jsonRequest(body, withCookie(admin)),
  )
  expect(response.status).toBe(201)
  return response.json() as Promise<{ subscription: SubscriptionView; token: string }>
}

async function adminSubscription(admin: string, id: string) {
  const response = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions`, withCookie(admin))
  expect(response.status).toBe(200)
  const body = await response.json() as { subscriptions: SubscriptionView[] }
  const subscription = body.subscriptions.find((item) => item.id === id)
  expect(subscription).toBeTruthy()
  return subscription!
}

async function userSubscription(cookie: string, id: string) {
  const response = await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscriptions`, withCookie(cookie))
  expect(response.status).toBe(200)
  const body = await response.json() as { subscriptions: SubscriptionView[] }
  return body.subscriptions.find((item) => item.id === id) ?? null
}

function expectNoPeriod(value: string) {
  expect(value.endsWith('。')).toBe(false)
  expect(value.endsWith('.')).toBe(false)
}

describe('subscription lifecycle', () => {
  it('keeps every status consistent across admin, user, and public subscription', async () => {
    const admin = await login()
    const owner = await createOwner()
    const primary = await createGroup(admin, 'Primary node', ssLine('Primary node'))
    const outside = await createGroup(admin, 'Outside node', ssLine('Outside node', 'outside.example.com'))
    const emptyGroup = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/catalog/groups`,
      jsonRequest({ name: 'Empty group', sourceIds: [], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [] }, withCookie(admin)),
    )
    expect(emptyGroup.status).toBe(201)
    const emptyGroupId = (await emptyGroup.json() as { group: { id: string } }).group.id
    const plan = await createDeliveryFixturePlan([primary.groupId, emptyGroupId])
    const revokeOwner = await createOwner('revoke-user')

    const active = await createSubscription(admin, {
      name: 'Active', userId: owner.id, planId: plan.id, groupIds: [primary.groupId], defaultClient: 'mihomo',
    })
    const activeView = await adminSubscription(admin, active.subscription.id)
    expect(activeView.status).toBe('active')
    expect(activeView.statusLabel).toBe('正常')
    expect(activeView.statusReason).toBe('订阅有效')
    expect(activeView.statusFix).toBeNull()
    expectNoPeriod(activeView.statusReason!)
    const activeUser = await userSubscription(owner.cookie, active.subscription.id)
    expect(activeUser?.status).toBe('active')
    expect(activeUser?.statusLabel).toBe('有效')
    expect(activeUser).not.toHaveProperty('statusReason')
    expect(activeUser).not.toHaveProperty('statusFix')
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${active.token}/mihomo`)).status).toBe(200)

    const pending = await createSubscription(admin, {
      name: 'Pending', userId: owner.id, planId: plan.id, groupIds: [primary.groupId], startsAt: Date.now() + 86_400_000,
    })
    expect((await adminSubscription(admin, pending.subscription.id)).status).toBe('pending')
    expect((await userSubscription(owner.cookie, pending.subscription.id))?.statusLabel).toBe('尚未生效')
    expect(await (await exports.default.fetch(`${TEST_ORIGIN}/sub/${pending.token}/mihomo`)).json()).toEqual({ error: { code: 'SUB_NOT_STARTED', message: '订阅尚未生效' } })

    const disabled = await createSubscription(admin, {
      name: 'Disabled', userId: owner.id, planId: plan.id, groupIds: [primary.groupId], enabled: false,
    })
    expect((await adminSubscription(admin, disabled.subscription.id)).statusLabel).toBe('已停用')
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${disabled.token}/mihomo`)).status).toBe(404)

    const expired = await createSubscription(admin, {
      name: 'Expired', userId: owner.id, planId: plan.id, groupIds: [primary.groupId], expiresAt: Date.now() - 1000,
    })
    expect((await adminSubscription(admin, expired.subscription.id)).status).toBe('expired')
    const expiredPull = await exports.default.fetch(`${TEST_ORIGIN}/sub/${expired.token}/mihomo`, { headers: { 'If-None-Match': '"stale"' } })
    expect(expiredPull.status).toBe(410)
    expect(await expiredPull.json()).toEqual({ error: { code: 'SUB_EXPIRED', message: '订阅已过期' } })

    const revokePlan = await createDeliveryFixturePlan([primary.groupId])
    const revoked = await createSubscription(admin, {
      name: 'Revoked', userId: revokeOwner.id, planId: revokePlan.id, groupIds: [primary.groupId],
    })
    const revoke = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/users/${revokeOwner.id}/subscription-plan`,
      jsonRequest({ action: 'revoke' }, withCookie(admin)),
    )
    expect(revoke.status).toBe(200)
    const revokedView = await adminSubscription(admin, revoked.subscription.id)
    expect(revokedView.status).toBe('revoked')
    expect(revokedView.planState).toBe('revoked')
    expect((await userSubscription(revokeOwner.cookie, revoked.subscription.id))?.statusLabel).toBe('已停用')
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${revoked.token}/mihomo`)).status).toBe(404)
    // Existing explicitly stopped records retain the previous revoked response.
    await env.DB.prepare('UPDATE subscriptions SET enabled=0 WHERE id=?').bind(revoked.subscription.id).run()
    expect((await adminSubscription(admin, revoked.subscription.id)).status).toBe('revoked')
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${revoked.token}/mihomo`)).status).toBe(404)

    const noPlan = await createSubscription(admin, {
      name: 'No plan', userId: owner.id, groupIds: [primary.groupId],
    })
    expect((await adminSubscription(admin, noPlan.subscription.id)).status).toBe('active')
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${noPlan.token}/mihomo`)).status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${noPlan.token}/generic`)).status).toBe(200)

    const noGroups = await createSubscription(admin, {
      name: 'No groups', userId: owner.id, planId: plan.id, groupIds: [outside.groupId],
    })
    expect((await adminSubscription(admin, noGroups.subscription.id)).status).toBe('no_groups')
    expect(await (await exports.default.fetch(`${TEST_ORIGIN}/sub/${noGroups.token}/mihomo`)).json()).toMatchObject({ error: { details: { reason: 'noGroupIntersection' } } })

    const noNodes = await createSubscription(admin, {
      name: 'No nodes', userId: owner.id, planId: plan.id, groupIds: [emptyGroupId],
    })
    expect((await adminSubscription(admin, noNodes.subscription.id)).status).toBe('no_nodes')
    expect(await (await exports.default.fetch(`${TEST_ORIGIN}/sub/${noNodes.token}/mihomo`)).json()).toMatchObject({ error: { details: { reason: 'noEnabledNodes' } } })

    const naive = await createGroup(admin, 'Naive node', 'naive://user:pass@naive.example.com:443#Naive%20node')
    const naivePlan = await createDeliveryFixturePlan([naive.groupId])
    const incompatible = await createSubscription(admin, {
      name: 'Incompatible', userId: owner.id, planId: naivePlan.id, groupIds: [naive.groupId], defaultClient: 'mihomo',
    })
    const incompatibleView = await adminSubscription(admin, incompatible.subscription.id)
    expect(incompatibleView.status).toBe('incompatible')
    expect(incompatibleView.statusLabel).toBe('不兼容')
    expect(await (await exports.default.fetch(`${TEST_ORIGIN}/sub/${incompatible.token}/mihomo`)).json()).toMatchObject({ error: { details: { reason: 'incompatible' } } })
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${incompatible.token}/singbox`)).status).toBe(200)

    await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users/${owner.id}`, jsonRequest({ enabled: false }, withCookie(admin, { method: 'PATCH' })))
    const unavailable = await adminSubscription(admin, active.subscription.id)
    expect(unavailable.status).toBe('owner_unavailable')
    expect(unavailable.statusFix).toEqual({ label: '前往用户', href: '/users' })
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${active.token}/mihomo`)).status).toBe(404)
    const safe = presentSubscriptionStatus('owner_unavailable', 'user')
    expect(safe.statusLabel).toBe('暂不可用')
    expect(JSON.stringify(safe)).not.toContain('删除')
    expect(JSON.stringify(safe)).not.toContain(owner.id)
  })

  it('rejects stale cache, reset tokens, and widened share previews', async () => {
    const admin = await login()
    const owner = await createOwner()
    const primary = await createGroup(admin, 'Primary node', ssLine('Primary node'))
    const outside = await createGroup(admin, 'Outside node', ssLine('Outside node', 'outside.example.com'))
    const plan = await createDeliveryFixturePlan([primary.groupId])
    const created = await createSubscription(admin, {
      name: 'Guarded', userId: owner.id, planId: plan.id, groupIds: [primary.groupId, outside.groupId],
    })
    const first = await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/mihomo`)
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const again = await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/mihomo`, { headers: { 'If-None-Match': etag! } })
    expect(again.status).toBe(304)

    const disabled = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${created.subscription.id}`,
      jsonRequest({ enabled: false }, withCookie(admin, { method: 'PATCH' })),
    )
    expect(disabled.status).toBe(200)
    const tokenHash = await hashToken(created.token)
    await env.DATA.put(`${compiledPrefix(tokenHash)}mihomo`, JSON.stringify({
      schemaVersion: 2, client: 'mihomo', body: 'proxies: []', contentType: 'text/yaml', fileName: 'sub.yaml',
      etag: '"stale"', lastModified: new Date().toISOString(), subscriptionRevision: 99, catalogRevision: 99,
      inputNodes: 1, outputNodes: 1, skippedNodes: 0, diagnostics: [], available: true, rendererVersion: '2',
    }))
    const blocked = await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/mihomo`, { headers: { 'If-None-Match': '"stale"' } })
    expect(blocked.status).toBe(404)

    const enabled = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${created.subscription.id}`,
      jsonRequest({ enabled: true }, withCookie(admin, { method: 'PATCH' })),
    )
    expect(enabled.status).toBe(200)
    const reset = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${created.subscription.id}/token/reset`,
      jsonRequest({}, withCookie(admin)),
    )
    expect(reset.status).toBe(200)
    const rotated = await reset.json() as { token: string }
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/mihomo`)).status).toBe(404)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${rotated.token}/mihomo`)).status).toBe(200)
    const audits = await env.DB.prepare("SELECT action, detail FROM audit_logs WHERE action = 'post.subscriptions.token.reset'").all<{ action: string; detail: string }>()
    expect(audits.results.length).toBeGreaterThan(0)
    expect(JSON.stringify(audits.results)).not.toContain(rotated.token)
    expect(JSON.stringify(audits.results)).not.toContain(created.token)

    const userReset = await exports.default.fetch(
      `${TEST_ORIGIN}/api/account/subscriptions/${created.subscription.id}/token/reset`,
      jsonRequest({}, withCookie(owner.cookie)),
    )
    expect(userReset.status).toBe(200)
    const userToken = (await userReset.json() as { token: string }).token
    const userAudits = await env.DB.prepare("SELECT detail FROM audit_logs WHERE actor_user_id = ? AND action = 'post.subscriptions.token.reset'").bind(owner.id).all<{ detail: string }>()
    expect(userAudits.results.length).toBeGreaterThan(0)
    expect(JSON.stringify(userAudits.results)).not.toContain(userToken)

    const share = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares`,
      jsonRequest({
        subscriptionId: created.subscription.id,
        accessControl: 'none',
        showGroups: true,
        showNodeNames: true,
        showSubscriptionName: true,
      }, withCookie(owner.cookie)),
    )
    expect(share.status).toBe(201)
    const shareToken = (await share.json() as { token: string }).token
    const meta = await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${shareToken}/meta`)
    expect(meta.status).toBe(200)
    const metaBody = await meta.json() as { meta: { nodeNames?: string[]; groupNames?: string[]; nodeCount: number } }
    expect(metaBody.meta.nodeNames).toEqual(['Primary node'])
    expect(metaBody.meta.groupNames).toEqual(['Primary node'])
    expect(metaBody.meta.nodeCount).toBe(1)
    expect(JSON.stringify(metaBody)).not.toContain('Outside node')
  })

  it('builds one link, labels renderer capability, and samples fetches without a user agent', async () => {
    const admin = await login()
    const owner = await createOwner()
    const primary = await createGroup(admin, 'Primary node', ssLine('Primary node'))
    const plan = await createDeliveryFixturePlan([primary.groupId])
    const secondPlan = await createDeliveryFixturePlan([primary.groupId])
    const created = await createSubscription(admin, {
      name: 'Links', userId: owner.id, planId: plan.id, groupIds: [primary.groupId],
    })
    const extra = await createSubscription(admin, {
      name: 'Extra', userId: owner.id, planId: plan.id, groupIds: [primary.groupId],
    })
    const view = await adminSubscription(admin, created.subscription.id)
    const origin = new URL(view.links.auto).origin
    expect(view.links.auto).toBe(subscriptionLink(origin, created.token, 'auto'))
    expect(view.links.mihomo).toBe(subscriptionLink(origin, created.token, 'mihomo'))
    expect(view.links.clash).toBe(subscriptionLink(origin, created.token, 'clash'))
    expect(view.formats?.find((item) => item.platform === 'mihomo')?.capabilityLabel).toBe('完整规则配置')
    expect(view.formats?.find((item) => item.platform === 'clash')?.capabilityLabel).toBe('完整规则配置')
    expect(view.formats?.find((item) => item.platform === 'singbox')?.capabilityLabel).toBe('仅节点订阅')
    expect(view.formats?.find((item) => item.platform === 'auto')?.note).toBe('识别到 Mihomo 时输出完整规则配置，识别失败回退为通用节点列表')
    for (const format of view.formats ?? []) if (format.note) expectNoPeriod(format.note)

    const fallback = await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}`, { headers: { 'User-Agent': 'curl/8.0' } })
    expect(fallback.status).toBe(200)
    expect(fallback.headers.get('x-subscription-client')).toBe('generic')
    expect(fallback.headers.get('x-subscription-detect')).toBe('fallback')
    expect(fallback.headers.get('x-subscription-notice')).toBe('generic-import-differs')
    expect(fallback.headers.get('referrer-policy')).toBe('no-referrer')
    expect(fallback.headers.get('etag')).toBeTruthy()
    expect(JSON.stringify([...fallback.headers.entries()])).not.toContain(created.token)

    const detected = await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}`, { headers: { 'User-Agent': 'ClashMeta' } })
    expect(detected.headers.get('x-subscription-detect')).toBe('user-agent')
    expect(detected.headers.get('x-subscription-client')).toBe('mihomo')

    const explicit = await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/singbox`)
    expect(explicit.headers.get('x-subscription-detect')).toBe('path')
    const missing = await exports.default.fetch(`${TEST_ORIGIN}/sub/not-a-token`)
    expect(missing.headers.get('referrer-policy')).toBe('no-referrer')

    const after = await adminSubscription(admin, created.subscription.id)
    expect(after.fetch?.lastFetchAt).toBeTruthy()
    expect(after.fetch?.lastPlatform).toBe('singbox')
    expect(after.fetch?.lastOk).toBe(true)
    expect(after.fetch?.success).toBeGreaterThan(0)
    expect(after.fetch).toMatchObject({ statuses: expect.any(Object), durationMs: { min: expect.any(Number), max: expect.any(Number) } })
    expect(JSON.stringify(after.fetch)).not.toContain('curl')
    expect(JSON.stringify(after.fetch)).not.toContain('ClashMeta')
    const stored = await env.DATA.get(`fetch-stats:${created.subscription.id}`)
    expect(stored ?? '').not.toContain('curl')

    const copied = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/${created.subscription.id}/copy`,
      jsonRequest({}, withCookie(admin)),
    )
    expect(copied.status).toBe(201)
    const copyBody = await copied.json() as { subscription: SubscriptionView; token: string }
    expect(copyBody.subscription.name).toBe('Links 副本')
    expect(copyBody.token).not.toBe(created.token)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/mihomo`)).status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${copyBody.token}/mihomo`)).status).toBe(200)

    const jobPath = '/api/admin/compile-jobs'
    const request = (path: string, body?: unknown) => exports.default.fetch(
      TEST_ORIGIN + jobPath + path,
      body === undefined ? withCookie(admin) : jsonRequest(body, withCookie(admin)),
    )
    const inspect = async (input: { ids: string[]; operation: Record<string, unknown> }) => {
      const response = await request('/batch/preview', input)
      expect(response.status).toBe(200)
      return { ...input, ...await response.json() as { previewId: string; fingerprint: string; platforms: string[]; affected: number } }
    }
    const enqueue = async (input: Awaited<ReturnType<typeof inspect>>, status = 201) => {
      const response = await request('/batch', input)
      expect(response.status).toBe(status)
      return (await response.json() as { job: { id: string } }).job.id
    }
    const ids = [created.subscription.id, extra.subscription.id]
    const planReview = await inspect({ ids, operation: { action: 'plan', planId: secondPlan.id } })
    expect(planReview).toMatchObject({ affected: 2, platforms: expect.arrayContaining(['mihomo', 'singbox', 'generic']) })
    const batchId = await enqueue(planReview)
    expect(await enqueue(planReview, 200)).toBe(batchId)
    expect(await (await request(`/${batchId}/run`, {})).json()).toMatchObject({ job: { status: 'completed', processed: 2, failures: 0 } })
    expect((await adminSubscription(admin, created.subscription.id)).planId).toBe(secondPlan.id)
    expect((await adminSubscription(admin, extra.subscription.id)).planId).toBe(secondPlan.id)

    const bindingReview = await inspect({ ids: ids.slice(0, 1), operation: { action: 'binding', templateBinding: { mode: 'base' } } })
    expect(bindingReview.platforms).toEqual(['mihomo', 'singbox'])
    const bindingId = await enqueue(bindingReview)
    expect(await (await request(`/${bindingId}/run`, {})).json()).toMatchObject({ job: { status: 'completed', processed: 1 } })

    const copyReview = await inspect({ ids: [created.subscription.id, 'sub_999999'], operation: { action: 'copy' } })
    expect(copyReview).toMatchObject({ affected: 1, missing: 1, platforms: [] })
    const copyId = await enqueue(copyReview)
    expect(await (await request(`/${copyId}/run`, {})).json()).toMatchObject({ job: { status: 'failed', processed: 2, failures: 1 } })
    const outcomes = await (await request(`/${copyId}/items`)).json() as { items: Array<{ id: string; outcome: string; copyId: string }> }
    const copiedId = outcomes.items.find(item => item.id === created.subscription.id)?.copyId
    expect(copiedId).toMatch(/^sub_/u)
    const copiedView = await adminSubscription(admin, copiedId!)
    expect(copiedView.links.mihomo).not.toBe(after.links.mihomo)
    const retry = await (await request(`/${copyId}/retry`, {})).json()
    expect(retry).toMatchObject({ input: { ids: ['sub_999999'], operation: { action: 'copy' } }, affected: 0 })

    const disableReview = await inspect({ ids, operation: { action: 'disable' } })
    const disableId = await enqueue(disableReview)
    expect(await (await request(`/${disableId}/cancel`, {})).json()).toMatchObject({ job: { status: 'cancelled', processed: 0 } })
    expect((await request(`/${disableId}/run`, {})).status).toBe(409)
    expect((await adminSubscription(admin, created.subscription.id)).enabled).toBe(true)
    const audit = await env.DB.prepare("SELECT action, target_id, detail FROM audit_logs WHERE action LIKE 'subscription_batch.%' AND action<>'subscription_batch.created'").all()
    expect(audit.results).toHaveLength(5)
    expect(audit.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'subscription_batch.copy', target_id: created.subscription.id, detail: expect.stringContaining(copiedId!) }),
      expect.objectContaining({ action: 'subscription_batch.copy', target_id: 'sub_999999', detail: expect.stringContaining('SUBSCRIPTION_NOT_FOUND') }),
    ]))
    expect(JSON.stringify(audit.results)).not.toContain(created.token)

    const allIds = [...ids]
    for (let index = 0; index < 3; index++) {
      const { subscription } = await createSubscription(admin, {
        name: `Batch page fixture ${index}`, planId: secondPlan.id, groupIds: [primary.groupId],
      })
      allIds.push(subscription.id)
    }
    const pagedId = await enqueue(await inspect({ ids: allIds, operation: { action: 'disable' } }))
    const firstPage = await request(`/${pagedId}/run`, {})
    expect(await firstPage.json()).toMatchObject({ job: { status: 'running', processed: 4 } })
    expect(await (await request(`/${pagedId}/cancel`, {})).json()).toMatchObject({ job: { status: 'cancelled', processed: 4 } })
    const remaining = await (await request(`/${pagedId}/retry`, {})).json() as Awaited<ReturnType<typeof inspect>> & { input: { ids: string[]; operation: Record<string, unknown> } }
    expect(remaining.input.ids).toHaveLength(1)
    const resumed = await enqueue({ ...remaining, ...remaining.input })
    expect(await (await request(`/${resumed}/run`, {})).json()).toMatchObject({ job: { status: 'completed', processed: 1 } })
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/mihomo`)).status).toBe(404)
    const enableReview = await inspect({ ids: ids.slice(0, 1), operation: { action: 'enable' } })
    const enableId = await enqueue(enableReview)
    expect(await (await request(`/${enableId}/run`, {})).json()).toMatchObject({ job: { status: 'completed', processed: 1 } })
    expect((await exports.default.fetch(`${TEST_ORIGIN}/sub/${created.token}/mihomo`)).status).toBe(200)
    expect((await request('/batch', enableReview)).status).toBe(200)
    const stale = await inspect({ ids: ids.slice(0, 1), operation: { action: 'disable' } })
    const update = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/subscriptions/${created.subscription.id}`,
      jsonRequest({ name: 'Renamed' }, withCookie(admin, { method: 'PATCH' })))
    expect(update.status).toBe(200)
    expect((await request('/batch', stale)).status).toBe(409)


    const preview = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions/output-preview`,
      jsonRequest({ planId: null, groupIds: [primary.groupId], defaultClient: 'mihomo' }, withCookie(admin)),
    )
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ planGroupIds: [], outputNodes: 1 })
  })
})
