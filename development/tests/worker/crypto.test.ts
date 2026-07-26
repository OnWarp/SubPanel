import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../../worker/accounts/password'
import {
  decryptText,
  encryptText,
  getOrCreateCryptoMaterial,
  hashToken,
  randomToken,
  readCryptoMaterial,
  signHmac,
  verifyHmac,
} from '../../../worker/platform/crypto'
import { resetData } from './helpers'

beforeEach(resetData)

describe('Web Crypto primitives', () => {
  it('persists valid application keys and round-trips AES-GCM text', async () => {
    const material = await getOrCreateCryptoMaterial(env.DATA)
    expect(await readCryptoMaterial(env.DATA)).toEqual(material)

    const encrypted = await encryptText('sensitive value', material.encryptionKey)
    expect(encrypted.ciphertext).not.toContain('sensitive value')
    await expect(decryptText(encrypted, material.encryptionKey)).resolves.toBe('sensitive value')
  })

  it('generates hashed external tokens and verifies HMAC without direct comparison', async () => {
    const material = await getOrCreateCryptoMaterial(env.DATA)
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await hashToken(token)).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const signature = await signHmac('payload', material.sessionKey)
    await expect(verifyHmac('payload', signature, material.sessionKey)).resolves.toBe(true)
    await expect(verifyHmac('changed', signature, material.sessionKey)).resolves.toBe(false)
  })

  it('hashes Unicode passwords with versioned PBKDF2 parameters', async () => {
    const record = await hashPassword('正确 horse battery staple', 1_000)
    expect(record).toMatchObject({ algorithm: 'PBKDF2-SHA-256', iterations: 1_000 })
    await expect(verifyPassword('正确 horse battery staple', record)).resolves.toBe(true)
    await expect(verifyPassword('wrong password', record)).resolves.toBe(false)

  })
})
