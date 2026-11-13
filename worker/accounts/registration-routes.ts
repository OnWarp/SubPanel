import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { getOrCreateCryptoMaterial } from '../platform/crypto.js'
import { readJson } from '../platform/http.js'
import { createInviteCodes, disableInviteCode, listInviteCodes } from './invite-codes.js'
import {
  addEmailDomain,
  getPublicRegistrationConfig,
  listEmailDomains,
  registerUser,
  removeEmailDomain,
  sendRegisterCode,
} from './registration.js'
import { emailInputSchema, passwordInputSchema, toPublicAccountUser, usernameInputSchema } from './schema.js'
import { createSessionToken, setSessionCookie } from './session.js'

const sendCodeSchema = z.object({ email: emailInputSchema })

const registerSchema = z.object({
  username: usernameInputSchema,
  password: passwordInputSchema,
  email: emailInputSchema,
  code: z.string().regex(/^\d{6}$/),
  inviteCode: z.string().trim().max(128).optional(),
})

export const registrationRoutes = new Hono<AppEnv>()

registrationRoutes.get('/register/config', async (c) => {
  return c.json(await getPublicRegistrationConfig(c.env))
})

registrationRoutes.post('/register/send-code', async (c) => {
  const input = await readJson(c, sendCodeSchema)
  const result = await sendRegisterCode(c.env, input.email)
  return c.json({ ok: true, email: result.email })
})

registrationRoutes.post('/register', async (c) => {
  const input = await readJson(c, registerSchema)
  const user = await registerUser(c.env, {
    username: input.username,
    password: input.password,
    email: input.email,
    code: input.code,
    inviteCode: input.inviteCode,
  })
  // Registration logs the new user in immediately, like setup does.
  const material = await getOrCreateCryptoMaterial(c.env.DATA)
  setSessionCookie(c, await createSessionToken(user, material.sessionKey))
  return c.json({ user: toPublicAccountUser(user) }, 201)
})

const createInvitationsSchema = z
  .object({
    type: z.enum(['multi', 'batch']),
    maxUses: z.number().int().positive().max(100_000).nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    count: z.number().int().positive().max(200).optional(),
  })
  .refine((input) => input.type !== 'batch' || (input.count !== undefined && input.count >= 1), {
    message: 'count is required for batch invitations',
    path: ['count'],
  })

const addDomainSchema = z.object({ domain: z.string().trim().min(1).max(253) })

export const adminRegistrationRoutes = new Hono<AppEnv>()

adminRegistrationRoutes.post('/invitations', async (c) => {
  const input = await readJson(c, createInvitationsSchema)
  const codes = await createInviteCodes(c.env.DB, c.get('principal').id, {
    type: input.type,
    maxUses: input.maxUses ?? null,
    expiresAt: input.expiresAt ?? null,
    count: input.count,
  })
  // Plaintext codes appear only in this creation response.
  return c.json({ invitations: codes }, 201)
})

adminRegistrationRoutes.get('/invitations', async (c) => {
  return c.json({ invitations: await listInviteCodes(c.env.DB) })
})

adminRegistrationRoutes.delete('/invitations/:id', async (c) => {
  // Deleting a code disables it; redemption history stays intact.
  await disableInviteCode(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})

adminRegistrationRoutes.get('/email-domains', async (c) => {
  return c.json({ domains: await listEmailDomains(c.env.DB) })
})

adminRegistrationRoutes.post('/email-domains', async (c) => {
  const input = await readJson(c, addDomainSchema)
  const domain = await addEmailDomain(c.env.DB, input.domain)
  return c.json({ domain }, 201)
})

adminRegistrationRoutes.delete('/email-domains/:domain', async (c) => {
  await removeEmailDomain(c.env.DB, c.req.param('domain'))
  return c.body(null, 204)
})
