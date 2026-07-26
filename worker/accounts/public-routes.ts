import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { getOrCreateCryptoMaterial, hashToken, readCryptoMaterial } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { resolveSessionUser } from './auth.js'
import { hashPassword, verifyPassword } from './password.js'
import { readAccounts, writeAccounts } from './repository.js'
import { inviteRecordSchema, passwordInputSchema, toPublicUser, usernameInputSchema } from './schema.js'
import { createSessionToken, setSessionCookie } from './session.js'

const setupInputSchema = z.object({
  username: usernameInputSchema,
  password: passwordInputSchema,
})

const loginInputSchema = z.object({
  username: usernameInputSchema,
  password: passwordInputSchema,
})

const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const redeemInviteSchema = z.object({ password: passwordInputSchema })

export const publicAccountRoutes = new Hono<AppEnv>()

publicAccountRoutes.get('/bootstrap', async (c) => {
  const accounts = await readAccounts(c.env.DATA)
  const initialized = accounts.users.some((candidate) => candidate.role === 'admin')
  const user = initialized ? await resolveSessionUser(c) : null
  return c.json({
    initialized,
    user: user ? toPublicUser(user) : null,
  })
})

publicAccountRoutes.post('/setup', async (c) => {
  const current = await readAccounts(c.env.DATA)
  if (current.users.length > 0) throw apiError(409, 'ALREADY_INITIALIZED', '系统已经完成初始化')

  const input = await readJson(c, setupInputSchema)
  await getOrCreateCryptoMaterial(c.env.DATA)
  const now = new Date().toISOString()
  const admin = {
    id: `usr_${current.nextUserId}`,
    username: input.username,
    role: 'admin' as const,
    enabled: true,
    password: await hashPassword(input.password),
    sessionVersion: 0,
    createdAt: now,
    updatedAt: now,
  }
  await writeAccounts(c.env.DATA, {
    ...current,
    nextUserId: current.nextUserId + 1,
    users: [admin],
  }, now)

  return c.json({ user: toPublicUser(admin) }, 201)
})

publicAccountRoutes.post('/login', async (c) => {
  const input = await readJson(c, loginInputSchema)
  const accounts = await readAccounts(c.env.DATA)
  const user = accounts.users.find(({ username }) => username === input.username)
  if (!user) {
    await hashPassword(input.password)
    throw apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')
  }
  const valid = await verifyPassword(input.password, user.password)
  if (!valid || !user.enabled) throw apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')

  const material = await readCryptoMaterial(c.env.DATA)
  setSessionCookie(c, await createSessionToken(user, material.sessionKey))
  return c.json({ user: toPublicUser(user) })
})

publicAccountRoutes.get('/invites/:token', async (c) => {
  const token = inviteTokenSchema.safeParse(c.req.param('token'))
  if (!token.success) throw apiError(404, 'INVITE_NOT_FOUND', '邀请不存在')
  const key = `invite:${await hashToken(token.data)}`
  const raw = await c.env.DATA.get(key)
  if (raw === null) throw apiError(404, 'INVITE_NOT_FOUND', '邀请不存在')
  const invite = inviteRecordSchema.parse(JSON.parse(raw))
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    await c.env.DATA.delete(key)
    throw apiError(410, 'INVITE_EXPIRED', '邀请已过期')
  }
  return c.json({ invite: { username: invite.username, expiresAt: invite.expiresAt } })
})

publicAccountRoutes.post('/invites/:token', async (c) => {
  const token = inviteTokenSchema.safeParse(c.req.param('token'))
  if (!token.success) throw apiError(404, 'INVITE_NOT_FOUND', '邀请不存在')
  const input = await readJson(c, redeemInviteSchema)
  const key = `invite:${await hashToken(token.data)}`
  const raw = await c.env.DATA.get(key)
  if (raw === null) throw apiError(404, 'INVITE_NOT_FOUND', '邀请不存在')
  const invite = inviteRecordSchema.parse(JSON.parse(raw))
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    await c.env.DATA.delete(key)
    throw apiError(410, 'INVITE_EXPIRED', '邀请已过期')
  }

  const accounts = await readAccounts(c.env.DATA)
  if (accounts.users.some(({ username }) => username === invite.username)) {
    await c.env.DATA.delete(key)
    throw apiError(409, 'USERNAME_TAKEN', '用户名已存在')
  }
  const now = new Date().toISOString()
  const user = {
    id: invite.userId,
    username: invite.username,
    role: 'user' as const,
    enabled: true,
    password: await hashPassword(input.password),
    sessionVersion: 0,
    createdAt: now,
    updatedAt: now,
  }
  // ponytail: KV cannot atomically consume an invite and write Accounts; fixed identity makes repeats converge, but strict global single use requires a Durable Object or D1.
  await writeAccounts(c.env.DATA, {
    ...accounts,
    users: [...accounts.users, user],
  }, now)
  await c.env.DATA.delete(key)
  return c.json({ user: toPublicUser(user) }, 201)
})
