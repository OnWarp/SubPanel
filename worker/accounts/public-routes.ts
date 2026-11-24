import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError, ApiError } from '../platform/api-error.js'
import { hashToken, readCryptoMaterial, signHmac, verifyHmac } from '../platform/crypto.js'
import { ACCOUNTS_D1_READY_KEY } from '../db/module-switch.js'
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
  passwordInputSchema,
  toPublicUser,
  usernameInputSchema,
} from './schema.js'
import { createSessionToken, setSessionCookie } from './session.js'

const setupInputSchema = z.object({
  setupSecret: z.string().max(512),
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
  const secret = c.env.BOOTSTRAP_SECRET
  if (!secret || secret.length < 32 || !await verifyHmac('subpanel:setup', await signHmac('subpanel:setup', await hashToken(input.setupSecret)), await hashToken(secret))) {
    throw apiError(403, 'SETUP_FORBIDDEN', '初始化密钥无效')
  }
  await readCryptoMaterial(c.env.DATA)
  const now = new Date().toISOString()
  const admin = {
    id: 'usr_1',
    username: input.username,
    role: 'admin' as const,
    enabled: true,
    password: await hashPassword(input.password),
    sessionVersion: 0,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const db = c.env.DB
  const results = await db.batch([
    db.prepare(`INSERT INTO users (
      id, username, role, enabled, password_algorithm, password_iterations,
      password_salt, password_hash, session_version, created_at, updated_at
    ) SELECT ?, ?, 'admin', 1, ?, ?, ?, ?, 0, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM users)`)
      .bind(admin.id, admin.username, admin.password.algorithm, admin.password.iterations,
        admin.password.salt, admin.password.hash, now, now),
    db.prepare(`INSERT INTO system_settings(key,value,updated_at)
      SELECT ?, 'true', ? WHERE changes()=1
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(ACCOUNTS_D1_READY_KEY, now),
  ])
  if (!results[0].meta.changes) throw apiError(409, 'ALREADY_INITIALIZED', '系统已经完成初始化')
  return c.json({ user: toPublicUser(admin) }, 201)
})

publicAccountRoutes.post('/login', async (c) => {
  const input = await readJson(c, loginInputSchema)
  const identifier = (input.identifier ?? input.username) as string
  const identifierKey = identifier.trim().toLowerCase()
  const sourceKey = c.req.header('cf-connecting-ip') ?? 'unknown'
  const nowSeconds = Math.floor(Date.now() / 1_000)
  if (await loginRateLimited(c.env.DB, identifierKey, sourceKey, nowSeconds)) {
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
    await recordLoginFailure(c.env.DB, identifierKey, sourceKey, nowSeconds)
    throw apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')
  }
  if (!user) throw apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')

  await clearLoginFailures(c.env.DB, identifierKey)
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

// Legacy redemption no longer creates accounts. All links use /api/register.
publicAccountRoutes.get('/invites/:token', (c) => c.redirect(`/register?inviteCode=${encodeURIComponent(c.req.param('token'))}`, 302))
publicAccountRoutes.post('/invites/:token', () => {
  throw apiError(410, 'USE_REGISTRATION', '请通过邀请链接进入注册页面，填写用户名、密码与邮箱')
})
