import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readCryptoMaterial } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { hashPassword, verifyPassword } from './password.js'
import { readAccounts, writeAccounts } from './repository.js'
import { clearSessionCookie, createSessionToken, setSessionCookie } from './session.js'
import { passwordInputSchema, toPublicUser } from './schema.js'

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
  const accounts = await readAccounts(c.env.DATA)
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
  await writeAccounts(c.env.DATA, { ...accounts, users: accounts.users.with(index, user) }, now)
  const material = await readCryptoMaterial(c.env.DATA)
  setSessionCookie(c, await createSessionToken(user, material.sessionKey))
  return c.json({ user: toPublicUser(user) })
})

accountRoutes.post('/logout', (c) => {
  clearSessionCookie(c)
  return c.json({ ok: true })
})
