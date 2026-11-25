import { exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

beforeEach(setupContractedAdmin)

it('retires delivery template and conversion management while keeping entitlement templates available', async () => {
  const auth = withCookie(await login())
  for (const path of ['/api/admin/system/subscription-templates', '/api/admin/system/conversion-profiles']) {
    expect((await exports.default.fetch(TEST_ORIGIN + path, auth)).status).toBe(404)
    expect((await exports.default.fetch(TEST_ORIGIN + path, jsonRequest({}, auth))).status).toBe(404)
  }
  expect((await exports.default.fetch(TEST_ORIGIN + '/api/admin/subscription-templates', auth)).status).toBe(200)
})
