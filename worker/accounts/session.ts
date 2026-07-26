import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { fromBase64Url, signHmac, toBase64Url, verifyHmac } from '../platform/crypto.js'
import { userIdSchema, type User } from './schema.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
export const SESSION_COOKIE = 'subpanel_session'
export const SESSION_TTL_SECONDS = 24 * 60 * 60

const sessionPayloadSchema = z.object({
  version: z.literal(1),
  subject: userIdSchema,
  role: z.enum(['admin', 'user']),
  sessionVersion: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
})

export type SessionPayload = z.infer<typeof sessionPayloadSchema>

export async function createSessionToken(
  user: User,
  sessionKey: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<string> {
  const payload: SessionPayload = {
    version: 1,
    subject: user.id,
    role: user.role,
    sessionVersion: user.sessionVersion,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + SESSION_TTL_SECONDS,
  }
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)))
  return `${encoded}.${await signHmac(encoded, sessionKey)}`
}

export async function verifySessionToken(
  token: string,
  sessionKey: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<SessionPayload | null> {
  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra || !(await verifyHmac(encoded, signature, sessionKey))) return null
  try {
    const payload = sessionPayloadSchema.parse(JSON.parse(decoder.decode(fromBase64Url(encoded))))
    return payload.expiresAt > nowSeconds ? payload : null
  } catch {
    return null
  }
}

export const readSessionCookie = (c: Context<AppEnv>): string | undefined => getCookie(c, SESSION_COOKIE)

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}
