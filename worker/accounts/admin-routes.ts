import { getUserEntitlement } from '../entitlements/service.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { createInviteCodes, disableInviteCode, importLegacyInvites, listInviteCodes } from './invite-codes.js'
import { readJson } from '../platform/http.js'
import { primaryDomainOriginSafe } from '../domains/service.js'
import { sendTestEmail } from './email.js'
import { hashPassword } from './password.js'
import { accountsUseD1, findAccountUserById, readAccounts, writeAccounts } from './repository.js'
import {
  findUserByEmailNormalized,
  countAdminUsers,
  listAdminUserRedemptions,
  listAdminUserSubscriptions,
  listAdminUsers,
  purgeUserFromD1,
  type AdminUserFilters,
} from './d1-repository.js'
import {
  emailInputSchema,
  passwordInputSchema,
  roleSchema,
  toPublicAccountUser,
  toPublicUser,
} from './schema.js'
import { deleteCompiledArtifacts, readDelivery, readDeliveryKv, writeDeliveryKv } from '../delivery/repository.js'
import {
  deleteShareCompiled,
  deleteShareKv,
  listAllSharesKv,
  removeIndexHashKv,
  subscriptionIndexKey,
  userIndexKey,
} from '../shares/repository.js'

const updateUserSchema = z.object({
  email: emailInputSchema.optional(),
  enabled: z.boolean().optional(),
  role: roleSchema.optional(),
})
const resetPasswordSchema = z.object({ newPassword: passwordInputSchema })

const parseAdminUserFilters = (query: Record<string, string | undefined>): AdminUserFilters => {
  const needle = query.q?.trim().toLowerCase()
  return {
    query: needle ? needle : null,
    role: query.role === 'admin' || query.role === 'user' ? query.role : null,
    enabled: query.status === 'enabled' ? true : query.status === 'disabled' ? false : null,
    deleted: query.deleted === 'only' || query.deleted === 'all' ? query.deleted : 'active',
  }
}

const parsePagination = (query: Record<string, string | undefined>): { page: number, pageSize: number } => {
  const page = Number.parseInt(query.page ?? '', 10)
  const pageSize = Number.parseInt(query.pageSize ?? '', 10)
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
  }
}

// Administrators may coexist; the guard rails only protect the LAST active
// one from losing that status (demote / disable / soft delete / purge).
const hasOtherAdmin = (
  users: ReadonlyArray<{ id: string, role: string, deletedAt: string | null }>,
  targetId: string,
): boolean => users.some(
  (candidate) => candidate.id !== targetId && candidate.role === 'admin' && !candidate.deletedAt,
)

// Delivery may still live in KV while accounts already run on D1; a purge
// has to sweep the KV snapshot too, or the user's subscriptions would stay
// listed there (public delivery still stops, because the owner lookup
// fails, but the records must actually go). The KV-explicit repository
// variants are used on purpose: the dispatching read/write pair follows
// the delivery module flag and would miss the frozen KV snapshot once the
// module runs on D1.
async function scrubKvDelivery(
  kv: KVNamespace,
  userId: string,
  now: string,
): Promise<Array<{ id: string, tokenHash: string }>> {
  const delivery = await readDeliveryKv(kv).catch(() => null)
  if (!delivery) return []
  const removed = delivery.subscriptions.filter((subscription) => subscription.userId === userId)
  if (removed.length === 0) return []
  await writeDeliveryKv(kv, {
    ...delivery,
    subscriptions: delivery.subscriptions.filter((subscription) => subscription.userId !== userId),
  }, now)
  for (const subscription of removed) await deleteCompiledArtifacts(kv, subscription.tokenHash)
  return removed
}

// Shares live in KV unless the shares module itself runs on D1; a purge has
// to sweep both stores so no share record keeps pointing at a deleted user
// or at one of their subscriptions.
async function scrubKvShares(
  kv: KVNamespace,
  userId: string,
  subscriptionIds: ReadonlySet<string>,
): Promise<void> {
  const shares = await listAllSharesKv(kv).catch(() => [])
  for (const share of shares) {
    if (share.ownerUserId === userId || subscriptionIds.has(share.subscriptionId)) {
      // Same cleanup removeShare performs (record, both indexes, compiled
      // artifacts), spelled out with the KV-explicit variants so it also
      // reaches KV-era records after the shares module moved to D1.
      await deleteShareKv(kv, share.tokenHash).catch(() => undefined)
      await removeIndexHashKv(kv, userIndexKey(share.ownerUserId), share.tokenHash).catch(() => undefined)
      await removeIndexHashKv(kv, subscriptionIndexKey(share.subscriptionId), share.tokenHash).catch(() => undefined)
      await deleteShareCompiled(kv, share.tokenHash).catch(() => undefined)
    }
  }
}
export const adminAccountRoutes = new Hono<AppEnv>()

adminAccountRoutes.get('/users', async (c) => {
  const filters = parseAdminUserFilters(c.req.query())
  const { page, pageSize } = parsePagination(c.req.query())
  if (await accountsUseD1(c.env)) {
    const [listed, total] = await Promise.all([
      listAdminUsers(c.env.DB, filters, pageSize, (page - 1) * pageSize),
      countAdminUsers(c.env.DB, filters),
    ])
    return c.json({
      users: listed.map((user) => ({ ...toPublicAccountUser(user), subscriptionCount: user.subscriptionCount })),
      total,
      page,
      pageSize,
    })
  }
  const accounts = await readAccounts(c.env)
  const delivery = await readDelivery(c.env).catch(() => null)
  const counts = new Map<string, number>()
  for (const subscription of delivery?.subscriptions ?? []) {
    if (!subscription.userId) continue
    counts.set(subscription.userId, (counts.get(subscription.userId) ?? 0) + 1)
  }
  const filtered = accounts.users.filter((user) => {
    if (filters.deleted === 'active' && user.deletedAt) return false
    if (filters.deleted === 'only' && !user.deletedAt) return false
    if (filters.role !== null && user.role !== filters.role) return false
    if (filters.enabled !== null && user.enabled !== filters.enabled) return false
    if (filters.query !== null && !user.username.toLowerCase().includes(filters.query)) return false
    return true
  })
  return c.json({
    users: filtered
      .slice((page - 1) * pageSize, page * pageSize)
      .map((user) => ({ ...toPublicUser(user), subscriptionCount: counts.get(user.id) ?? 0 })),
    total: filtered.length,
    page,
    pageSize,
  })
})

adminAccountRoutes.get('/users/:id', async (c) => {
  const userId = c.req.param('id')
  const accountUser = await findAccountUserById(c.env, userId)
  if (!accountUser) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  if (await accountsUseD1(c.env)) {
    const [subscriptions, invitationRedemptions] = await Promise.all([
      listAdminUserSubscriptions(c.env.DB, userId),
      listAdminUserRedemptions(c.env.DB, userId),
    ])
    return c.json({
      user: { ...toPublicAccountUser(accountUser), subscriptionCount: subscriptions.length },
      entitlement: await getUserEntitlement(c.env.DB, accountUser.id),
      subscriptions,
      invitationRedemptions,
    })
  }
  const delivery = await readDelivery(c.env).catch(() => null)
  const subscriptions = (delivery?.subscriptions ?? [])
    .filter((subscription) => subscription.userId === userId)
    .map((subscription) => ({
      id: subscription.id,
      name: subscription.name,
      tokenPrefix: subscription.tokenPrefix,
      enabled: subscription.enabled,
      defaultClient: subscription.defaultClient,
      revision: subscription.revision,
      startsAt: subscription.startsAt,
      expiresAt: subscription.expiresAt,
      groupIds: subscription.groupIds,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    }))
  return c.json({
    user: { ...toPublicAccountUser(accountUser), subscriptionCount: subscriptions.length },
      entitlement: await getUserEntitlement(c.env.DB, accountUser.id),
    subscriptions,
    // KV mode never recorded redemptions once an invite was consumed.
    invitationRedemptions: [],
  })
})

adminAccountRoutes.patch('/users/:id', async (c) => {
  const input = await readJson(c, updateUserSchema)
  if (input.email === undefined && input.enabled === undefined && input.role === undefined) {
    throw apiError(400, 'EMPTY_UPDATE', '没有可更新的字段')
  }
  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === c.req.param('id'))
  if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  const target = accounts.users[index]
  if (target.deletedAt) throw apiError(409, 'USER_DELETED', '用户已在回收站，请先恢复后再修改')
  const demotesAdmin = target.role === 'admin' && input.role === 'user'
  const disablesAdmin = target.role === 'admin' && input.enabled === false
  if ((demotesAdmin || disablesAdmin) && !hasOtherAdmin(accounts.users, target.id)) {
    throw apiError(409, 'LAST_ADMIN', '不能停用或降级最后一个管理员')
  }
  const promotes = target.role === 'user' && input.role === 'admin'
  if (promotes && !target.enabled && input.enabled !== true) {
    throw apiError(409, 'USER_DISABLED', '停用中的用户不能设为管理员')
  }

  if (input.email !== undefined) {
    if (!(await accountsUseD1(c.env))) {
      throw apiError(409, 'EMAIL_CHANGE_UNAVAILABLE', '邮箱更换暂不可用')
    }
    // Admin edits bypass registration domain rules and pending code reservations.
    const owner = await findUserByEmailNormalized(c.env.DB, input.email)
    if (owner && owner.id !== target.id) throw apiError(409, 'EMAIL_TAKEN', '该邮箱已被使用')
  }

  const now = new Date().toISOString()
  const changed =
    (input.enabled !== undefined && input.enabled !== target.enabled) ||
    (input.role !== undefined && input.role !== target.role)
  const user = {
    ...target,
    enabled: input.enabled ?? target.enabled,
    role: input.role ?? target.role,
    // Any privilege or access change invalidates existing sessions.
    sessionVersion: changed ? target.sessionVersion + 1 : target.sessionVersion,
    updatedAt: now,
  }
  if (input.email !== undefined) {
    try {
      // One atomic write also covers combined email, role and status edits.
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE users SET email = ?, email_normalized = ?, email_verified_at = ?,
          enabled = ?, role = ?, session_version = ?, updated_at = ? WHERE id = ?`)
          .bind(input.email, input.email, now, user.enabled ? 1 : 0, user.role, user.sessionVersion, now, user.id),
        c.env.DB.prepare('DELETE FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL').bind(user.id),
        c.env.DB.prepare('DELETE FROM email_change_requests WHERE user_id = ?').bind(user.id),
      ])
    } catch (error) {
      // The unique index also protects concurrent requests for the same address.
      if (String(error).includes('UNIQUE constraint failed: users.email_normalized')) {
        throw apiError(409, 'EMAIL_TAKEN', '该邮箱已被使用')
      }
      throw error
    }
  } else {
    await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, user) }, now)
  }
  const updated = await findAccountUserById(c.env, user.id)
  if (!updated) throw new Error('Accounts snapshot is corrupt')
  return c.json({ user: toPublicAccountUser(updated) })
})

adminAccountRoutes.post('/users/:id/password', async (c) => {
  const input = await readJson(c, resetPasswordSchema)
  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === c.req.param('id'))
  if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  if (accounts.users[index].deletedAt) throw apiError(409, 'USER_DELETED', '用户已在回收站，请先恢复后再修改')
  if (accounts.users[index].role === 'admin') {
    throw apiError(409, 'ADMIN_PASSWORD_SELF_SERVICE', '管理员必须在账户安全中修改自己的密码')
  }

  const now = new Date().toISOString()
  const user = {
    ...accounts.users[index],
    password: await hashPassword(input.newPassword),
    sessionVersion: accounts.users[index].sessionVersion + 1,
    updatedAt: now,
  }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, user) }, now)
  return c.json({ user: toPublicUser(user) })
})

// Batch 8 endpoint: same guard rails as /password, but the freshly set
// password is returned once as a temporary password so the administrator
// can hand it to the user (the invite-link reveal follows the same rule).
adminAccountRoutes.post('/users/:id/reset-password', async (c) => {
  const input = await readJson(c, resetPasswordSchema)
  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === c.req.param('id'))
  if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  if (accounts.users[index].deletedAt) throw apiError(409, 'USER_DELETED', '用户已在回收站，请先恢复后再修改')
  if (accounts.users[index].role === 'admin') {
    throw apiError(409, 'ADMIN_PASSWORD_SELF_SERVICE', '管理员必须在账户安全中修改自己的密码')
  }

  const now = new Date().toISOString()
  const user = {
    ...accounts.users[index],
    password: await hashPassword(input.newPassword),
    sessionVersion: accounts.users[index].sessionVersion + 1,
    updatedAt: now,
  }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, user) }, now)
  return c.json({ user: toPublicUser(user), temporaryPassword: input.newPassword })
})

adminAccountRoutes.delete('/users/:id', async (c) => {
  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === c.req.param('id'))
  if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  const target = accounts.users[index]
  if (target.deletedAt) throw apiError(409, 'USER_ALREADY_DELETED', '用户已在回收站')
  if (target.role === 'admin' && !hasOtherAdmin(accounts.users, target.id)) {
    throw apiError(409, 'LAST_ADMIN', '不能删除最后一个管理员')
  }

  const now = new Date().toISOString()
  const user = {
    ...target,
    deletedAt: now,
    sessionVersion: target.sessionVersion + 1,
    updatedAt: now,
  }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, user) }, now)
  return c.json({ user: toPublicUser(user) })
})

adminAccountRoutes.post('/users/:id/restore', async (c) => {
  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === c.req.param('id'))
  if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  const target = accounts.users[index]
  if (!target.deletedAt) throw apiError(409, 'USER_NOT_DELETED', '用户不在回收站')

  const now = new Date().toISOString()
  const user = {
    ...target,
    deletedAt: null,
    sessionVersion: target.sessionVersion + 1,
    updatedAt: now,
  }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, user) }, now)
  return c.json({ user: toPublicUser(user) })
})

adminAccountRoutes.post('/users/:id/purge', async (c) => {
  const accounts = await readAccounts(c.env)
  const target = accounts.users.find(({ id }) => id === c.req.param('id'))
  if (!target) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  if (!target.deletedAt) throw apiError(409, 'USER_NOT_DELETED', '请先将用户移入回收站，再执行永久删除')
  if (target.role === 'admin' && !hasOtherAdmin(accounts.users, target.id)) {
    throw apiError(409, 'LAST_ADMIN', '不能永久删除最后一个管理员')
  }
  const now = new Date().toISOString()
  const userId = target.id
  if (await accountsUseD1(c.env)) {
    // D1 first: the cascade clears every foreign key that RESTRICTs the
    // users row, so the snapshot write below can drop the row cleanly.
    const accountUser = await findAccountUserById(c.env, userId)
    const ownedSubscriptions = await listAdminUserSubscriptions(c.env.DB, userId)
    const { tokenHashes } = await purgeUserFromD1(c.env.DB, {
      id: userId,
      username: target.username,
      emailNormalized: accountUser?.emailNormalized ?? null,
    })
    for (const tokenHash of tokenHashes) await deleteCompiledArtifacts(c.env.DATA, tokenHash)
    const removedKv = await scrubKvDelivery(c.env.DATA, userId, now)
    await scrubKvShares(c.env.DATA, userId, new Set([
      ...ownedSubscriptions.map((subscription) => subscription.id),
      ...removedKv.map((subscription) => subscription.id),
    ]))
  } else {
    const removed = await scrubKvDelivery(c.env.DATA, userId, now)
    if (removed.length) await c.env.DB.prepare(`
      DELETE FROM subscription_template_bindings WHERE subscription_id IN (SELECT value FROM json_each(?))
    `).bind(JSON.stringify(removed.map(subscription => subscription.id))).run()
    await scrubKvShares(c.env.DATA, userId, new Set(removed.map((subscription) => subscription.id)))
  }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.filter((user) => user.id !== userId) }, now)
  return c.json({ purged: true, userId })
})

// Compatibility aliases use the same qualification codes as /invitations.
adminAccountRoutes.get('/invites', async (c) => {
  await importLegacyInvites(c.env)
  return c.json({ invites: await listInviteCodes(c.env.DB) })
})
adminAccountRoutes.post('/invites', async (c) => {
  const [invite] = await createInviteCodes(c.env.DB, c.get('principal').id, { type: 'batch', count: 1, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
  const panelOrigin = await primaryDomainOriginSafe(c.env.DB, 'panel')
  return c.json({ invite: { ...invite, link: new URL(`/invite/${invite.code}`, panelOrigin ?? c.req.url).toString() } }, 201)
})
adminAccountRoutes.delete('/invites/:id', async (c) => {
  await importLegacyInvites(c.env)
  await disableInviteCode(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})

const mailTestSchema = z.object({ email: emailInputSchema })

// Send one test message through the configured mail provider (batch 5).
// The response reports the outcome instead of throwing, so the admin UI can
// show "not configured" and provider failures as data.
adminAccountRoutes.post('/mail/test', async (c) => {
  const input = await readJson(c, mailTestSchema)
  const result = await sendTestEmail(input.email)
  return c.json({
    ok: result.ok,
    provider: result.provider,
    ...(result.error ? { error: result.error } : {}),
  })
})
