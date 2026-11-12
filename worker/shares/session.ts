import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { tokenHashSchema } from '../delivery/schema.js'
import { fromBase64Url, readCryptoMaterial, signHmac, toBase64Url, verifyHmac } from '../platform/crypto.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// 邀请兑换只校验一次性 token，不签发访客会话。
// 分享密码关沿用账户会话的 HMAC Cookie：HttpOnly、短时效，只绑定这次分享的 tokenHash。
export const SHARE_COOKIE = 'subpanel_share'
export const SHARE_SESSION_TTL_SECONDS = 10 * 60

const shareSessionSchema = z.object({
  version: z.literal(1),
  tokenHash: tokenHashSchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
})

export async function createShareSessionToken(
  tokenHash: string,
  sessionKey: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<string> {
  const payload = {
    version: 1 as const,
    tokenHash,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + SHARE_SESSION_TTL_SECONDS,
  }
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)))
  return `${encoded}.${await signHmac(encoded, sessionKey)}`
}

export async function verifyShareSessionToken(
  token: string,
  sessionKey: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<z.infer<typeof shareSessionSchema> | null> {
  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra || !(await verifyHmac(encoded, signature, sessionKey))) return null
  try {
    const payload = shareSessionSchema.parse(JSON.parse(decoder.decode(fromBase64Url(encoded))))
    return payload.expiresAt > nowSeconds ? payload : null
  } catch {
    return null
  }
}

export async function readShareSessionHash(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, SHARE_COOKIE)
  if (!token) return null
  try {
    const material = await readCryptoMaterial(c.env.DATA)
    const payload = await verifyShareSessionToken(token, material.sessionKey)
    return payload?.tokenHash ?? null
  } catch {
    return null
  }
}

export async function issueShareSession(c: Context<AppEnv>, tokenHash: string): Promise<string> {
  const material = await readCryptoMaterial(c.env.DATA)
  const nowSeconds = Math.floor(Date.now() / 1_000)
  setCookie(c, SHARE_COOKIE, await createShareSessionToken(tokenHash, material.sessionKey, nowSeconds), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/api/shares/',
    maxAge: SHARE_SESSION_TTL_SECONDS,
  })
  return new Date((nowSeconds + SHARE_SESSION_TTL_SECONDS) * 1_000).toISOString()
}
