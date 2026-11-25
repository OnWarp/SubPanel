import { bindFixtureTemplate, setupContractedAdmin } from './helpers'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../../worker/accounts/password'
import { readAccounts, writeAccounts } from '../../../worker/accounts/repository'
import type { AccountUser } from '../../../worker/accounts/schema'
import {
  ACCOUNTS_D1_READY_KEY,
} from '../../../worker/db/module-switch'
import { readDeliveryKv, writeDeliveryKv } from '../../../worker/delivery/repository'
import {
  addIndexHashKv,
  readShareKv,
  subscriptionIndexKey,
  userIndexKey,
  writeShareKv,
} from '../../../worker/shares/repository'
import type { ShareRecord } from '../../../worker/shares/schema'
import {
  jsonRequest,
  login,
  setupAdmin,
  TEST_ORIGIN,
  withCookie,
} from './helpers'

const NOW = '2026-01-01T00:00:00.000Z'
const ENCRYPTED = '{"version":1,"algorithm":"AES-GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}'

type ErrorBody = { error: { code: string, message: string } }
type UserBody = {
  user: {
    id: string
    username: string
    role: string
    enabled: boolean
    email?: string | null
    deletedAt: string | null
    subscriptionCount?: number
  }
}
type ListBody = { users: UserBody['user'][], total: number, page: number, pageSize: number }

const fetchApi = (path: string, init: RequestInit = {}) => exports.default.fetch(`${TEST_ORIGIN}${path}`, init)

const adminCall = (cookie: string, path: string, init: RequestInit = {}) =>
  fetchApi(path, withCookie(cookie, init))

// Mutations without a JSON body still need the Origin header for the
// origin guard; jsonRequest normally supplies it.
const deleteCall = (cookie: string, path: string) =>
  adminCall(cookie, path, { method: 'DELETE', headers: { origin: TEST_ORIGIN } })

// The accounts snapshot write deliberately never touches the email columns
// (batch 4 rule); bound emails land in D1 through the binding flow, which
// this mirrors.
async function bindEmailD1(userId: string, email: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET email = ?, email_normalized = ?, email_verified_at = ? WHERE id = ?',
  ).bind(email, email.toLowerCase(), new Date().toISOString(), userId).run()
}

async function listUsers(cookie: string, query = ''): Promise<{ status: number, body: ListBody }> {
  const response = await adminCall(cookie, `/api/admin/users${query}`)
  return { status: response.status, body: await response.json() as ListBody }
}

async function createAccountUser(
  username: string,
  password: string,
  options: { email?: string, enabled?: boolean } = {},
): Promise<AccountUser> {
  const accounts = await readAccounts(env)
  const now = new Date().toISOString()
  const user: AccountUser = {
    id: `usr_${accounts.nextUserId}`,
    username,
    role: 'user',
    enabled: options.enabled ?? true,
    password: await hashPassword(password),
    sessionVersion: 0,
    deletedAt: null,
    email: options.email ?? null,
    emailNormalized: options.email ? options.email.toLowerCase() : null,
    emailVerifiedAt: options.email ? now : null,
    createdAt: now,
    updatedAt: now,
  }
  await writeAccounts(env, {
    ...accounts,
    nextUserId: accounts.nextUserId + 1,
    users: [...accounts.users, user],
  }, now)
  return user
}

async function seedGroup(id: string): Promise<void> {
  await env.DB.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, `Group ${id}`, NOW, NOW).run()
}

async function seedSubscription(id: string, userId: string, name = 'Seeded'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO legacy_subscriptions_archive (
       id, user_id, name, token_hash, token_prefix, encrypted_token, enabled,
       default_client, revision, starts_at, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, 'mihomo', 1, NULL, NULL, ?, ?)`,
  ).bind(id, userId, name, `hash-${id}`, `pre-${id}`, ENCRYPTED, NOW, NOW).run()
}

async function countRows(sql: string, ...binds: Array<string>): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function wipeModuleTables(): Promise<void> {
  for (const table of [
    'subscription_groups', 'shares', 'legacy_subscriptions_archive', 'invitation_redemptions',
    'invitations', 'groups', 'email_verifications', 'email_change_requests', 'rate_limits',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run()
  }
}

describe('D1 admin user management (batch 8)', () => {
  beforeEach(async () => {
    await setupContractedAdmin()
    await wipeModuleTables()
  })

  it('lists users with search, filters, pagination and aggregated subscription counts', async () => {
    const admin = await login()
    const alice = await createAccountUser('alice', 'alice password 1', { email: 'Alice@Example.com' })
    await bindEmailD1(alice.id, 'Alice@Example.com')
    const bob = await createAccountUser('bob', 'bob password 123')
    await createAccountUser('carol', 'carol password 1')
    await seedGroup('grp_1')
    await bindFixtureTemplate(alice.id, { name: 'Alice main', groupIds: ['grp_1'] })
    await bindFixtureTemplate(alice.id, { name: 'Alice backup', groupIds: ['grp_1'] })
    await bindFixtureTemplate(bob.id, { name: 'Bob template', groupIds: ['grp_1'] })
    await env.DB.prepare('UPDATE users SET enabled=0 WHERE id=?').bind(bob.id).run()

    const all = await listUsers(admin)
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(4)
    expect(all.body.users).toHaveLength(4)
    const aliceRow = all.body.users.find((user) => user.username === 'alice')!
    expect(aliceRow.subscriptionCount).toBe(2)
    expect(aliceRow.email).toBe('Alice@Example.com')
    expect(aliceRow.deletedAt).toBeNull()
    expect(all.body.users.find((user) => user.username === 'bob')!.subscriptionCount).toBe(1)
    expect(all.body.users.find((user) => user.username === 'carol')!.subscriptionCount).toBe(0)

    expect((await listUsers(admin, '?q=alice@example')).body.total).toBe(1)
    expect((await listUsers(admin, '?q=ALI')).body.total).toBe(1)
    expect((await listUsers(admin, '?role=admin')).body.users.map((user) => user.username)).toEqual(['admin'])
    expect((await listUsers(admin, '?status=disabled')).body.users.map((user) => user.username)).toEqual(['bob'])

    const pageTwo = await listUsers(admin, '?pageSize=2&page=2')
    expect(pageTwo.body.total).toBe(4)
    expect(pageTwo.body.users).toHaveLength(2)
    expect(pageTwo.body.page).toBe(2)

    const detailResponse = await adminCall(admin, `/api/admin/users/${alice.id}`)
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json() as {
      user: UserBody['user']
      subscriptions: Array<{ id: string, groupIds: string[] }>
      invitationRedemptions: Array<{ invitationUsername: string }>
    }
    expect(detail.user.subscriptionCount).toBe(2)
    expect(detail.subscriptions).toEqual([])

    await env.DB.prepare(
      `INSERT INTO invitations (id, schema_version, user_id, username, created_at, expires_at)
       VALUES ('inv_1', 1, ?, 'alice', ?, '2027-01-01T00:00:00.000Z')`,
    ).bind(alice.id, NOW).run()
    await env.DB.prepare(
      'INSERT INTO invitation_redemptions (invitation_id, user_id, redeemed_at) VALUES (?, ?, ?)',
    ).bind('inv_1', alice.id, NOW).run()
    const detailAfter = await (await adminCall(admin, `/api/admin/users/${alice.id}`)).json() as typeof detail
    expect(detailAfter.invitationRedemptions).toHaveLength(1)
    expect(detailAfter.invitationRedemptions[0].invitationUsername).toBe('alice')

    const missing = await adminCall(admin, '/api/admin/users/usr_999')
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as ErrorBody).error.code).toBe('USER_NOT_FOUND')
  })

  it('directly sets trusted email and enables immediate email login without sending codes', async () => {
    const admin = await login()
    const alice = await createAccountUser('alice', 'alice password 1')
    await bindEmailD1(alice.id, 'old@example.com')
    const before = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(alice.id).first()
    const response = await adminCall(admin, `/api/admin/users/${alice.id}`, jsonRequest({ email: ' New@Outside.example ' }, { method: 'PATCH' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { email: 'new@outside.example', role: 'user' } })
    const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(alice.id).first()
    expect(after).toMatchObject({ ...before, email: 'new@outside.example', email_normalized: 'new@outside.example', email_verified_at: expect.any(String), updated_at: expect.any(String) })
    await login('new@outside.example', 'alice password 1')
    expect((await fetchApi('/api/login', jsonRequest({ username: 'old@example.com', password: 'alice password 1' }))).status).toBe(401)
    expect(await countRows('SELECT COUNT(*) AS count FROM email_verifications WHERE user_id = ?', alice.id)).toBe(0)
    expect(await countRows("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'patch.users'", alice.id)).toBe(1)
  })

  it('allows editing another administrator, self and the unchanged address', async () => {
    const admin = await login()
    // The sole administrator may edit their own email.
    expect((await adminCall(admin, '/api/admin/users/usr_1', jsonRequest({ email: 'self@outside.example' }, { method: 'PATCH' }))).status).toBe(200)
    await login('self@outside.example', 'correct horse battery staple')
    const alice = await createAccountUser('alice', 'alice password 1')
    expect((await adminCall(admin, `/api/admin/users/${alice.id}`, jsonRequest({ role: 'admin', email: 'other@outside.example' }, { method: 'PATCH' }))).status).toBe(200)
    await login('other@outside.example', 'alice password 1')
    expect((await adminCall(admin, `/api/admin/users/${alice.id}`, jsonRequest({ email: 'OTHER@outside.example' }, { method: 'PATCH' }))).status).toBe(200)
  })

  it('rejects email edits from a non-administrator', async () => {
    await createAccountUser('alice', 'alice password 1')
    const cookie = await login('alice', 'alice password 1')
    expect((await adminCall(cookie, '/api/admin/users/usr_1', jsonRequest({ email: 'forbidden@example.com' }, { method: 'PATCH' }))).status).toBe(403)
  })

  it('rejects another account current email, including deleted accounts', async () => {
    const admin = await login()
    const alice = await createAccountUser('alice', 'alice password 1')
    await bindEmailD1(alice.id, 'taken@example.com')
    for (const deleted of [false, true]) {
      if (deleted) await deleteCall(admin, `/api/admin/users/${alice.id}`)
      const response = await adminCall(admin, '/api/admin/users/usr_1', jsonRequest({ email: 'TAKEN@example.com' }, { method: 'PATCH' }))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } })
    }
  })

  it('rejects invalid email format without changing the account', async () => {
    const admin = await login()
    const response = await adminCall(admin, '/api/admin/users/usr_1', jsonRequest({ email: 'invalid' }, { method: 'PATCH' }))
    expect(response.status).toBe(422)
    expect((await listUsers(admin)).body.users[0].email).toBeNull()
  })

  it('protects the last administrator from demotion, disable and deletion', async () => {
    const admin = await login()
    for (const [init, label] of [
      [jsonRequest({ enabled: false }, { method: 'PATCH' }), 'disable'],
      [jsonRequest({ role: 'user' }, { method: 'PATCH' }), 'demote'],
    ] as Array<[RequestInit, string]>) {
      const response = await adminCall(admin, '/api/admin/users/usr_1', init)
      expect(response.status, label).toBe(409)
      expect(((await response.json()) as ErrorBody).error.code, label).toBe('LAST_ADMIN')
    }
    const deleteAdmin = await deleteCall(admin, '/api/admin/users/usr_1')
    expect(deleteAdmin.status).toBe(409)
    expect(((await deleteAdmin.json()) as ErrorBody).error.code).toBe('LAST_ADMIN')
    const empty = await adminCall(admin, '/api/admin/users/usr_1', jsonRequest({}, { method: 'PATCH' }))
    expect(empty.status).toBe(400)

    const listed = await listUsers(admin, '?role=admin')
    expect(listed.body.total).toBe(1)
    expect(listed.body.users[0].enabled).toBe(true)
  })

  it('promotes a second administrator without disturbing the first, and the last one stays protected', async () => {
    const admin = await login()
    const alice = await createAccountUser('alice', 'alice password 1')
    const aliceCookie = await login('alice', 'alice password 1')

    const promoted = await adminCall(admin, `/api/admin/users/${alice.id}`, jsonRequest({ role: 'admin' }, { method: 'PATCH' }))
    expect(promoted.status).toBe(200)
    expect(((await promoted.json()) as UserBody).user.role).toBe('admin')

    // Plain promotion: the existing administrator keeps role and session;
    // only the promoted user's own session rotates with the privilege change.
    expect((await adminCall(admin, '/api/admin/users')).status).toBe(200)
    expect((await fetchApi('/api/account', withCookie(aliceCookie))).status).toBe(401)

    const aliceAdmin = await login('alice', 'alice password 1')
    expect((await adminCall(aliceAdmin, '/api/admin/users')).status).toBe(200)
    const listed = await listUsers(admin, '?role=admin')
    expect(listed.body.total).toBe(2)

    // With two administrators, demoting one is fine; the survivor is the
    // last administrator and is protected from demotion again.
    const demoted = await adminCall(aliceAdmin, '/api/admin/users/usr_1', jsonRequest({ role: 'user' }, { method: 'PATCH' }))
    expect(demoted.status).toBe(200)
    const lastAgain = await adminCall(aliceAdmin, `/api/admin/users/${alice.id}`, jsonRequest({ role: 'user' }, { method: 'PATCH' }))
    expect(lastAgain.status).toBe(409)
    expect(((await lastAgain.json()) as ErrorBody).error.code).toBe('LAST_ADMIN')
  })

  it('soft delete blocks login, sessions and public delivery until restored', async () => {
    const admin = await login()
    const dave = await createAccountUser('dave', 'dave password 12')
    const daveCookie = await login('dave', 'dave password 12')

    const sourceResponse = await adminCall(admin, '/api/admin/catalog/sources', jsonRequest({
      type: 'manual',
      name: 'Dave source',
      content: `ss://${btoa('aes-128-gcm:password')}@ss.example.com:8388#${encodeURIComponent('Dave node')}`,
    }))
    const sourceId = ((await sourceResponse.json()) as { source: { id: string } }).source.id
    const catalog = await (await adminCall(admin, '/api/admin/catalog')).json() as { nodes: Array<{ id: string }> }
    const groupResponse = await adminCall(admin, '/api/admin/catalog/groups', jsonRequest({
      name: 'Dave group', sourceIds: [sourceId], includedNodeIds: [], excludedNodeIds: [], nodeOrder: [catalog.nodes[0].id],
    }))
    const groupId = ((await groupResponse.json()) as { group: { id: string } }).group.id
    await bindFixtureTemplate(dave.id, { name: 'Dave access', groupIds: [groupId] })
    const summary = await fetchApi('/api/user/subscription', withCookie(daveCookie))
    const { subscriptionUrl } = await summary.json<{ subscriptionUrl: string }>()
    const download = new URL(subscriptionUrl).pathname + '/mihomo'
    expect((await fetchApi(download)).status).toBe(200)

    const deleted = await deleteCall(admin, `/api/admin/users/${dave.id}`)
    expect(deleted.status).toBe(200)
    expect(((await deleted.json()) as UserBody).user.deletedAt).not.toBeNull()

    const loginResponse = await fetchApi('/api/login', jsonRequest({ username: 'dave', password: 'dave password 12' }))
    expect(loginResponse.status).toBe(401)
    expect((await fetchApi('/api/account', withCookie(daveCookie))).status).toBe(401)
    expect((await fetchApi(download)).status).toBe(404)

    const active = await listUsers(admin)
    expect(active.body.users.some((user) => user.id === dave.id)).toBe(false)
    const trash = await listUsers(admin, '?deleted=only')
    expect(trash.body.users.map((user) => user.id)).toEqual([dave.id])
    const everything = await listUsers(admin, '?deleted=all')
    expect(everything.body.users.some((user) => user.id === dave.id)).toBe(true)

    const invite = await adminCall(admin, '/api/admin/invites', jsonRequest({}))
    expect(invite.status).toBe(201)

    const deletedAgain = await deleteCall(admin, `/api/admin/users/${dave.id}`)
    expect(deletedAgain.status).toBe(409)
    expect(((await deletedAgain.json()) as ErrorBody).error.code).toBe('USER_ALREADY_DELETED')

    const restored = await adminCall(admin, `/api/admin/users/${dave.id}/restore`, jsonRequest({}))
    expect(restored.status).toBe(200)
    expect(((await restored.json()) as UserBody).user.deletedAt).toBeNull()
    await login('dave', 'dave password 12')
    expect((await fetchApi(download)).status).toBe(200)
  })

  it('purge removes every dependent record across D1 and KV and releases the username', async () => {
    const admin = await login()
    const erin = await createAccountUser('erin', 'erin password 12', { email: 'erin@example.com' })
    await bindEmailD1(erin.id, 'erin@example.com')
    const frank = await createAccountUser('frank', 'frank password 1')

    await seedGroup('grp_1')
    await env.DB.prepare(
      `INSERT INTO shares (
         id, schema_version, owner_user_id, subscription_id, token_hash, token_prefix,
         token_encrypted, remark, status, access_mode, expires_at, allow_original_link,
         show_subscription_name, show_groups, show_expiry, show_node_names, require_login,
         access_count, created_at, updated_at
       ) VALUES ('shr_1', 1, ?, 'sub_21', ?, 'ShrPrefx', ?, '', 'active', 'none',
         '2027-01-01T00:00:00.000Z', 0, 1, 1, 1, 1, 0, 0, ?, ?)`,
    ).bind(erin.id, 'D'.repeat(43), ENCRYPTED, NOW, NOW).run()
    await env.DB.prepare(
      `INSERT INTO invitations (id, schema_version, user_id, username, created_at, expires_at)
       VALUES ('inv_e', 1, ?, 'erin-peer', ?, '2027-01-01T00:00:00.000Z')`,
    ).bind(erin.id, NOW).run()
    await env.DB.prepare(
      'INSERT INTO invitation_redemptions (invitation_id, user_id, redeemed_at) VALUES (?, ?, ?)',
    ).bind('inv_e', frank.id, NOW).run()
    await env.DB.prepare(
      `INSERT INTO invitations (id, schema_version, user_id, username, created_at, expires_at)
       VALUES ('inv_f', 1, ?, 'frank-peer', ?, '2027-01-01T00:00:00.000Z')`,
    ).bind(frank.id, NOW).run()
    await env.DB.prepare(
      'INSERT INTO invitation_redemptions (invitation_id, user_id, redeemed_at) VALUES (?, ?, ?)',
    ).bind('inv_f', erin.id, NOW).run()
    await env.DB.prepare(
      `INSERT INTO email_verifications (user_id, email, email_normalized, token_hash, expires_at, created_at)
       VALUES (?, 'erin@example.com', 'erin@example.com', ?, '2027-01-01T00:00:00.000Z', ?)`,
    ).bind(erin.id, 'V'.repeat(43), NOW).run()
    await env.DB.prepare(
      'INSERT INTO rate_limits (bucket, subject, window_start, count) VALUES (?, ?, 0, 3)',
    ).bind('login', 'erin').run()
    await env.DB.prepare(
      'INSERT INTO rate_limits (bucket, subject, window_start, count) VALUES (?, ?, 0, 2)',
    ).bind('login', 'erin@example.com').run()

    // KV-side delivery subscription + compiled artifact + share record.
    const kvTokenHash = 'K'.repeat(43)
    await writeDeliveryKv(env.DATA, {
      schemaVersion: 1,
      revision: 0,
      updatedAt: NOW,
      nextSubscriptionId: 32,
      subscriptions: [{
        id: 'sub_31',
        userId: erin.id,
        name: 'Erin KV sub',
        groupIds: [],
        tokenHash: kvTokenHash,
        tokenPrefix: 'KvPrefx1',
        encryptedToken: { version: 1, algorithm: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(24) },
        enabled: true,
        defaultClient: 'mihomo',
        revision: 1,
        startsAt: null,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }, NOW)
    await env.DATA.put(`compiled:${kvTokenHash}:mihomo`, 'compiled-body')
    const kvShare: ShareRecord = {
      schemaVersion: 1,
      id: 'shr_9',
      ownerUserId: erin.id,
      subscriptionId: 'sub_31',
      tokenHash: 'S'.repeat(43),
      tokenPrefix: 'ShrPref9',
      tokenEncrypted: { version: 1, algorithm: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(24) },
      remark: '',
      status: 'active',
      accessControl: { mode: 'none' },
      expiresAt: '2027-01-01T00:00:00.000Z',
      allowOriginalLink: false,
      showSubscriptionName: true,
      showGroups: true,
      showExpiry: true,
      showNodeNames: true,
      requireLogin: false,
      maxAccessCount: null,
      accessCount: 0,
      lastAccessedAt: null,
      lastOriginalRevealAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    await writeShareKv(env.DATA, kvShare)
    await addIndexHashKv(env.DATA, userIndexKey(erin.id), kvShare.tokenHash)
    await addIndexHashKv(env.DATA, subscriptionIndexKey('sub_31'), kvShare.tokenHash)

    const earlyPurge = await adminCall(admin, `/api/admin/users/${erin.id}/purge`, jsonRequest({}))
    expect(earlyPurge.status).toBe(409)
    expect(((await earlyPurge.json()) as ErrorBody).error.code).toBe('USER_NOT_DELETED')

    expect((await deleteCall(admin, `/api/admin/users/${erin.id}`)).status).toBe(200)
    const purged = await adminCall(admin, `/api/admin/users/${erin.id}/purge`, jsonRequest({}))
    expect(purged.status).toBe(200)
    expect(await purged.json()).toMatchObject({ purged: true, userId: erin.id })

    expect(await countRows('SELECT COUNT(*) AS count FROM users WHERE id = ?', erin.id)).toBe(0)
    expect(await countRows('SELECT COUNT(*) AS count FROM shares WHERE owner_user_id = ?', erin.id)).toBe(0)
    expect(await countRows('SELECT COUNT(*) AS count FROM invitations WHERE user_id = ?', erin.id)).toBe(0)
    expect(await countRows('SELECT COUNT(*) AS count FROM invitation_redemptions WHERE invitation_id = ?', 'inv_e')).toBe(0)
    expect(await countRows('SELECT COUNT(*) AS count FROM invitation_redemptions WHERE user_id = ?', erin.id)).toBe(0)
    expect(await countRows('SELECT COUNT(*) AS count FROM invitations WHERE id = ?', 'inv_f')).toBe(1)
    expect(await countRows('SELECT COUNT(*) AS count FROM users WHERE id = ?', frank.id)).toBe(1)
    expect(await countRows('SELECT COUNT(*) AS count FROM email_verifications WHERE user_id = ?', erin.id)).toBe(0)
    expect(await countRows(
      'SELECT COUNT(*) AS count FROM rate_limits WHERE subject IN (?, ?)', 'erin', 'erin@example.com',
    )).toBe(0)

    const delivery = await readDeliveryKv(env.DATA)
    expect(delivery.subscriptions.some((subscription) => subscription.userId === erin.id)).toBe(false)
    expect(await env.DATA.get(`compiled:${kvTokenHash}:mihomo`)).toBeNull()
    expect(await readShareKv(env.DATA, kvShare.tokenHash)).toBeNull()

    const purgedAgain = await adminCall(admin, `/api/admin/users/${erin.id}/purge`, jsonRequest({}))
    expect(purgedAgain.status).toBe(404)

    const invite = await adminCall(admin, '/api/admin/invites', jsonRequest({ username: 'erin' }))
    expect(invite.status).toBe(201)
  })

  it('keeps accounts with archived subscription history in the recycle bin', async () => {
    const admin = await login()
    const account = await createAccountUser('historical', 'historical password')
    await seedSubscription('sub_archived', account.id)
    expect((await deleteCall(admin, `/api/admin/users/${account.id}`)).status).toBe(200)
    const purge = await adminCall(admin, `/api/admin/users/${account.id}/purge`, jsonRequest({}))
    expect(purge.status).toBe(409)
    expect(await purge.json()).toMatchObject({ error: { code: 'USER_SUBSCRIPTION_HISTORY_RETAINED' } })
    expect(await countRows('SELECT COUNT(*) AS count FROM legacy_subscriptions_archive WHERE user_id=?', account.id)).toBe(1)
  })

  it('reset-password reveals the temporary password once and rotates the session', async () => {
    const admin = await login()
    const grace = await createAccountUser('grace', 'grace old password')
    const graceCookie = await login('grace', 'grace old password')

    const reset = await adminCall(admin, `/api/admin/users/${grace.id}/reset-password`, jsonRequest({ newPassword: 'grace new password' }))
    expect(reset.status).toBe(200)
    const resetBody = await reset.json() as UserBody & { temporaryPassword: string }
    expect(resetBody.temporaryPassword).toBe('grace new password')
    expect(resetBody.user.username).toBe('grace')

    expect((await fetchApi('/api/account', withCookie(graceCookie))).status).toBe(401)
    const oldLogin = await fetchApi('/api/login', jsonRequest({ username: 'grace', password: 'grace old password' }))
    expect(oldLogin.status).toBe(401)
    await login('grace', 'grace new password')

    const adminReset = await adminCall(admin, '/api/admin/users/usr_1/reset-password', jsonRequest({ newPassword: 'another password 1' }))
    expect(adminReset.status).toBe(409)
    expect(((await adminReset.json()) as ErrorBody).error.code).toBe('ADMIN_PASSWORD_SELF_SERVICE')

    // The pre-batch-8 endpoint keeps working for compatibility.
    const heidi = await createAccountUser('heidi', 'heidi old password')
    const legacy = await adminCall(admin, `/api/admin/users/${heidi.id}/password`, jsonRequest({ newPassword: 'heidi new password' }))
    expect(legacy.status).toBe(200)
    await login('heidi', 'heidi new password')
  })
})

describe('KV account fallback', () => {
  beforeEach(async () => {
    await setupContractedAdmin()
    await env.DB.prepare('DELETE FROM system_settings WHERE key=?').bind(ACCOUNTS_D1_READY_KEY).run()
    await setupAdmin()
  })

  it('soft delete, restore and purge behave the same on the KV snapshot', async () => {
    const admin = await login()
    const ivan = await createAccountUser('ivan', 'ivan password 12')
    const kvTokenHash = 'Q'.repeat(43)
    await writeDeliveryKv(env.DATA, {
      schemaVersion: 1,
      revision: 0,
      updatedAt: NOW,
      nextSubscriptionId: 42,
      subscriptions: [{
        id: 'sub_41',
        userId: ivan.id,
        name: 'Ivan KV sub',
        groupIds: [],
        tokenHash: kvTokenHash,
        tokenPrefix: 'KvPrefx2',
        encryptedToken: { version: 1, algorithm: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(24) },
        enabled: true,
        defaultClient: 'mihomo',
        revision: 1,
        startsAt: null,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }, NOW)
    await env.DATA.put(`compiled:${kvTokenHash}:mihomo`, 'compiled-body')

    const listed = await listUsers(admin)
    expect(listed.body.users.find((user) => user.username === 'ivan')!.subscriptionCount).toBe(0)

    expect((await deleteCall(admin, `/api/admin/users/${ivan.id}`)).status).toBe(200)
    const loginResponse = await fetchApi('/api/login', jsonRequest({ username: 'ivan', password: 'ivan password 12' }))
    expect(loginResponse.status).toBe(401)
    const trash = await listUsers(admin, '?deleted=only')
    expect(trash.body.users.map((user) => user.username)).toEqual(['ivan'])

    const purged = await adminCall(admin, `/api/admin/users/${ivan.id}/purge`, jsonRequest({}))
    expect(purged.status).toBe(200)
    const delivery = await readDeliveryKv(env.DATA)
    expect(delivery.subscriptions).toHaveLength(0)
    expect(await env.DATA.get(`compiled:${kvTokenHash}:mihomo`)).toBeNull()
    const after = await listUsers(admin, '?deleted=all')
    expect(after.body.users.some((user) => user.username === 'ivan')).toBe(false)
  })
})
