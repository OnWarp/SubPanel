import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readCryptoMaterial } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { resolveAvatar } from './avatar.js'
import { confirmEmailBind, requestEmailBind } from './email-binding.js'
import { confirmEmailChange, requestEmailChange } from './email-change.js'
import { hashPassword, verifyPassword } from './password.js'
import { findAccountUserById, readAccounts, writeAccounts } from './repository.js'
import {
  clearSessionCookie,
  createSessionToken,
  readSessionCookie,
  setSessionCookie,
  verifySessionToken,
} from './session.js'
import { emailInputSchema, passwordInputSchema, toPublicAccountUser, toPublicUser } from './schema.js'

const passwordChangeSchema = z
  .object({
    currentPassword: passwordInputSchema,
    newPassword: passwordInputSchema,
  })
  .refine(({ currentPassword, newPassword }) => currentPassword !== newPassword, {
    message: '新密码不能与当前密码相同',
    path: ['newPassword'],
  })

export const accountRoutes = new Hono<AppEnv>()

accountRoutes.get('/', (c) => c.json({ user: c.get('principal') }))

accountRoutes.post('/password', async (c) => {
  const input = await readJson(c, passwordChangeSchema)
  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === c.get('principal').id)
  if (index < 0) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const current = accounts.users[index]
  if (!(await verifyPassword(input.currentPassword, current.password))) {
    throw apiError(401, 'INVALID_PASSWORD', '当前密码错误')
  }

  const now = new Date().toISOString()
  const user = {
    ...current,
    password: await hashPassword(input.newPassword),
    sessionVersion: current.sessionVersion + 1,
    updatedAt: now,
  }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, user) }, now)
  const material = await readCryptoMaterial(c.env.DATA)
  setSessionCookie(c, await createSessionToken(user, material.sessionKey))
  return c.json({ user: toPublicUser(user) })
})

accountRoutes.post('/logout', (c) => {
  clearSessionCookie(c)
  return c.json({ ok: true })
})

const bindEmailSchema = z.object({ email: emailInputSchema })
const confirmBindSchema = z.object({ code: z.string().regex(/^\d{6}$/) })

accountRoutes.post('/email/bind', async (c) => {
  const input = await readJson(c, bindEmailSchema)
  const user = await findAccountUserById(c.env, c.get('principal').id)
  if (!user) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const result = await requestEmailBind(c.env, user, input.email)
  return c.json(result)
})

accountRoutes.post('/email/bind/confirm', async (c) => {
  const input = await readJson(c, confirmBindSchema)
  const user = await findAccountUserById(c.env, c.get('principal').id)
  if (!user) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const updated = await confirmEmailBind(c.env, user, input.code)
  return c.json({ user: toPublicAccountUser(updated) })
})

accountRoutes.get('/profile', async (c) => {
  const user = await findAccountUserById(c.env, c.get('principal').id)
  if (!user) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const material = await readCryptoMaterial(c.env.DATA)
  const token = readSessionCookie(c)
  const payload = token ? await verifySessionToken(token, material.sessionKey) : null
  return c.json({
    user: toPublicAccountUser(user),
    emailBound: user.email !== null,
    avatar: resolveAvatar(user),
    session: payload
      ? {
          issuedAt: new Date(payload.issuedAt * 1_000).toISOString(),
          expiresAt: new Date(payload.expiresAt * 1_000).toISOString(),
        }
      : null,
  })
})

accountRoutes.post('/logout-all', async (c) => {
  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === c.get('principal').id)
  if (index < 0) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const now = new Date().toISOString()
  const current = accounts.users[index]
  const user = { ...current, sessionVersion: current.sessionVersion + 1, updatedAt: now }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, user) }, now)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

accountRoutes.post('/email/change', async (c) => {
  const input = await readJson(c, bindEmailSchema)
  const user = await findAccountUserById(c.env, c.get('principal').id)
  if (!user) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const result = await requestEmailChange(c.env, user, input.email)
  return c.json(result)
})

accountRoutes.post('/email/change/confirm', async (c) => {
  const input = await readJson(c, confirmBindSchema)
  const user = await findAccountUserById(c.env, c.get('principal').id)
  if (!user) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const updated = await confirmEmailChange(c.env, user, input.code)
  return c.json({ user: toPublicAccountUser(updated) })
})
