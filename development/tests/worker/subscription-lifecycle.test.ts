import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { bindFixtureTemplate, jsonRequest, login, setupContractedAdmin, TEST_ORIGIN, withCookie } from './helpers'

beforeEach(setupContractedAdmin)

it('keeps authorization windows consistent across the user summary and public download', async () => {
  const auth = withCookie(await login())
  const summary = () => exports.default.fetch(TEST_ORIGIN + '/api/user/subscription', auth)
  const source = await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog/sources',
    jsonRequest({ type: 'manual', name: 'Lifecycle', content: `ss://${btoa('aes-128-gcm:fixture')}@lifecycle.example:8388#Lifecycle` }, auth))
  expect(source.status).toBe(201)
  const { nodes } = await (await exports.default.fetch(TEST_ORIGIN + '/api/admin/catalog', auth)).json<{ nodes: { id: string }[] }>()
  const { status, subscriptionUrl } = await (await summary()).json<{ status: string; subscriptionUrl: string }>()
  expect(status).toBe('none')
  const path = new URL(subscriptionUrl).pathname
  const pull = (tag?: string) => exports.default.fetch(TEST_ORIGIN + path + '/mihomo', {
    headers: tag ? { 'If-None-Match': tag } : undefined,
  })
  expect((await pull()).status).toBe(404)
  const now = Date.now()
  const template = await bindFixtureTemplate('usr_1', {
    name: 'Lifecycle authorization', nodeIds: [nodes[0].id], startsAt: now + 60_000, expiresAt: now + 120_000,
  })
  expect(await (await summary()).json()).toMatchObject({ status: 'pending' })
  expect((await pull()).status).toBe(403)
  const changeWindow = (startsAt: number, expiresAt: number) =>
    env.DB.prepare('UPDATE user_template_bindings SET starts_at=?,expires_at=? WHERE template_id=?')
      .bind(startsAt, expiresAt, template.id).run()
  await changeWindow(now - 10_000, now + 60_000)
  const active = await pull()
  expect(active.status).toBe(200)
  expect(await (await summary()).json()).toMatchObject({ status: 'active', nodeCount: 1 })
  const tag = active.headers.get('etag')!
  expect((await pull(tag)).status).toBe(304)
  await changeWindow(now - 10_000, now - 1_000)
  expect(await (await summary()).json()).toMatchObject({ status: 'expired', nodeCount: 0 })
  expect((await pull(tag)).status).toBe(410)
  expect((await exports.default.fetch(TEST_ORIGIN + '/api/user/subscription/reset-token', jsonRequest({}, auth))).status).toBe(200)
  expect((await pull(tag)).status).toBe(404)
})
