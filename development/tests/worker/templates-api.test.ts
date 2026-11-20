import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

const ROOT = '/api/admin/system/subscription-templates'
const yaml = `proxy-groups:
  - name: Policy
    type: select
    proxies: ["$SUBPANEL_NODES"]
rules:
  - MATCH,Policy
`
let cookie: string
beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM subscription_template_bindings'),
    env.DB.prepare('UPDATE subscription_template_default SET template_id=NULL, revision=1'),
    env.DB.prepare('DELETE FROM subscription_template_versions'),
    env.DB.prepare('DELETE FROM subscription_templates'),
  ])
  await setupAdmin()
  cookie = await login()
})

function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const init = withCookie(cookie, { method })
  return exports.default.fetch(TEST_ORIGIN + path, body === undefined ? init : jsonRequest(body, init))
}

async function createTemplate(name = 'Policy') {
  const response = await api(ROOT, { name, yaml })
  expect(response.status).toBe(201)
  return await response.json() as { id: string; revision: number; draftHash: string }
}

async function publish(template: Awaited<ReturnType<typeof createTemplate>>) {
  const response = await api(`${ROOT}/${template.id}/publish`, {
    expectedRevision: template.revision, draftHash: template.draftHash,
  })
  expect(response.status).toBe(200)
  return await response.json() as { versionId: string; sequence: number; revision: number }
}

async function versionCount(id: string) {
  return (await env.DB.prepare('SELECT COUNT(*) AS count FROM subscription_template_versions WHERE template_id=?')
    .bind(id).first<{ count: number }>())?.count
}

describe('template revisions and persistence', () => {
  it('returns camelCase paginated metadata and copies only the draft', async () => {
    const original = await createTemplate()
    const published = await publish(original)
    const list = await (await api(ROOT + '?q=policy&pageSize=1')).json()
    expect(list).toMatchObject({ total: 1, page: 1, defaultRevision: 1,
      templates: [{ id: original.id, status: 'published', publishedVersionId: published.versionId }] })
    expect(JSON.stringify(list)).not.toContain('$SUBPANEL_NODES')
    expect(await (await api(`${ROOT}/${original.id}/versions/${published.versionId}`)).json()).toMatchObject({
      sequence: 1, createdBy: 'usr_1', yaml,
    })
    const copied = await api(`${ROOT}/${original.id}/copy`, { name: 'Copy' })
    expect(copied.status).toBe(201)
    const { id } = await copied.json() as { id: string }
    expect(await (await api(`${ROOT}/${id}`)).json()).toMatchObject({ draft: yaml, status: 'draft', publishedVersionId: null })
    expect(await versionCount(id)).toBe(0)
  })

  it('allows one concurrent draft save and one concurrent publication per revision', async () => {
    const template = await createTemplate()
    const path = `${ROOT}/${template.id}`
    const save = (name: string) => api(path, { name, yaml, expectedRevision: 1 }, 'PUT')
    const edits = await Promise.all([save('First'), save('Second')])
    expect(edits.map(response => response.status).sort()).toEqual([200, 409])
    const revision = await edits.find(response => response.ok)!.json() as { revision: number; draftHash: string }
    const attempt = (expectedRevision: number) => api(path + '/publish', { expectedRevision, draftHash: revision.draftHash })
    const conflict = await attempt(1)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'TEMPLATE_CONFLICT' } })
    const outcomes = await Promise.all([attempt(revision.revision), attempt(revision.revision)])
    expect(outcomes.map(response => response.status).sort()).toEqual([200, 409])
    expect(await versionCount(template.id)).toBe(1)
    expect(await (await api(path)).json()).toMatchObject({ status: 'published', revision: 3 })
  })

  it('rolls the version insert back when switching the published pointer fails', async () => {
    const { id, draftHash } = await createTemplate()
    await env.DB.prepare(`
      CREATE TRIGGER test_reject_publication BEFORE UPDATE OF published_id ON subscription_templates
      BEGIN SELECT RAISE(ABORT, 'test publication failure'); END
    `).run()
    try {
      const failed = await api(`${ROOT}/${id}/publish`, { expectedRevision: 1, draftHash })
      expect(failed.status).toBe(500)
      expect(await versionCount(id)).toBe(0)
      expect(await (await api(`${ROOT}/${id}`)).json()).toMatchObject({ revision: 1, publishedVersionId: null })
    } finally {
      await env.DB.prepare('DROP TRIGGER test_reject_publication').run()
    }
  })

  it.each(['default', 'binding'])('serializes archive against setting the %s reference', async kind => {
    const template = await createTemplate()
    const { revision } = await publish(template)
    const created = await api('/api/admin/subscriptions', { name: 'Example', groupIds: [] })
    expect(created.status).toBe(201)
    const { subscription } = await created.json() as { subscription: { id: string } }
    const reference = kind === 'default'
      ? api(ROOT + '/default', { templateId: template.id, expectedRevision: 1 }, 'PUT')
      : api(`${ROOT}/bindings/${subscription.id}`, { mode: 'specific', templateId: template.id, expectedRevision: 1 }, 'PUT')
    const archivePath = `${ROOT}/${template.id}/archive`
    const archive = api(archivePath, { expectedRevision: revision })
    const [selected, archived] = await Promise.all([reference, archive])
    expect([selected.status, archived.status].sort()).toEqual([200, 409])

    const binding = await (await api(`${ROOT}/bindings/${subscription.id}`)).json()
    if (selected.ok) {
      expect(await archived.json()).toMatchObject({ error: { code: 'TEMPLATE_REFERENCED', details: {
        references: kind === 'default'
          ? { isDefault: true, directBindings: 0, inheritedCount: 1 }
          : { isDefault: false, directBindings: 1, inheritedCount: 0 },
      } } })
      expect(binding).toMatchObject({ effectiveTemplate: { templateId: template.id } })
    } else {
      expect(await selected.json()).toMatchObject({ error: { code: 'TEMPLATE_CONFLICT' } })
      expect(binding).toMatchObject({ effectiveTemplate: null })
    }
  })

  it('writes subscription and binding atomically and deletes the binding in D1', async () => {
    const { id } = await createTemplate()
    const template = await (await api(`${ROOT}/${id}`)).json() as Awaited<ReturnType<typeof createTemplate>>
    await publish(template)
    const specific = { mode: 'specific', templateId: id, expectedRevision: 1 }
    const create = (templateBinding: unknown) => api('/api/admin/subscriptions', { name: 'Example', groupIds: [], templateBinding })
    const staleCreate = await create({ ...specific, expectedRevision: 2 })
    expect(staleCreate.status).toBe(409)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM subscriptions').first()).toMatchObject({ count: 0 })

    const created = await create(specific)
    expect(created.status).toBe(201)
    const { subscription } = await created.json() as { subscription: { id: string } }
    const path = `/api/admin/subscriptions/${subscription.id}`
    const bindingPath = `${ROOT}/bindings/${subscription.id}`
    expect(await (await api(bindingPath)).json()).toMatchObject({ mode: 'specific', templateId: id, revision: 2 })
    const stale = await api(path, { name: 'Stale name', templateBinding: { mode: 'base', expectedRevision: 1 } }, 'PATCH')
    expect(stale.status).toBe(409)
    expect(await env.DB.prepare('SELECT name,revision FROM subscriptions WHERE id=?').bind(subscription.id).first())
      .toMatchObject({ name: 'Example', revision: 1 })
    expect((await api(path, { name: 'New name', templateBinding: { mode: 'base', expectedRevision: 2 } }, 'PATCH')).status).toBe(200)
    expect(await (await api(bindingPath)).json()).toMatchObject({ mode: 'base', templateId: null, revision: 3 })
    expect((await api(path, {}, 'DELETE')).status).toBe(204)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM subscription_template_bindings').first()).toMatchObject({ count: 0 })
  })

  it('rejects inline KV binding before reporting subscription saved', async () => {
    await env.DB.prepare("DELETE FROM system_settings WHERE key='delivery_d1_ready'").run()
    const response = await api('/api/admin/subscriptions', {
      name: 'Example', groupIds: [], templateBinding: { mode: 'base', expectedRevision: 1 },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'TEMPLATE_STORAGE_NOT_READY' } })
    expect(await env.DATA.get('state:delivery')).toBeNull()
  })
})
