import { z } from 'zod'
import { redemptionAlphabet as alphabet, shortCodeLength } from '../../shared/redemption-code.js'
import { fromBase64Url, toBase64Url } from '../platform/crypto.js'
import { apiError } from '../platform/api-error.js'

const encoder = new TextEncoder()
const hmac = { name: 'HMAC', hash: 'SHA-256' }
const keyVersion = z.string().regex(/^[a-z0-9]{1,16}$/u)
const keyringSchema = z.object({
  active: keyVersion,
  keys: z.record(keyVersion, z.string().regex(/^[A-Za-z0-9_-]{43}$/u)),
}).strict()

const tagLength = 2
const payloadLength = shortCodeLength - tagLength
const tagSpace = alphabet.length ** tagLength

async function shortCodeTag(key: CryptoKey, payload: string) {
  // Map HMAC output to two base-30 symbols without modulo bias.
  const ceiling = 65536 - 65536 % tagSpace
  for (let counter = 0; ; counter += 1) {
    const mac = new DataView(await crypto.subtle.sign('HMAC', key,
      encoder.encode(`redemption-short-tag:${payload}:${counter}`)))
    for (let offset = 0; offset < mac.byteLength; offset += 2) {
      const value = mac.getUint16(offset)
      if (value < ceiling) {
        const tag = value % tagSpace
        return alphabet[Math.floor(tag / alphabet.length)] + alphabet[tag % alphabet.length]
      }
    }
  }
}

export async function generateCode(key: CryptoKey) {
  let payload = ''
  const ceiling = 256 - 256 % alphabet.length
  while (payload.length < payloadLength) {
    for (const value of crypto.getRandomValues(new Uint8Array(payloadLength))) {
      if (value < ceiling) payload += alphabet[value % alphabet.length]
      if (payload.length === payloadLength) break
    }
  }
  return payload + await shortCodeTag(key, payload)
}

export async function matchesCodeTag(key: CryptoKey, code: string) {
  if (code.length !== shortCodeLength) return true
  const expected = await shortCodeTag(key, code.slice(0, payloadLength))
  // Compare both symbols without exiting early on the first mismatch.
  return ((expected.charCodeAt(0) ^ code.charCodeAt(payloadLength))
    | (expected.charCodeAt(1) ^ code.charCodeAt(payloadLength + 1))) === 0
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
