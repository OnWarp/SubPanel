import { z } from 'zod'
import { fromBase64Url, toBase64Url } from '../platform/crypto.js'
import { apiError } from '../platform/api-error.js'

// 30 symbols, excluding letters and digits that are easy to confuse.
const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const canonical = new RegExp(`^[${alphabet}]{28}$`, 'u')
const encoder = new TextEncoder()
const hmac = { name: 'HMAC', hash: 'SHA-256' }
const keyVersion = z.string().regex(/^[a-z0-9]{1,16}$/u)
const keyringSchema = z.object({
  active: keyVersion,
  keys: z.record(keyVersion, z.string().regex(/^[A-Za-z0-9_-]{43}$/u)),
}).strict()

export function generateCode() {
  let code = ''
  const ceiling = 256 - 256 % alphabet.length
  while (code.length < 28) {
    for (const value of crypto.getRandomValues(new Uint8Array(40))) {
      if (value < ceiling) code += alphabet[value % alphabet.length]
      if (code.length === 28) break
    }
  }
  return { canonical: code, display: code.match(/.{4}/gu)!.join('-') }
}

export function normalizeCode(input: string) {
  if (input.length > 100) return null
  const code = input.replace(/[\s-]/gu, '').toUpperCase()
  return canonical.test(code) ? code : null
}

export async function readKeyring(secret: string | undefined) {
  try {
    const { active, keys } = keyringSchema.parse(JSON.parse(secret ?? 'null'))
    const entries = Object.entries(keys)
    if (!Object.hasOwn(keys, active) || entries.length > 4) throw new Error('Invalid keyring')
    const imported = await Promise.all(entries.map(async ([version, value]) => {
      const bytes = fromBase64Url(value)
      if (bytes.length !== 32 || toBase64Url(bytes) !== value) throw new Error('Invalid key')
      const key = await crypto.subtle.importKey('raw', bytes, hmac, false, ['sign', 'verify'])
      return [version, key] as const
    }))
    return { active, keys: new Map(imported) }
  } catch {
    throw apiError(500, 'REDEMPTION_UNAVAILABLE', '兑换服务暂不可用')
  }
}

export async function codeDigest(key: CryptoKey, code: string) {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`code:${code}`))))
}

function previewMessage(user: string, digest: string, deadline: number) {
  return encoder.encode(JSON.stringify(['preview', user, digest, deadline]))
}

export async function issuePreview(key: CryptoKey, user: string, digest: string) {
  const deadline = Date.now() + 5 * 60_000
  const signature = await crypto.subtle.sign('HMAC', key, previewMessage(user, digest, deadline))
  return `${deadline}.${toBase64Url(new Uint8Array(signature))}`
}

export async function verifyPreview(key: CryptoKey, user: string, digest: string, proof: string) {
  const [timestamp, mac] = proof.split('.')
  const deadline = Number(timestamp)
  return deadline > Date.now()
    && await crypto.subtle.verify('HMAC', key, fromBase64Url(mac), previewMessage(user, digest, deadline))
}


// A receipt can authenticate the original retry after its issuance key retires.
// The client supplies the preview signature; the database only has the verifier.
export async function receiptVerifier(code: string, proof: string) {
  const key = await crypto.subtle.importKey('raw', fromBase64Url(proof.split('.')[1]), hmac, false, ['sign', 'verify'])
  const message = encoder.encode(JSON.stringify(['receipt', code, proof]))
  return {
    sign: async () => toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, message))),
    matches: (digest: string) => crypto.subtle.verify('HMAC', key, fromBase64Url(digest), message),
  }
}
