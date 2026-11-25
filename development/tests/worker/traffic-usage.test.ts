import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BYTES_PER_TRAFFIC_GB,
  attachTrafficUsage,
  measuredTrafficForSubscription,
  trafficUsageFromMeasurement,
} from '../../../worker/delivery/traffic-usage'
import { bindFixtureTemplate, createFixtureAccount, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

const gib = (value: number) => value * BYTES_PER_TRAFFIC_GB

describe('traffic usage seam', () => {
  it('converts a measured byte counter into the same GB unit as trafficGb', () => {
    expect(trafficUsageFromMeasurement(100, { uploadBytes: gib(1), downloadBytes: gib(0.5) })).toEqual({
      usedGb: 1.5,
      remainingGb: 98.5,
    })
    expect(trafficUsageFromMeasurement(0.5, { uploadBytes: 0, downloadBytes: 0 })).toEqual({ usedGb: 0, remainingGb: 0.5 })
    expect(trafficUsageFromMeasurement(1, { uploadBytes: gib(2), downloadBytes: 1 })).toEqual({
      usedGb: 2 + 1 / BYTES_PER_TRAFFIC_GB,
      remainingGb: 0,
    })
    expect(trafficUsageFromMeasurement(0, { uploadBytes: gib(4), downloadBytes: 0 })).toEqual({ usedGb: 4, remainingGb: null })
    expect(trafficUsageFromMeasurement(42, null)).toBeNull()
    expect(trafficUsageFromMeasurement(Number.NaN, { uploadBytes: 0, downloadBytes: 0 })).toBeNull()
    expect(trafficUsageFromMeasurement(-1, { uploadBytes: 0, downloadBytes: 0 })).toBeNull()
    expect(trafficUsageFromMeasurement(10, { uploadBytes: 1.5, downloadBytes: 0 })).toBeNull()
    expect(trafficUsageFromMeasurement(10, { uploadBytes: -1, downloadBytes: 0 })).toBeNull()
    expect(trafficUsageFromMeasurement(10, { uploadBytes: Number.MAX_SAFE_INTEGER, downloadBytes: 1 })).toBeNull()
  })

  it('adds the fields only for a real measurement and leaves the quota untouched', () => {
    const body = { id: 'sub_1', trafficGb: 100, name: '主订阅' }
    expect(attachTrafficUsage(body, body.trafficGb, null)).toBe(body)
    expect(attachTrafficUsage(body, body.trafficGb, measuredTrafficForSubscription(body.id))).toEqual(body)
    expect(attachTrafficUsage(body, body.trafficGb, { uploadBytes: gib(20), downloadBytes: gib(5) })).toEqual({
      ...body,
      usedGb: 25,
      remainingGb: 75,
    })
    expect(measuredTrafficForSubscription(null)).toBeNull()
    expect(body).toEqual({ id: 'sub_1', trafficGb: 100, name: '主订阅' })
  })
})

describe('user traffic fields stay absent without a meter', () => {
  beforeEach(setupContractedAdmin)

  it('keeps usedGb and remainingGb off the unified subscription and entitlement summaries', async () => {
    const account = await createFixtureAccount('traffic-user', 'traffic user password')
    const { user } = await account.json() as { user: { id: string } }
    const auth = withCookie(await login())
    const source = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog/sources', jsonRequest({
      type: 'manual', name: 'Traffic fixture',
      content: `ss://${btoa('aes-128-gcm:fixture')}@traffic.example:8388#Traffic`,
    }, auth))
    expect(source.status).toBe(201)
    const catalog = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog', auth)
    const { nodes } = await catalog.json<{ nodes: { id: string }[] }>()
    await bindFixtureTemplate(user.id, { name: 'Unmetered entitlement', nodeIds: [nodes[0].id] })
    const userCookie = await login('traffic-user', 'traffic user password')

    for (const path of ['/api/user/subscription', '/api/account/entitlement']) {
      const response = await exports.default.fetch(TEST_ORIGIN + path, withCookie(userCookie))
      expect(response.status).toBe(200)
      const summary = await response.json()
      expect(summary).not.toHaveProperty('usedGb')
      expect(summary).not.toHaveProperty('remainingGb')
    }
  })
})
