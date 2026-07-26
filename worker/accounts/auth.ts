import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, Principal } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readCryptoMaterial } from '../platform/crypto.js'
import { readAccounts } from './repository.js'
import { readSessionCookie, verifySessionToken } from './session.js'
import type { User } from './schema.js'

export async function resolveSessionUser(c: Context<AppEnv>): Promise<User | null> {
  const token = readSessionCookie(c)
  if (!token) return null
  const material = await readCryptoMaterial(c.env.DATA)
  const payload = await verifySessionToken(token, material.sessionKey)
  if (!payload) return null

  const accounts = await readAccounts(c.env.DATA)
  const user = accounts.users.find(({ id }) => id === payload.subject)
  if (!user || !user.enabled) return null
  if (user.role !== payload.role || user.sessionVersion !== payload.sessionVersion) return null
  return user
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveSessionUser(c)
  if (!user) throw apiError(401, 'AUTH_REQUIRED', '请先登录')
  const principal: Principal = {
    id: user.id,
    username: user.username,
    role: user.role,
    sessionVersion: user.sessionVersion,
  }
  c.set('principal', principal)
  await next()
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('principal').role !== 'admin') throw apiError(403, 'ADMIN_REQUIRED', '需要管理员权限')
  await next()
}
