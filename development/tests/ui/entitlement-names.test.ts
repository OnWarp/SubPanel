import { expect, it } from 'vitest'
import { distinguishTemplateName, type EntitlementTemplate } from '../../../src/features/delivery/entitlement-types'

function template(id: string, name: string, ownerUserId: string | null = null): EntitlementTemplate {
  return {
    id,
    name,
    description: '',
    status: 'enabled',
    allowRedemption: false,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    subscriptionCount: 0,
    boundUserCount: 0,
    ownerUserId,
    currentVersion: {
      id: `${id}-v1`,
      number: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'usr_1',
      config: {
        duration: { value: 7, unit: 'day' },
        quotaBytes: null,
        resetPolicy: 'none',
        groupIds: [],
        nodeIds: [],
        limits: { speedLimitMbps: 0 },
      },
    },
  }
}

it('keeps a unique template name and disambiguates shared, exclusive and id collisions', () => {
  const shared = template('shared0001aaaa', '标准')
  expect(distinguishTemplateName(shared, [shared])).toBe('标准')

  const exclusive = template('private0001bbbb', '标准', 'usr_2')
  const pair = [shared, exclusive]
  expect(distinguishTemplateName(shared, pair)).toBe('标准（共享）')
  expect(distinguishTemplateName(exclusive, pair)).toBe('标准（专属）')

  const otherShared = template('other0002cccc', '标准')
  const sameScope = [shared, otherShared]
  expect(distinguishTemplateName(shared, sameScope)).toBe('标准（共享 · shared00）')
  expect(distinguishTemplateName(otherShared, sameScope)).toBe('标准（共享 · other000）')

  const collision = template('shared0001zzzz', '标准')
  const collided = [shared, collision]
  expect(distinguishTemplateName(shared, collided)).toBe('标准（共享 · shared0001aaaa）')
  expect(distinguishTemplateName(collision, collided)).toBe('标准（共享 · shared0001zzzz）')
})
