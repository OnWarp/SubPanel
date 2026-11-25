import { expect, it } from 'vitest'
import { randomSubscriptionToken, tokenPattern } from '../../../worker/delivery/subscription-token'

it('issues a 16 character token and still accepts a legacy 43 character token', () => {
  const issued = randomSubscriptionToken()
  expect(issued).toHaveLength(16)
  expect(issued).not.toMatch(/[^A-Za-z0-9]/u)
  expect(tokenPattern.test(issued)).toBe(true)

  const legacy = `${'A'.repeat(20)}_${'b'.repeat(10)}-${'C'.repeat(11)}`
  expect(legacy).toHaveLength(43)
  expect(tokenPattern.test(legacy)).toBe(true)
  expect(tokenPattern.test('A'.repeat(15))).toBe(false)
  expect(tokenPattern.test('A'.repeat(17))).toBe(false)
  expect(tokenPattern.test(`${'A'.repeat(4)}-${'B'.repeat(4)}-${'C'.repeat(4)}`)).toBe(false)
  expect(tokenPattern.test('')).toBe(false)
})
