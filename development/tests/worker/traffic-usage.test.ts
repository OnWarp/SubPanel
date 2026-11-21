import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { savePlan } from '../../../worker/delivery/plans'
import {
  BYTES_PER_TRAFFIC_GB,
  attachTrafficUsage,
  measuredTrafficForSubscription,
  trafficUsageFromMeasurement,
} from '../../../worker/delivery/traffic-usage'
import { createFixtureAccount, enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

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
  beforeEach(async () => {
    await resetData()
    await enableD1Modules()
    await setupAdmin()
  })

  it('keeps usedGb and remainingGb off the user summary and subscription payloads', async () => {
    const admin = await login()
    const plan = await savePlan(env.DB, {
      name: 'Quota',
      groupIds: [],
      durationDays: 30,
      trafficGb: 100,
      speedLimitMbps: 0,
      deviceLimit: 0,
    })
    const account = await createFixtureAccount('traffic-user', 'traffic user password')
    const { user } = await account.json() as { user: { id: string } }
    const created = await exports.default.fetch(
      `${TEST_ORIGIN}/api/admin/subscriptions`,
      jsonRequest({ userId: user.id, name: '主订阅', planId: plan.id, groupIds: [] }, withCookie(admin)),
    )
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { subscription: { id: string; trafficGb: number } }
    expect(createdBody.subscription.trafficGb).toBe(100)
    expect(createdBody.subscription).not.toHaveProperty('usedGb')
    expect(createdBody.subscription).not.toHaveProperty('remainingGb')

    const userCookie = await login('traffic-user', 'traffic user password')
    const mine = await (await exports.default.fetch(`${TEST_ORIGIN}/api/account/subscriptions`, withCookie(userCookie))).json() as {
      subscriptions: Array<Record<string, unknown>>
    }
    expect(mine.subscriptions).toHaveLength(1)
    expect(mine.subscriptions[0]).toMatchObject({
      id: createdBody.subscription.id,
      trafficGb: 100,
      planId: plan.id,
      name: '主订阅',
    })
    expect(mine.subscriptions[0]).not.toHaveProperty('usedGb')
    expect(mine.subscriptions[0]).not.toHaveProperty('remainingGb')

    const summary = await (await exports.default.fetch(`${TEST_ORIGIN}/api/account/entitlement`, withCookie(userCookie))).json() as {
      state: string
      latest: { plan: { trafficGb: number } } | null
    }
    expect(summary.state).toBe('active')
    expect(summary.latest?.plan.trafficGb).toBe(100)
    expect(summary).not.toHaveProperty('usedGb')
    expect(summary).not.toHaveProperty('remainingGb')

    const reset = await exports.default.fetch(
      `${TEST_ORIGIN}/api/account/subscriptions/${createdBody.subscription.id}/token/reset`,
      jsonRequest({}, withCookie(userCookie)),
    )
    expect(reset.status).toBe(200)
    const resetBody = await reset.json() as { subscription: Record<string, unknown> }
    expect(resetBody.subscription.trafficGb).toBe(100)
    expect(resetBody.subscription).not.toHaveProperty('usedGb')
    expect(resetBody.subscription).not.toHaveProperty('remainingGb')
  })
})
