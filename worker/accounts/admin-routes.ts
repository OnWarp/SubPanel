import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { hashToken, randomToken } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { hashPassword } from './password.js'
import { readAccounts, writeAccounts } from './repository.js'
import {
  inviteRecordSchema,
  passwordInputSchema,
  toPublicUser,
  usernameInputSchema,
  type InviteRecord,
} from './schema.js'

const INVITE_PREFIX = 'invite:'
const INVITE_TTL_SECONDS = 24 * 60 * 60
const createInviteSchema = z.object({ username: usernameInputSchema })
const updateUserSchema = z.object({ enabled: z.boolean() })
const resetPasswordSchema = z.object({ newPassword: passwordInputSchema })
const inviteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

async function listInvites(kv: KVNamespace): Promise<Array<InviteRecord & { id: string }>> {
  const listed = await kv.list({ prefix: INVITE_PREFIX })
  const records = await Promise.all(listed.keys.map(async ({ name }) => {
    const raw = await kv.get(name)
    if (raw === null) return null
    const record = inviteRecordSchema.safeParse(JSON.parse(raw))
    if (!record.success) throw new Error('Invitation record is corrupt')
    return { id: name.slice(INVITE_PREFIX.length), ...record.data }
  }))
  const now = Date.now()
  return records.filter((record): record is InviteRecord & { id: string } =>
    record !== null && Date.parse(record.expiresAt) > now,
  )
}

export const adminAccountRoutes = new Hono<AppEnv>()

adminAccountRoutes.get('/users', async (c) => {
  const accounts = await readAccounts(c.env.DATA)
  return c.json({ users: accounts.users.map(toPublicUser) })
})

adminAccountRoutes.patch('/users/:id', async (c) => {
  const input = await readJson(c, updateUserSchema)
  const accounts = await readAccounts(c.env.DATA)
  const index = accounts.users.findIndex(({ id }) => id === c.req.param('id'))
  if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
  if (accounts.users[index].role === 'admin') throw apiError(409, 'ADMIN_IMMUTABLE', '不能停用管理员')

  const now = new Date().toISOString()
  const user = {
    ...accounts.users[index],
    enabled: input.enabled,
    sessionVersion: accounts.users[index].sessionVersion + 1,
    updatedAt: now,
  }
  const users = accounts.users.with(index, user)
  await writeAccounts(c.env.DATA, { ...accounts, users }, now)
  return c.json({ user: toPublicUser(user) })
})

adminAccountRoutes.post('/users/:id/password', async (c) => {
  const input = await readJson(c, resetPasswordSchema)
  const accounts = await readAccounts(c.env.DATA)
  const index = accounts.users.findIndex(({ id }) => id === c.req.param('id'))
  if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在')
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
  await writeAccounts(c.env.DATA, { ...accounts, users: accounts.users.with(index, user) }, now)
  return c.json({ user: toPublicUser(user) })
})

adminAccountRoutes.get('/invites', async (c) => {
  return c.json({ invites: await listInvites(c.env.DATA) })
})

adminAccountRoutes.post('/invites', async (c) => {
  const input = await readJson(c, createInviteSchema)
  const accounts = await readAccounts(c.env.DATA)
  if (accounts.users.some(({ username }) => username === input.username)) {
    throw apiError(409, 'USERNAME_TAKEN', '用户名已存在')
  }
  if ((await listInvites(c.env.DATA)).some(({ username }) => username === input.username)) {
    throw apiError(409, 'INVITE_EXISTS', '该用户名已有有效邀请')
  }

  const token = randomToken()
  const id = await hashToken(token)
  const createdAt = new Date()
  const record: InviteRecord = {
    schemaVersion: 1,
    userId: `usr_${accounts.nextUserId}`,
    username: input.username,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + INVITE_TTL_SECONDS * 1_000).toISOString(),
  }
  await writeAccounts(c.env.DATA, { ...accounts, nextUserId: accounts.nextUserId + 1 }, createdAt.toISOString())
  await c.env.DATA.put(`${INVITE_PREFIX}${id}`, JSON.stringify(record), {
    expirationTtl: INVITE_TTL_SECONDS,
  })
  return c.json({
    invite: {
      id,
      ...record,
      link: new URL(`/invite/${token}`, c.req.url).toString(),
    },
  }, 201)
})

adminAccountRoutes.delete('/invites/:id', async (c) => {
  const id = inviteIdSchema.safeParse(c.req.param('id'))
  if (!id.success) throw apiError(404, 'INVITE_NOT_FOUND', '邀请不存在')
  await c.env.DATA.delete(`${INVITE_PREFIX}${id.data}`)
  return c.body(null, 204)
})
