import type { PasswordHash } from './schema.js'
import { fromBase64Url, toBase64Url } from '../platform/crypto.js'

const encoder = new TextEncoder()
export const PASSWORD_ITERATIONS = 100_000

async function derive(password: string, salt: string, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: fromBase64Url(salt),
      iterations,
    },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(
  password: string,
  iterations = PASSWORD_ITERATIONS,
): Promise<PasswordHash> {
  const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  return {
    algorithm: 'PBKDF2-SHA-256',
    iterations,
    salt,
    hash: toBase64Url(await derive(password, salt, iterations)),
  }
}

export async function verifyPassword(password: string, record: PasswordHash): Promise<boolean> {
  const actual = await derive(password, record.salt, record.iterations)
  const expected = fromBase64Url(record.hash)
  return actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected)
}
