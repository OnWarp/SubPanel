import { fetchRemoteText, RemoteFetchError } from '../catalog/remote.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { parse } from 'yaml'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { getSubscription } from '../delivery/service.js'
import { renderEntitledSubscription } from '../delivery/compiler.js'
import { getUserEntitlement } from '../entitlements/service.js'
import { binding, getTemplate, requirePublished, getDefault, getEffectiveTemplate, checkTemplateReferences, computeDraftHash } from './repository.js'
import { validateTemplate, VALIDATOR_VERSION } from './validation.js'

export const templateRoutes = new Hono<AppEnv>()

const draftSchema = z.object({
  name: z.string().trim().min(1).max(128),
  yaml: z.string().max(5 * 1024 * 1024),
})

const publishSchema = z.object({
  expectedRevision: z.number().int().positive(),
  draftHash: z.string().optional(),
  ignoredAcknowledged: z.boolean().optional(),
})

const rollbackSchema = z.object({
  versionId: z.string(),
  expectedRevision: z.number().int().positive(),
})

const archiveSchema = z.object({
  expectedRevision: z.number().int().positive(),
})

const importSchema = z.object({
  url: z.string().max(4096),
  expectedRevision: z.number().int().positive().optional(),
  ifNoneMatch: z.string().optional(),
  ifModifiedSince: z.string().optional(),
})

const defaultSchema = z.object({
  templateId: z.string().nullable(),
  expectedRevision: z.number().int().positive(),
})

const bindingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('specific'), templateId: z.string().min(1), expectedRevision: z.number().int().positive() }),
  z.object({ mode: z.enum(['inherit', 'base']), templateId: z.null().optional(), expectedRevision: z.number().int().positive() }),
])

const previewSchema = z.object({
  yaml: z.string().max(5 * 1024 * 1024),
  subscriptionId: z.string().optional(),
})

const validateSchema = z.object({
  yaml: z.string().max(5 * 1024 * 1024),
})

async function listTemplates(db: D1Database, opts: { q?: string; page: number; pageSize: number; archived?: boolean }) {
  const { q, page, pageSize, archived } = opts
  const offset = (page - 1) * pageSize

  let where = archived ? 'WHERE archived=1' : 'WHERE archived=0'
  const params: (string | number)[] = []

  if (q) {
    where += ` AND name LIKE ?`
    params.push(`%${q}%`)
  }

  const total = await db.prepare(`SELECT COUNT(*) as count FROM subscription_templates ${where}`).bind(...params).first<{ count: number }>()

  const results = await db.prepare(`
    SELECT t.*, v.created_at AS published_at
    FROM subscription_templates t
    LEFT JOIN subscription_template_versions v ON v.id = t.published_id
    ${where}
    ORDER BY t.updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, pageSize, offset).all()

  return { results: results.results, total: total?.count ?? 0 }
}

async function getReferencedSummary(db: D1Database, templateId: string) {
  const refs = await checkTemplateReferences(db, templateId)
  const parts: string[] = []
  if (refs.isDefault) parts.push('全局默认')
  if (refs.directBindings > 0) parts.push(`直接绑定 ${refs.directBindings} 条`)
  if (refs.inheritedCount > 0) parts.push(`继承默认影响 ${refs.inheritedCount} 条`)
  return { ...refs, summary: parts.join('，') }
}

function templateToDTO(row: Awaited<ReturnType<typeof getTemplate>>, version: Awaited<ReturnType<typeof requirePublished>> | null = null) {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    draftHash: row.draft_hash,
    status: row.archived ? 'archived' : (row.published_id ? 'published' : 'draft'),
    publishedVersionId: row.published_id ?? null,
    sourceUrl: row.source_url,
    sourceFetchedAt: row.source_fetched_at,
    sourceEtag: row.source_etag,
    sourceLastModified: row.source_last_modified,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    // Legacy field for backward compatibility
    draft: row.draft,
  }
}

templateRoutes.get('/', async c => {
  const q = c.req.query('q')?.trim()
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') ?? '20', 10)))
  const archived = c.req.query('archived') === 'true'

  const { results, total } = await listTemplates(c.env.DB, { q, page, pageSize, archived })

  const templates = await Promise.all(results.map(async (row: any) => {
    const refs = await getReferencedSummary(c.env.DB, row.id)
    return {
      ...templateToDTO(row),
      references: refs,
    }
  }))

  const currentDefault = await getDefault(c.env.DB)
  return c.json({ templates, defaultId: currentDefault.template_id, total, page, pageSize })
})

templateRoutes.post('/', async c => {
  const input = await readJson(c, draftSchema)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const draftHash = computeDraftHash(input.yaml)

  await c.env.DB.prepare(
    `INSERT INTO subscription_templates (id, name, draft, published_id, archived, source_url, updated_at, revision, draft_hash, created_at)
     VALUES (?, ?, ?, NULL, 0, NULL, ?, 1, ?, ?)`
  ).bind(id, input.name, input.yaml, now, draftHash, now).run()

  return c.json({ id, revision: 1, draftHash }, 201)
})

templateRoutes.get('/:id', async c => {
  const row = await getTemplate(c.env.DB, c.req.param('id'), true)
  let version = null
  if (row.published_id) {
    version = await c.env.DB.prepare(
      'SELECT * FROM subscription_template_versions WHERE id=? AND template_id=?'
    ).bind(row.published_id, row.id).first()
  }
  const refs = await getReferencedSummary(c.env.DB, row.id)
  return c.json({ ...templateToDTO(row, version), references: refs })
})

templateRoutes.put('/:id', async c => {
  const input = await readJson(c, draftSchema)
  const id = c.req.param('id')
  const expectedRevision = Number(c.req.query('expectedRevision'))

  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
    throw apiError(400, 'TEMPLATE_INVALID', 'expectedRevision 必须为正整数')
  }

  const row = await getTemplate(c.env.DB, id, true)

  if (row.revision !== expectedRevision) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '配置已被修改，请刷新后重试')
  }

  const now = new Date().toISOString()
  const draftHash = computeDraftHash(input.yaml)

  await c.env.DB.prepare(
    `UPDATE subscription_templates SET name=?, draft=?, draft_hash=?, updated_at=?, revision=revision+1
     WHERE id=? AND revision=?`
  ).bind(input.name, input.yaml, draftHash, now, id, expectedRevision).run()

  return c.json({ ok: true, revision: expectedRevision + 1, draftHash })
})

templateRoutes.post('/validate', async c => {
  const input = await readJson(c, validateSchema)
  try {
    const result = validateTemplate(input.yaml)
    return c.json({
      normalized: result.normalized,
      ignored: result.ignored,
      diagnostics: result.diagnostics,
      contentHash: result.contentHash,
      validatorVersion: VALIDATOR_VERSION,
    })
  } catch (e) {
    throw apiError(422, 'TEMPLATE_INVALID', e instanceof Error ? e.message : '配置无效')
  }
})

templateRoutes.post('/preview', async c => {
  const input = await readJson(c, previewSchema)
  const { template, ignored, diagnostics } = validateTemplate(input.yaml)

  if (!input.subscriptionId) {
    return c.json({
      ignored,
      diagnostics,
      groups: template['proxy-groups'],
      rules: template.rules,
      ruleProviders: template['rule-providers'] ?? {},
      subscriptionName: null,
      outputNodes: null,
      effectiveVersionId: null,
      zeroNodeReason: null,
    })
  }

  const subscription = await getSubscription(c.env, input.subscriptionId)
  const artifact = await renderEntitledSubscription(c.env, subscription, 'mihomo', undefined, template)

  const rights = await getUserEntitlement(c.env.DB, subscription.userId ?? '')
  const current = rights.current
  let reason: string | null = null

  if (!current) reason = '无有效权益'
  else if (!subscription.groupIds.some(id => current.plan.groupIds.includes(id))) reason = '分组无交集'
  else if (artifact.inputNodes === 0) reason = '组内无启用节点'
  else if (artifact.outputNodes === 0) reason = '格式不兼容'

  const output = parse(artifact.body) as Record<string, unknown>

  return c.json({
    ignored,
    diagnostics,
    groups: output['proxy-groups'],
    rules: output.rules,
    ruleProviders: template['rule-providers'] ?? {},
    subscriptionName: subscription.name,
    outputNodes: artifact.outputNodes,
    effectiveVersionId: null, // Preview uses draft, not a published version
    zeroNodeReason: reason,
  })
})

// Explicit admin action only: no cron integration and no retries.
templateRoutes.post('/:id/import', async c => {
  const row = await getTemplate(c.env.DB, c.req.param('id'), true)
  const input = await readJson(c, importSchema)

  if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '配置已被修改，请刷新后重试')
  }

  const headers: Record<string, string> = {}
  if (input.ifNoneMatch) headers['If-None-Match'] = input.ifNoneMatch
  if (input.ifModifiedSince) headers['If-Modified-Since'] = input.ifModifiedSince

  let yaml: string
  try {
    yaml = await fetchRemoteText({ url: input.url, headers })
  } catch (e) {
    throw apiError(422, e instanceof RemoteFetchError ? e.code : 'REMOTE_FETCH_FAILED', '导入失败，请手动重试')
  }

  const result = validateTemplate(yaml)

  // Return candidate only, don't save to draft
  return c.json({
    candidate: {
      yaml,
      ignored: result.ignored,
      diagnostics: result.diagnostics,
      contentHash: result.contentHash,
    },
    source: {
      url: input.url,
      fetchedAt: new Date().toISOString(),
      // Note: ETag and Last-Modified would come from the response headers in a real implementation
      // but fetchRemoteText doesn't return them currently
    },
  })
})

templateRoutes.post('/:id/publish', async c => {
  const row = await getTemplate(c.env.DB, c.req.param('id'), true)
  const input = await readJson(c, publishSchema)

  if (row.revision !== input.expectedRevision) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '配置已被修改，请刷新后重试')
  }

  if (input.draftHash && row.draft_hash !== input.draftHash) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '草稿内容已变更，请刷新后重试')
  }

  // Re-validate draft before publishing
  const validation = validateTemplate(row.draft)

  // Check if there are unacknowledged ignored fields
  if (validation.ignored.length > 0 && !input.ignoredAcknowledged) {
    throw apiError(422, 'TEMPLATE_INVALID', `存在被忽略的字段: ${validation.ignored.join(', ')}，请确认后重试`)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const contentHash = validation.contentHash

  // Atomic batch: create version + update template pointer
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO subscription_template_versions (id, template_id, yaml, created_at, sequence, normalized_json, content_hash, validator_version, created_by)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM subscription_template_versions WHERE template_id = ?), ?, ?, ?, ?)`
    ).bind(id, row.id, row.draft, now, row.id, JSON.stringify(validation.normalized), contentHash, VALIDATOR_VERSION, 'admin'),
    c.env.DB.prepare(
      `UPDATE subscription_templates SET published_id=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?`
    ).bind(id, now, row.id, input.expectedRevision),
  ])

  // Check if template update succeeded (condition matched)
  if (!results[1].meta.changes) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '并发修改导致发布失败，请重试')
  }

  // Get reference summary for response
  const refs = await getReferencedSummary(c.env.DB, row.id)

  return c.json({
    versionId: id,
    sequence: (await c.env.DB.prepare('SELECT sequence FROM subscription_template_versions WHERE id=?').bind(id).first<{sequence: number}>())?.sequence ?? 1,
    contentHash,
    references: refs,
    revision: input.expectedRevision + 1,
  })
})

templateRoutes.get('/:id/versions', async c => {
  await getTemplate(c.env.DB, c.req.param('id'))
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') ?? '20', 10)))
  const offset = (page - 1) * pageSize

  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM subscription_template_versions WHERE template_id=?'
  ).bind(c.req.param('id')).first<{count: number}>()

  const versions = await c.env.DB.prepare(
    'SELECT id, sequence, created_at, content_hash, validator_version, created_by FROM subscription_template_versions WHERE template_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?'
  ).bind(c.req.param('id'), pageSize, offset).all()

  return c.json({ versions: versions.results, total: total?.count ?? 0, page, pageSize })
})

templateRoutes.post('/:id/rollback', async c => {
  const input = await readJson(c, rollbackSchema)
  const id = c.req.param('id')
  const row = await getTemplate(c.env.DB, id, true)

  if (row.revision !== input.expectedRevision) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '配置已被修改，请刷新后重试')
  }

  const version = await c.env.DB.prepare(
    'SELECT id FROM subscription_template_versions WHERE id=? AND template_id=?'
  ).bind(input.versionId, id).first()

  if (!version) throw apiError(404, 'VERSION_NOT_FOUND', '版本不存在')

  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `UPDATE subscription_templates SET published_id=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?`
  ).bind(input.versionId, now, id, input.expectedRevision).run()

  // Audit log would go here

  return c.json({ ok: true, revision: input.expectedRevision + 1 })
})

templateRoutes.post('/:id/archive', async c => {
  const input = await readJson(c, archiveSchema)
  const id = c.req.param('id')
  const row = await getTemplate(c.env.DB, id, true)

  if (row.revision !== input.expectedRevision) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '配置已被修改，请刷新后重试')
  }

  const refs = await checkTemplateReferences(c.env.DB, id)
  if (refs.isDefault || refs.directBindings > 0 || refs.inheritedCount > 0) {
    const summary = await getReferencedSummary(c.env.DB, id)
    throw apiError(409, 'TEMPLATE_REFERENCED', `配置正在被引用：${summary.summary}`)
  }

  await c.env.DB.prepare(
    `UPDATE subscription_templates SET archived=1, updated_at=?, revision=revision+1 WHERE id=? AND revision=?`
  ).bind(new Date().toISOString(), id, input.expectedRevision).run()

  return c.json({ ok: true, revision: input.expectedRevision + 1 })
})

templateRoutes.put('/default', async c => {
  const input = await readJson(c, defaultSchema)
  const currentDefault = await getDefault(c.env.DB)

  if (currentDefault.revision !== input.expectedRevision) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '默认配置已被修改，请刷新后重试')
  }

  if (input.templateId) {
    await requirePublished(c.env.DB, input.templateId)
  }

  const now = new Date().toISOString()
  const updated = await c.env.DB.prepare(
    `UPDATE subscription_template_default SET template_id=?, revision=revision+1, updated_at=? WHERE id=1 AND revision=?`
  ).bind(input.templateId, now, input.expectedRevision).run()

  if (!updated.meta.changes) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '并发修改导致默认配置更新失败，请重试')
  }

  const refs = input.templateId ? await getReferencedSummary(c.env.DB, input.templateId) : { isDefault: false, directBindings: 0, inheritedCount: 0, summary: '' }

  return c.json({ ok: true, revision: input.expectedRevision + 1, references: refs })
})

templateRoutes.get('/bindings/:id', async c => {
  await getSubscription(c.env, c.req.param('id'))
  const b = await binding(c.env.DB, c.req.param('id'))
  let effective = null
  if (b.mode !== 'base' && b.template_id) {
    const tpl = await getEffectiveTemplate(c.env.DB, c.req.param('id'))
    if (tpl) {
      effective = {
        templateId: tpl.template.id,
        templateName: tpl.template.name,
        versionId: tpl.version.id,
        sequence: tpl.version.sequence,
      }
    }
  }
  return c.json({ ...b, effectiveTemplate: effective })
})

templateRoutes.put('/bindings/:id', async c => {
  await getSubscription(c.env, c.req.param('id'))
  const input = await readJson(c, bindingSchema)

  if (input.mode === 'specific') {
    await requirePublished(c.env.DB, input.templateId)
  }

  const templateId = input.templateId ?? null
  const now = new Date().toISOString()

  // Check template availability if specific
  let availabilityCheck = '1=1'
  const checkParams: (string | null)[] = []
  if (templateId) {
    availabilityCheck = 'EXISTS(SELECT 1 FROM subscription_templates WHERE id=? AND archived=0 AND published_id IS NOT NULL)'
    checkParams.push(templateId)
  }

  const updated = await c.env.DB.prepare(
    `INSERT INTO subscription_template_bindings (subscription_id, mode, template_id, revision, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(subscription_id) DO UPDATE SET
       mode=excluded.mode,
       template_id=excluded.template_id,
       revision=subscription_template_bindings.revision+1,
       updated_at=excluded.updated_at
     WHERE ${availabilityCheck}`
  ).bind(c.req.param('id'), input.mode, templateId, now, ...checkParams).run()

  if (!updated.meta.changes) {
    throw apiError(409, 'TEMPLATE_UNAVAILABLE', '配置不可用，请刷新重试')
  }

  return c.json({ ok: true, revision: input.expectedRevision + 1 })
})