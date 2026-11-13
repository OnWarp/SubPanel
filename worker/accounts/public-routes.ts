import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError, ApiError } from '../platform/api-error.js'
import { getOrCreateCryptoMaterial, hashToken, readCryptoMaterial } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { resolveSessionUser } from './auth.js'
import { findUserByEmailNormalized } from './d1-repository.js'
import { findPendingVerification, issueVerificationCode, verifyVerificationCode } from './email-verification.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  clearLoginFailures,
  countWindowHits,
  loginRateLimited,
  recordLoginFailure,
  recordWindowHit,
  windowStartFor,
} from './rate-limit.js'
import { accountsUseD1, findAccountUserForLogin, readAccounts, writeAccounts } from './repository.js'
import {
  emailInputSchema,
  inviteRecordSchema,
  passwordInputSchema,
  toPublicUser,
  usernameInputSchema,
} from './schema.js'
import { createSessionToken, setSessionCookie } from './session.js'

const setupInputSchema = z.object({
  username: usernameInputSchema,
  password: passwordInputSchema,
})

// Login takes a single identifier (username or bound email). The legacy
// `username` field stays accepted and is treated as the same identifier.
const loginInputSchema = z
  .object({
    identifier: z.string().trim().min(1).max(320).optional(),
    username: z.string().trim().min(1).max(320).optional(),
    password: passwordInputSchema,
  })
  .refine(({ identifier, username }) => identifier !== undefined || username !== undefined, {
    message: 'identifier is required',
  })

const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const redeemInviteSchema = z.object({ password: passwordInputSchema })

export const publicAccountRoutes = new Hono<AppEnv>()

publicAccountRoutes.get('/bootstrap', async (c) => {
  const accounts = await readAccounts(c.env)
  const initialized = accounts.users.some((candidate) => candidate.role === 'admin')
  const user = initialized ? await resolveSessionUser(c) : null
  return c.json({
    initialized,
    user: user ? toPublicUser(user) : null,
  })
})

publicAccountRoutes.post('/setup', async (c) => {
  const current = await readAccounts(c.env)
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
  await writeAccounts(c.env, {
    ...current,
    nextUserId: current.nextUserId + 1,
    users: [admin],
  }, now)

  return c.json({ user: toPublicUser(admin) }, 201)
})

publicAccountRoutes.post('/login', async (c) => {
  const input = await readJson(c, loginInputSchema)
  const identifier = (input.identifier ?? input.username) as string
  const useD1 = await accountsUseD1(c.env)
  const identifierKey = identifier.trim().toLowerCase()
  const sourceKey = c.req.header('cf-connecting-ip') ?? 'unknown'
  const nowSeconds = Math.floor(Date.now() / 1_000)
  if (useD1 && (await loginRateLimited(c.env.DB, identifierKey, sourceKey, nowSeconds))) {
    throw apiError(429, 'TOO_MANY_ATTEMPTS', '登录尝试过于频繁，请稍后再试')
  }

  const user = await findAccountUserForLogin(c.env, identifier)
  let valid = false
  if (!user) {
    await hashPassword(input.password)
  } else {
    valid = (await verifyPassword(input.password, user.password)) && user.enabled
  }
  if (!valid) {
    if (useD1) await recordLoginFailure(c.env.DB, identifierKey, sourceKey, nowSeconds)
    throw apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')
  }
  if (!user) throw apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')

  if (useD1) await clearLoginFailures(c.env.DB, identifierKey)
  const material = await readCryptoMaterial(c.env.DATA)
  setSessionCookie(c, await createSessionToken(user, material.sessionKey))
  return c.json({ user: toPublicUser(user) })
})

const forgotPasswordSchema = z.object({ email: emailInputSchema })
const resetPasswordSchema = z.object({
  email: emailInputSchema,
  code: z.string().regex(/^\d{6}$/),
  newPassword: passwordInputSchema,
})

// Password recovery (batch 5). Codes come from the unified verification
// service with purpose 'reset_password'. Forgot never reveals whether the
// mailbox is registered: unknown or unbound addresses get the same success
// response and no code is issued. Rate limits ride on the shared
// rate_limits windows: a per-source cap that still answers 429, and a
// per-mailbox cap that silently skips sending.
const FORGOT_SOURCE_LIMIT = { bucket: 'password_forgot_source', limit: 20, windowSeconds: 60 * 60 } as const
const FORGOT_EMAIL_LIMIT = { bucket: 'password_forgot_email', limit: 5, windowSeconds: 60 * 60 } as const

publicAccountRoutes.post('/password/forgot', async (c) => {
  const input = await readJson(c, forgotPasswordSchema)
  if (await accountsUseD1(c.env)) {
    const db = c.env.DB
    const nowSeconds = Math.floor(Date.now() / 1_000)
    const sourceKey = c.req.header('cf-connecting-ip') ?? 'unknown'
    const sourceStart = windowStartFor(nowSeconds, FORGOT_SOURCE_LIMIT.windowSeconds)
    if (
      (await countWindowHits(db, FORGOT_SOURCE_LIMIT.bucket, sourceKey, sourceStart)) >= FORGOT_SOURCE_LIMIT.limit
    ) {
      throw apiError(429, 'TOO_MANY_ATTEMPTS', '请求过于频繁，请稍后再试')
    }
    await recordWindowHit(
      db,
      FORGOT_SOURCE_LIMIT.bucket,
      sourceKey,
      sourceStart,
      sourceStart + FORGOT_SOURCE_LIMIT.windowSeconds,
    )

    const user = await findUserByEmailNormalized(db, input.email)
    if (user && user.emailVerifiedAt) {
      const emailStart = windowStartFor(nowSeconds, FORGOT_EMAIL_LIMIT.windowSeconds)
      if ((await countWindowHits(db, FORGOT_EMAIL_LIMIT.bucket, input.email, emailStart)) < FORGOT_EMAIL_LIMIT.limit) {
        try {
          await issueVerificationCode(db, { email: input.email, purpose: 'reset_password', userId: user.id })
          await recordWindowHit(
            db,
            FORGOT_EMAIL_LIMIT.bucket,
            input.email,
            emailStart,
            emailStart + FORGOT_EMAIL_LIMIT.windowSeconds,
          )
        } catch (error) {
          // A still-valid code was issued less than a minute ago; swallow
          // the cooldown so the response cannot confirm the mailbox exists.
          if (!(error instanceof ApiError && error.code === 'CODE_TOO_SOON')) throw error
        }
      }
    }
  }
  return c.json({ ok: true })
})

publicAccountRoutes.post('/password/reset', async (c) => {
  const input = await readJson(c, resetPasswordSchema)
  if (!(await accountsUseD1(c.env))) throw apiError(409, 'PASSWORD_RESET_UNAVAILABLE', '密码重置暂不可用')
  const db = c.env.DB
  const pending = await findPendingVerification(db, { email: input.email, purpose: 'reset_password' })
  if (!pending || pending.userId === null) throw apiError(401, 'INVALID_CODE', '验证码错误')
  if (Date.parse(pending.expiresAt) <= Date.now()) throw apiError(410, 'CODE_EXPIRED', '验证码已过期')
  const verified = await verifyVerificationCode(db, { email: input.email, purpose: 'reset_password', code: input.code })
  if (!verified) throw apiError(401, 'INVALID_CODE', '验证码错误')

  const accounts = await readAccounts(c.env)
  const index = accounts.users.findIndex(({ id }) => id === pending.userId)
  if (index < 0) throw apiError(401, 'INVALID_CODE', '验证码错误')
  const current = accounts.users[index]
  const now = new Date().toISOString()
  const updated = {
    ...current,
    password: await hashPassword(input.newPassword),
    sessionVersion: current.sessionVersion + 1,
    updatedAt: now,
  }
  await writeAccounts(c.env, { ...accounts, users: accounts.users.with(index, updated) }, now)
  await clearLoginFailures(db, current.username)
  await clearLoginFailures(db, input.email)
  return c.json({ ok: true })
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

  const accounts = await readAccounts(c.env)
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
  await writeAccounts(c.env, {
    ...accounts,
    users: [...accounts.users, user],
  }, now)
  await c.env.DATA.delete(key)
  return c.json({ user: toPublicUser(user) }, 201)
})
