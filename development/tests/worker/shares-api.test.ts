import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashToken } from '../../../worker/platform/crypto'
import { shareEntityKey } from '../../../worker/shares/repository'
import { DEFAULT_SHARE_SETTINGS, type ShareSettings } from '../../../worker/shares/schema'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

type ShareView = {
  id: string
  ownerUserId: string
  subscriptionId: string
  tokenPrefix: string
  remark: string
  status: string
  accessControl: 'none' | 'password'
  expiresAt: string
  allowOriginalLink: boolean
  showSubscriptionName: boolean
  showGroups: boolean
  showExpiry: boolean
  showNodeNames: boolean
  requireLogin: boolean
  maxAccessCount: number | null
  accessCount: number
  lastAccessedAt: string | null
  lastOriginalRevealAt: string | null
  createdAt: string
  updatedAt: string
}

type ErrorBody = { error: { code: string, message: string } }

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  const body = await response.json() as ErrorBody
  expect(body.error.code).toBe(code)
  expect(body.error.message.endsWith('。')).toBe(false)
  expect(body.error.message.endsWith('.')).toBe(false)
}

function cookiePair(response: Response, name: string): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const rows = headers.getSetCookie?.() ?? []
  const found = rows.find((value) => value.startsWith(`${name}=`)) ?? response.headers.get('set-cookie') ?? ''
  const pair = found.split(';', 1)[0]
  if (!pair.startsWith(`${name}=`)) throw new Error(`missing cookie ${name}`)
  return pair
}

async function provisionUser(adminCookie: string, username: string, password: string): Promise<{ id: string, cookie: string }> {
  const invite = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/invites`,
    jsonRequest({ username }, withCookie(adminCookie)),
  )
  expect(invite.status).toBe(201)
  const link = (await invite.json() as { invite: { link: string } }).invite.link
  const token = new URL(link).pathname.split('/').at(-1) ?? ''
  const redeemed = await exports.default.fetch(`${TEST_ORIGIN}/api/invites/${token}`, jsonRequest({ password }))
  expect(redeemed.status).toBe(201)
  const users = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(adminCookie))).json() as {
    users: Array<{ id: string, username: string }>
  }
  const user = users.users.find((item) => item.username === username)
  if (!user) throw new Error(`missing user ${username}`)
  return { id: user.id, cookie: await login(username, password) }
}

async function createGroup(adminCookie: string, name: string, nodeName: string, host: string): Promise<string> {
  const content = `ss://${btoa('aes-128-gcm:password')}@${host}:8388#${encodeURIComponent(nodeName)}`
  const source = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/sources`,
    jsonRequest({ type: 'manual', name: `${name} source`, content }, withCookie(adminCookie)),
  )
  expect(source.status).toBe(201)
  const sourceId = (await source.json() as { source: { id: string } }).source.id
  const catalog = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/catalog`, withCookie(adminCookie))).json() as {
    nodes: Array<{ id: string, displayName: string }>
  }
  const node = catalog.nodes.find((item) => item.displayName === nodeName)
  if (!node) throw new Error(`missing node ${nodeName}`)
  const group = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/catalog/groups`,
    jsonRequest({
      name,
      sourceIds: [sourceId],
      includedNodeIds: [],
      excludedNodeIds: [],
      nodeOrder: [node.id],
    }, withCookie(adminCookie)),
  )
  expect(group.status).toBe(201)
  return (await group.json() as { group: { id: string } }).group.id
}

async function createSubscription(
  adminCookie: string,
  userId: string,
  groupId: string,
  name: string,
  enabled = true,
): Promise<string> {
  const response = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/subscriptions`,
    jsonRequest({ userId, name, groupIds: [groupId], enabled, defaultClient: 'mihomo' }, withCookie(adminCookie)),
  )
  expect(response.status).toBe(201)
  return (await response.json() as { subscription: { id: string } }).subscription.id
}

async function putSettings(adminCookie: string, patch: Partial<ShareSettings> = {}): Promise<ShareSettings> {
  const response = await exports.default.fetch(
    `${TEST_ORIGIN}/api/admin/share-settings`,
    jsonRequest({ ...DEFAULT_SHARE_SETTINGS, ...patch }, withCookie(adminCookie, { method: 'PUT' })),
  )
  expect(response.status).toBe(200)
  return (await response.json() as { settings: ShareSettings }).settings
}

async function createShare(cookie: string, body: Record<string, unknown>): Promise<{ share: ShareView, token: string }> {
  const response = await exports.default.fetch(`${TEST_ORIGIN}/api/shares`, jsonRequest(body, withCookie(cookie)))
  expect(response.status).toBe(201)
  return response.json() as Promise<{ share: ShareView, token: string }>
}

async function listShares(cookie: string): Promise<ShareView[]> {
  const response = await exports.default.fetch(`${TEST_ORIGIN}/api/shares`, withCookie(cookie))
  expect(response.status).toBe(200)
  return (await response.json() as { shares: ShareView[] }).shares
}

describe('Share backend', () => {
  it('rejects shares past the policy caps and expiry window', async () => {
    const admin = await login()
    expect(await env.DATA.get('state:share-settings')).toBeNull()
    const defaults = await exports.default.fetch(`${TEST_ORIGIN}/api/admin/share-settings`, withCookie(admin))
    expect(defaults.status).toBe(200)
    expect(await defaults.json()).toEqual({ settings: DEFAULT_SHARE_SETTINGS })
    expect(await env.DATA.get('state:share-settings')).toBeNull()

    const owner = await provisionUser(admin, 'share-user', 'share user password')
    const groupId = await createGroup(admin, 'Share group', 'Hong Kong 01', 'hk.example.com')
    const subscriptionId = await createSubscription(admin, owner.id, groupId, 'Share sub')
    const disabledId = await createSubscription(admin, owner.id, groupId, 'Disabled sub', false)
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares`, jsonRequest({ subscriptionId: disabledId }, withCookie(owner.cookie))),
      409,
      'SUBSCRIPTION_UNAVAILABLE',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares`, jsonRequest({ subscriptionId }, withCookie(admin))),
      404,
      'SUBSCRIPTION_NOT_FOUND',
    )
    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/shares`), 401, 'AUTH_REQUIRED')

    const created = await createShare(owner.cookie, { subscriptionId, remark: 'first' })
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(created.share.tokenPrefix).toBe(created.token.slice(0, 8))
    expect(created.share.accessControl).toBe('none')
    expect(created.share.allowOriginalLink).toBe(false)
    const lifetime = Date.parse(created.share.expiresAt) - Date.now()
    expect(lifetime).toBeGreaterThan(89 * 86_400_000)
    expect(lifetime).toBeLessThanOrEqual(90 * 86_400_000 + 5_000)
    const listed = await listShares(owner.cookie)
    expect(listed.map((share) => share.id)).toEqual([created.share.id])
    expect(JSON.stringify(listed)).not.toContain(created.token)
    expect(JSON.stringify(listed)).not.toContain('passwordHash')
    expect(JSON.stringify(listed)).not.toContain('tokenEncrypted')

    const adminList = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/shares?user=${owner.id}&subscription=${subscriptionId}&status=active`,
      withCookie(admin),
    )
    expect(adminList.status).toBe(200)
    expect(await adminList.json()).toEqual({ shares: [created.share] })
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/admin/shares?status=nope`, withCookie(admin)),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/admin/share-settings`, withCookie(owner.cookie)),
      403,
      'ADMIN_REQUIRED',
    )

    await putSettings(admin, { maxSharesPerSubscription: 1 })
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares`, jsonRequest({ subscriptionId }, withCookie(owner.cookie))),
      409,
      'SHARE_LIMIT_REACHED',
    )

    const secondSubscription = await createSubscription(admin, owner.id, groupId, 'Second sub')
    await putSettings(admin, { maxSharesPerSubscription: 5, maxActiveSharesPerUser: 1 })
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares`, jsonRequest({ subscriptionId: secondSubscription }, withCookie(owner.cookie))),
      409,
      'SHARE_LIMIT_REACHED',
    )

    await putSettings(admin, { maxValidityDays: 1 })
    const tooFar = new Date(Date.now() + 2 * 86_400_000).toISOString()
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares`,
        jsonRequest({ subscriptionId: secondSubscription, expiresAt: tooFar }, withCookie(owner.cookie)),
      ),
      422,
      'SHARE_EXPIRY_INVALID',
    )
    const soon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    const shortLived = await createShare(owner.cookie, { subscriptionId: secondSubscription, expiresAt: soon })
    expect(shortLived.share.expiresAt).toBe(soon)

    const storedBase = await putSettings(admin, { publicBaseUrl: 'https://share.example.com/' })
    expect(storedBase.publicBaseUrl).toBe('https://share.example.com')
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/admin/share-settings`,
        jsonRequest({ ...DEFAULT_SHARE_SETTINGS, publicBaseUrl: 'ftp://share.example.com' }, withCookie(admin, { method: 'PUT' })),
      ),
      422,
      'VALIDATION_FAILED',
    )

    await putSettings(admin, { createAllowed: false })
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares`,
        jsonRequest({ subscriptionId: secondSubscription, expiresAt: soon }, withCookie(owner.cookie)),
      ),
      403,
      'SHARE_CREATE_DISABLED',
    )
    await putSettings(admin, { enabled: false })
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares`,
        jsonRequest({ subscriptionId: secondSubscription, expiresAt: soon }, withCookie(owner.cookie)),
      ),
      403,
      'SHARE_DISABLED',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/export?client=generic`),
      404,
      'SHARE_NOT_FOUND',
    )
  })

  it('gates meta and export on password, login, and access count', async () => {
    const admin = await login()
    const owner = await provisionUser(admin, 'share-user', 'share user password')
    const groupId = await createGroup(admin, 'Share group', 'Hong Kong 01', 'hk.example.com')
    const subscriptionId = await createSubscription(admin, owner.id, groupId, 'Share sub')
    const created = await createShare(owner.cookie, {
      subscriptionId,
      password: 'share-secret',
      accessControl: 'password',
      allowOriginalLink: false,
      showSubscriptionName: true,
      showGroups: true,
      showExpiry: true,
      showNodeNames: true,
      maxAccessCount: 1,
    })

    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/meta`), 404, 'SHARE_NOT_FOUND')
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/export?client=mihomo`),
      404,
      'SHARE_NOT_FOUND',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/export?type=link`),
      404,
      'SHARE_NOT_FOUND',
    )
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares/${created.token}/verify`,
        jsonRequest({ password: 'wrong-password' }),
      ),
      401,
      'SHARE_PASSWORD_INVALID',
    )

    const verified = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${created.token}/verify`,
      jsonRequest({ password: 'share-secret' }),
    )
    expect(verified.status).toBe(200)
    expect((await verified.json() as { verified: boolean }).verified).toBe(true)
    const shareCookie = cookiePair(verified, 'subpanel_share')
    expect(verified.headers.get('set-cookie')?.toLowerCase()).toContain('httponly')
    expect(verified.headers.get('set-cookie')).toContain('Path=/api/shares/')

    const meta = await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/meta`, { headers: { cookie: shareCookie } })
    expect(meta.status).toBe(200)
    const metaBody = await meta.json() as { meta: Record<string, unknown> }
    expect(metaBody.meta).toEqual({
      subscriptionName: 'Share sub',
      groupNames: ['Share group'],
      expiresAt: created.share.expiresAt,
      nodeCount: 1,
      nodeNames: ['Hong Kong 01'],
    })
    const metaJson = JSON.stringify(metaBody)
    expect(metaJson).not.toContain('hk.example.com')
    expect(metaJson).not.toContain(created.token)
    expect(metaJson).not.toContain('usr_')
    expect((await listShares(owner.cookie))[0].accessCount).toBe(0)

    const exported = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${created.token}/export?client=clash`,
      { headers: { cookie: shareCookie } },
    )
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toContain('yaml')
    expect(await exported.text()).toContain('hk.example.com')
    expect((await listShares(owner.cookie))[0]).toMatchObject({ accessCount: 1, maxAccessCount: 1 })
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/export?client=mihomo`, { headers: { cookie: shareCookie } }),
      404,
      'SHARE_NOT_FOUND',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/meta`, { headers: { cookie: shareCookie } }),
      404,
      'SHARE_NOT_FOUND',
    )

    const open = await createShare(owner.cookie, { subscriptionId, showNodeNames: false })
    const openMeta = await (await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${open.token}/meta`)).json() as { meta: Record<string, unknown> }
    expect(openMeta.meta).toEqual({ nodeCount: 1 })

    await putSettings(admin, { requireLoginDefault: true })
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares/${open.token}/verify`,
        jsonRequest({ password: 'share-secret' }),
      ),
      401,
      'AUTH_REQUIRED',
    )
    const loggedInVerify = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${open.token}/verify`,
      jsonRequest({}, withCookie(owner.cookie)),
    )
    expect(loggedInVerify.status).toBe(400)
    expect((await loggedInVerify.json() as ErrorBody).error.code).toBe('SHARE_PASSWORD_NOT_REQUIRED')
    await expectError(await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${open.token}/export?client=generic`), 404, 'SHARE_NOT_FOUND')
    const loggedInExport = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${open.token}/export?client=generic`,
      withCookie(owner.cookie),
    )
    expect(loggedInExport.status).toBe(200)

    const both = await createShare(owner.cookie, {
      subscriptionId,
      password: 'share-secret',
      accessControl: 'password',
      requireLogin: true,
    })
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${both.token}/verify`, jsonRequest({ password: 'share-secret' })),
      401,
      'AUTH_REQUIRED',
    )
    const bothVerified = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${both.token}/verify`,
      jsonRequest({ password: 'share-secret' }, withCookie(owner.cookie)),
    )
    expect(bothVerified.status).toBe(200)
    const bothCookie = cookiePair(bothVerified, 'subpanel_share')
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${both.token}/export?client=generic`, { headers: { cookie: bothCookie } }),
      404,
      'SHARE_NOT_FOUND',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${both.token}/export?client=generic`, withCookie(owner.cookie)),
      404,
      'SHARE_NOT_FOUND',
    )
    const bothExport = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${both.token}/export?client=generic`,
      { headers: { cookie: `${owner.cookie}; ${bothCookie}` } },
    )
    expect(bothExport.status).toBe(200)
  })

  it('invalidates a reset token and hides unauthorized exports', async () => {
    const admin = await login()
    const owner = await provisionUser(admin, 'share-user', 'share user password')
    const peer = await provisionUser(admin, 'share-peer', 'share peer password')
    const groupId = await createGroup(admin, 'Share group', 'Hong Kong 01', 'hk.example.com')
    const subscriptionId = await createSubscription(admin, owner.id, groupId, 'Share sub')
    const created = await createShare(owner.cookie, { subscriptionId, allowOriginalLink: true })

    const firstExport = await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/export?client=generic`)
    expect(firstExport.status).toBe(200)
    const reset = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${created.share.id}/reset-token`,
      jsonRequest({}, withCookie(owner.cookie)),
    )
    expect(reset.status).toBe(200)
    const rotated = await reset.json() as { share: ShareView, token: string }
    expect(rotated.token).not.toBe(created.token)
    expect(rotated.share.id).toBe(created.share.id)
    expect(rotated.share.tokenPrefix).toBe(rotated.token.slice(0, 8))
    expect(JSON.stringify(await listShares(owner.cookie))).not.toContain(rotated.token)
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/export?client=generic`),
      404,
      'SHARE_NOT_FOUND',
    )
    expect((await env.DATA.list({ prefix: `compiled:share:${await hashToken(created.token)}:` })).keys).toHaveLength(0)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${rotated.token}/export?client=generic`)).status).toBe(200)

    const expiredHash = await hashToken(rotated.token)
    const stored = JSON.parse(await env.DATA.get(shareEntityKey(expiredHash)) ?? '{}') as { expiresAt: string }
    stored.expiresAt = new Date(Date.now() - 1_000).toISOString()
    await env.DATA.put(shareEntityKey(expiredHash), JSON.stringify(stored))
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${rotated.token}/export?client=generic`),
      404,
      'SHARE_NOT_FOUND',
    )

    const fresh = await createShare(owner.cookie, { subscriptionId })
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${fresh.token}/export?type=link`),
      404,
      'SHARE_NOT_FOUND',
    )
    expect((await listShares(owner.cookie)).find((share) => share.id === fresh.share.id)?.accessCount).toBe(0)
    const updated = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${fresh.share.id}`,
      jsonRequest({ allowOriginalLink: true, showSubscriptionName: true }, withCookie(owner.cookie, { method: 'PUT' })),
    )
    expect(updated.status).toBe(200)
    expect(JSON.stringify(await updated.json())).not.toContain(fresh.token)
    const revealed = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${fresh.share.id}/reveal`,
      jsonRequest({}, withCookie(owner.cookie)),
    )
    expect(revealed.status).toBe(200)
    const link = (await revealed.json() as { link: string }).link
    expect(link).toContain('/sub/')
    expect((await exports.default.fetch(link)).status).toBe(200)
    expect((await listShares(owner.cookie)).find((share) => share.id === fresh.share.id)?.lastOriginalRevealAt).toEqual(expect.any(String))
    const linkExport = await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${fresh.token}/export?type=link`)
    expect(linkExport.status).toBe(200)
    expect(await linkExport.json()).toEqual({ link })

    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/not-a-share-token/export?client=generic`),
      404,
      'SHARE_NOT_FOUND',
    )
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares/${fresh.share.id}`,
        jsonRequest({ remark: 'stolen' }, withCookie(peer.cookie, { method: 'PUT' })),
      ),
      404,
      'SHARE_NOT_FOUND',
    )
    expect((await listShares(peer.cookie))).toEqual([])

    const disabled = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/shares/${fresh.share.id}/disable`,
      jsonRequest({}, withCookie(admin)),
    )
    expect(disabled.status).toBe(200)
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${fresh.token}/export?client=generic`),
      404,
      'SHARE_NOT_FOUND',
    )
    const enabled = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${fresh.share.id}/enable`,
      jsonRequest({}, withCookie(owner.cookie)),
    )
    expect(enabled.status).toBe(200)
    expect((await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${fresh.token}/export?client=generic`)).status).toBe(200)

    const revoked = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${fresh.share.id}/revoke`,
      jsonRequest({}, withCookie(owner.cookie)),
    )
    expect(revoked.status).toBe(200)
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${fresh.token}/export?client=generic`),
      404,
      'SHARE_NOT_FOUND',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${fresh.share.id}/enable`, jsonRequest({}, withCookie(owner.cookie))),
      409,
      'SHARE_REVOKED',
    )
    const removed = await exports.default.fetch(
      `${TEST_ORIGIN}/api/shares/${fresh.share.id}`,
      withCookie(owner.cookie, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }),
    )
    expect(removed.status).toBe(204)
    expect(await env.DATA.get(shareEntityKey(await hashToken(fresh.token)))).toBeNull()
    expect((await listShares(owner.cookie)).some((share) => share.id === fresh.share.id)).toBe(false)
  })

  it('stops password guesses after 10 attempts in 10 minutes', async () => {
    const admin = await login()
    const owner = await provisionUser(admin, 'share-user', 'share user password')
    const groupId = await createGroup(admin, 'Share group', 'Hong Kong 01', 'hk.example.com')
    const subscriptionId = await createSubscription(admin, owner.id, groupId, 'Share sub')
    const created = await createShare(owner.cookie, { subscriptionId, password: 'share-secret', accessControl: 'password' })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares/${created.token}/verify`,
        jsonRequest({ password: `wrong-password-${attempt}` }),
      )
      expect(response.status, `attempt ${attempt}`).toBe(401)
    }
    await expectError(
      await exports.default.fetch(
        `${TEST_ORIGIN}/api/shares/${created.token}/verify`,
        jsonRequest({ password: 'share-secret' }),
      ),
      429,
      'SHARE_RATE_LIMITED',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/meta`),
      404,
      'SHARE_NOT_FOUND',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/shares/${created.token}/export?client=generic`),
      404,
      'SHARE_NOT_FOUND',
    )
  }, 30_000)
})
