import { z } from 'zod'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CRYPTO_KEY = 'system:crypto'

const cryptoMaterialSchema = z.object({
  schemaVersion: z.literal(1),
  encryptionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sessionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: z.iso.datetime(),
})

export const encryptedValueSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-GCM'),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{22,}$/),
})

export type CryptoMaterial = z.infer<typeof cryptoMaterialSchema>
export type EncryptedValue = z.infer<typeof encryptedValueSchema>

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length))
}

export const randomToken = (): string => toBase64Url(randomBytes(32))

export async function hashToken(token: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))))
}

function parseCryptoMaterial(raw: string): CryptoMaterial {
  try {
    return cryptoMaterialSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Crypto material is corrupt')
  }
}

export async function readCryptoMaterial(kv: KVNamespace): Promise<CryptoMaterial> {
  const stored = await kv.get(CRYPTO_KEY)
  if (stored === null) throw new Error('Crypto material is missing')
  return parseCryptoMaterial(stored)
}

export async function getOrCreateCryptoMaterial(kv: KVNamespace): Promise<CryptoMaterial> {
  const stored = await kv.get(CRYPTO_KEY)
  if (stored !== null) return parseCryptoMaterial(stored)

  const material: CryptoMaterial = {
    schemaVersion: 1,
    encryptionKey: toBase64Url(randomBytes(32)),
    sessionKey: toBase64Url(randomBytes(32)),
    createdAt: new Date().toISOString(),
  }
  // ponytail: first-run key creation is last-writer-wins; serialize setup externally if concurrent initialization becomes a real deployment pattern.
  await kv.put(CRYPTO_KEY, JSON.stringify(material))
  return material
}

async function importAesKey(encodedKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64Url(encodedKey), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptText(value: string, encodedKey: string): Promise<EncryptedValue> {
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await importAesKey(encodedKey),
    encoder.encode(value),
  )
  return {
    version: 1,
    algorithm: 'AES-GCM',
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  }
}

export async function decryptText(value: EncryptedValue, encodedKey: string): Promise<string> {
  const parsed = encryptedValueSchema.parse(value)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(parsed.iv) },
    await importAesKey(encodedKey),
    fromBase64Url(parsed.ciphertext),
  )
  return decoder.decode(plaintext)
}

async function importHmacKey(encodedKey: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromBase64Url(encodedKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

export async function signHmac(value: string, encodedKey: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await importHmacKey(encodedKey, 'sign'), encoder.encode(value))
  return toBase64Url(new Uint8Array(signature))
}

export async function verifyHmac(value: string, signature: string, encodedKey: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await importHmacKey(encodedKey, 'verify'),
      fromBase64Url(signature),
      encoder.encode(value),
    )
  } catch {
    return false
  }
}
