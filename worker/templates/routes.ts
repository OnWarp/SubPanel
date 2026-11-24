import { checkRuleSources, loadSingBoxRuleSets, listLocalRuleSets, listRuleSources, localRuleSet, refreshRuleSource, ruleSource, ruleUsage, ruleUsageQuery, saveLocalRuleSet, systemRuleSet, type RuleVersionSnapshot } from './rule-library.js'
import { stringify } from 'yaml'
import { prepareClientRender, CLIENT_IDS, type RenderNode } from '../renderers/index.js'
import { compileSingBoxConfig, TARGET_SINGBOX_VERSION } from '../renderers/singbox.js'
import { RENDERER_VERSION } from '../renderers/model.js'
import { fetchRemoteTextWithPolicy as fetchRemoteTextWithMetadata } from '../catalog/egress-policy.js'
import { RemoteFetchError } from '../catalog/remote.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { parse } from 'yaml'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { isModuleReady, DELIVERY_D1_READY_KEY, type DataEnv } from '../db/module-switch.js'
import { readDelivery } from '../delivery/repository.js'
import { logAudit } from '../admin/audit.js'
import { DeliveryError, getSubscription } from '../delivery/service.js'
import { renderEntitledSubscription } from '../delivery/compiler.js'
import { bindingSchema, bindingWrite, rethrowBindingError, templateConflict, templateReferencesSql, getTemplate, requirePublished, getDefault, getEffectiveTemplate, isLegacyTemplateVersion, checkTemplateReferences, countInheritedSubscriptions, computeDraftHash, type TemplateRow, type TemplateVersionRow } from './repository.js'
import { validateTemplate, computeContentHash, TemplateValidationError, VALIDATOR_VERSION, MAX_TEMPLATE_BYTES, isHttpsTemplateUrl } from './validation.js'

export const templateRoutes = new Hono<AppEnv>()

const sourceSchema = z.object({
  url: z.string().max(4096).refine(isHttpsTemplateUrl),
  fetchedAt: z.iso.datetime(),
  etag: z.string().max(1024).nullable().optional(),
  lastModified: z.string().max(128).nullable().optional(),
})

const draftSchema = z.object({
  name: z.string().trim().min(1).max(128),
  yaml: z.string().max(MAX_TEMPLATE_BYTES),
  source: sourceSchema.nullable().optional(),
})

const publishSchema = z.object({
  expectedRevision: z.number().int().positive(),
  draftHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  ignoredAcknowledged: z.boolean().optional(),
  singbox: z.boolean().optional(),
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
  expectedRevision: z.number().int().positive(),
  ifNoneMatch: z.string().optional(),
  ifModifiedSince: z.string().optional(),
})

const defaultSchema = z.object({
  templateId: z.string().nullable(),
  expectedRevision: z.number().int().positive(),
})

const previewSchema = z.object({
  yaml: z.string().max(MAX_TEMPLATE_BYTES).optional(),
  subscriptionId: z.string().optional(),
  platform: z.enum(CLIENT_IDS).default('mihomo'),
  profileId: z.string().optional(),
  versionId: z.string().optional(),
  sample: z.boolean().optional(),
}).refine(input => input.yaml !== undefined || input.subscriptionId || (input.profileId && input.versionId))
  .refine(input => !input.versionId || (input.profileId && input.yaml === undefined))
  .refine(input => !(input.sample && input.subscriptionId))

const validateSchema = z.object({
  yaml: z.string().max(MAX_TEMPLATE_BYTES),
})

function pagination(pageParam?: string, sizeParam?: string) {
  const page = Math.min(1_000_000, Math.max(1, Number.parseInt(pageParam ?? '', 10) || 1))
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(sizeParam ?? '', 10) || 20))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

async function subscriptionIds(env: DataEnv) {
  return (await readDelivery(env)).subscriptions.map(subscription => subscription.id)
}

async function getReferencedSummary(env: DataEnv, templateId: string) {
  return checkTemplateReferences(env.DB, templateId, await subscriptionIds(env))
}

function versionSummary(row: TemplateVersionRow) {
  return {
    id: row.id,
    sequence: row.sequence,
    createdAt: row.created_at,
    contentHash: row.content_hash,
    validatorVersion: row.validator_version,
    createdBy: row.created_by,
  }
}

function templateSummary(row: TemplateRow, changed: boolean) {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    status: row.archived ? 'archived' : !row.published_id ? 'draft' : changed ? 'modified' : 'published',
    publishedVersionId: row.published_id,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }
}

templateRoutes.get('/', async c => {
  const { page, pageSize, offset } = pagination(c.req.query('page'), c.req.query('pageSize'))
  const q = c.req.query('q')?.trim() ?? ''
  const archived = Number(c.req.query('archived') === 'true')
  const db = c.env.DB
  const where = "WHERE t.archived=? AND instr(lower(t.name), lower(?))>0"
  const [total, { results }, currentDefault, ids] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM subscription_templates t ${where}`).bind(archived, q).first<{ count: number }>(),
    db.prepare(`
      SELECT t.id, t.name, t.revision, t.archived, t.published_id, t.updated_at, t.created_at,
        t.draft != v.yaml AS changed, v.sequence, v.created_at AS published_at,
        EXISTS(SELECT 1 FROM conversion_profile_versions
               WHERE profile_id=t.id AND id=t.published_id AND platform='singbox') AS singbox_published,
        (SELECT COUNT(*) FROM subscription_template_bindings WHERE mode='specific' AND template_id=t.id) AS direct
      FROM subscription_templates t
      LEFT JOIN subscription_template_versions v ON v.id=t.published_id AND v.template_id=t.id
      ${where}
      ORDER BY t.updated_at DESC, t.id LIMIT ? OFFSET ?
    `).bind(archived, q, pageSize, offset).all<TemplateRow & { changed: number; sequence: number | null; published_at: string | null; singbox_published: number; direct: number }>(),
    getDefault(db),
    subscriptionIds(c.env),
  ])

  const inheritedCount = currentDefault.template_id === null ? 0 : await countInheritedSubscriptions(db, ids)
  const templates = results.map(row => {
    const isDefault = currentDefault.template_id === row.id
    return {
      ...templateSummary(row, Boolean(row.changed)),
      publishedAt: row.published_at,
      publishedSequence: row.sequence,
      singboxPublished: Boolean(row.singbox_published),
      references: { isDefault, directBindings: row.direct, inheritedCount: isDefault ? inheritedCount : 0 },
    }
  })
  return c.json({ templates, defaultId: currentDefault.template_id, defaultRevision: currentDefault.revision, total: total?.count ?? 0, page, pageSize })
})

// D1 allows two million bytes per row, including both copies of a
// published template and its metadata. Leave space for row overhead.
function assertTemplateFitsD1(...parts: string[]) {
  const encoder = new TextEncoder()
  if (parts.reduce((bytes, part) => bytes + encoder.encode(part).byteLength, 0) > 1_990_000) {
    throw apiError(413, 'TEMPLATE_INVALID', '配置超过 D1 单行存储上限')
  }
}

async function createDraft(db: D1Database, input: z.infer<typeof draftSchema>) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  assertTemplateFitsD1(input.yaml)
  const draftHash = await computeDraftHash(input.yaml)
  const source = input.source
  await db.prepare(`
    INSERT INTO subscription_templates (id,name,draft,source_url,updated_at,draft_hash,created_at,source_fetched_at,source_etag,source_last_modified)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(id, input.name, input.yaml, source?.url ?? null, now, draftHash, now,
    source?.fetchedAt ?? null, source?.etag ?? null, source?.lastModified ?? null).run()
  return { id, revision: 1, draftHash }
}

templateRoutes.post('/', async c => c.json(await createDraft(c.env.DB, await readJson(c, draftSchema)), 201))

templateRoutes.get('/rule-sources', async c => {
  c.header('Cache-Control', 'no-store')
  const { page, offset } = pagination(c.req.query('page'), '100')
  const [sources, localSets] = await Promise.all([listRuleSources(c.env.DB, offset), listLocalRuleSets(c.env.DB, offset)])
  return c.json({
    sources: sources.slice(0, 100), localSets: localSets.slice(0, 100), page,
    hasMore: sources.length > 100 || localSets.length > 100,
    system: { ...systemRuleSet, last_success_at: null, error_code: null },
  })
})
templateRoutes.get('/rule-sources/usage', async c => {
  const query = ruleUsageQuery.safeParse(c.req.query())
  if (!query.success) throw apiError(422, 'RULE_SOURCE_INVALID', '规则源标识不正确')
  c.header('Cache-Control', 'no-store')
  return c.json(await ruleUsage(c.env.DB, query.data))
})
templateRoutes.post('/rule-sources/local', async c => {
  await saveLocalRuleSet(c.env.DB, await readJson(c, localRuleSet))
  return c.json({ ok: true })
})
templateRoutes.post('/rule-sources', async c => {
  await refreshRuleSource(c.env.DB, await readJson(c, ruleSource))
  return c.json({ ok: true })
})

templateRoutes.get('/:id', async c => {
  const row = await getTemplate(c.env.DB, c.req.param('id'))
  const version = row.published_id ? await c.env.DB.prepare(
    'SELECT * FROM subscription_template_versions WHERE id=? AND template_id=?'
  ).bind(row.published_id, row.id).first<TemplateVersionRow>() : null
  const singbox = version ? await publishedSingBox(c.env.DB, row.id, version.id) : null
  return c.json({
    ...templateSummary(row, Boolean(version && version.yaml !== row.draft)),
    draft: row.draft,
    draftHash: row.draft_hash ?? await computeDraftHash(row.draft),
    sourceUrl: row.source_url,
    sourceFetchedAt: row.source_fetched_at,
    sourceEtag: row.source_etag,
    sourceLastModified: row.source_last_modified,
    publishedVersion: version && versionSummary(version),
    singboxPublished: Boolean(singbox),
    references: await getReferencedSummary(c.env, row.id),
  })
})

templateRoutes.post('/:id/copy', async c => {
  const { name } = await readJson(c, draftSchema.pick({ name: true }))
  const row = await getTemplate(c.env.DB, c.req.param('id'))
  return c.json(await createDraft(c.env.DB, { name, yaml: row.draft }), 201)
})

function validateForAdmin(yaml: string, legacy = false) {
  try {
    return validateTemplate(yaml, legacy)
  } catch (error) {
    if (!(error instanceof TemplateValidationError)) throw error
    throw apiError(422, 'TEMPLATE_INVALID', '配置校验失败', { diagnostics: error.diagnostics })
  }
}

templateRoutes.post('/validate', async c => {
  const { yaml } = await readJson(c, validateSchema)
  const { normalized, ignored, diagnostics } = validateForAdmin(yaml)
  const sources = await checkRuleSources(c.env.DB, normalized)
  return c.json({ normalized, ignored, diagnostics: [...diagnostics, ...sources], contentHash: await computeContentHash(normalized), validatorVersion: VALIDATOR_VERSION })
})

async function getTemplateSubscription(env: DataEnv, id: string) {
  try {
    return await getSubscription(env, id)
  } catch (error) {
    if (error instanceof DeliveryError && error.code === 'SUBSCRIPTION_NOT_FOUND') {
      throw apiError(404, error.code, '订阅不存在')
    }
    throw error
  }
}

// Deferred platforms retain their existing node-only output format.
const previewNode: RenderNode = {
  id: 'sample', displayName: '示例节点', protocol: 'trojan', server: 'sample.example', port: 443,
  credentials: { password: 'sample-password' }, enabled: true, tls: { enabled: true },
  transport: {}, extensions: {}, plugin: {}, rawVariants: [], sourceIds: [], order: 0, fingerprint: 'preview', retained: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

function previewBody(body: string, platform: (typeof CLIENT_IDS)[number]) {
  if (platform === 'mihomo') {
    const output = parse(body) as Record<string, unknown>
    const proxies = output.proxies as { name: string; type: string }[]
    return stringify({ ...output, proxies: proxies.map(({ name, type }) => ({ name, type })) })
  }
  if (platform === 'singbox') {
    const parsed = JSON.parse(body) as { outbounds: { type: string; tag: string; outbounds?: string[] }[] }
    const outbounds = parsed.outbounds.map(({ type, tag, outbounds }) => ({ type, tag, outbounds }))
    return JSON.stringify({ ...parsed, outbounds }, null, 2)
  }
  if (platform === 'surge' || platform === 'loon') {
    return body.split('\n').map(line => line.includes(' = ') && !line.startsWith('Proxy = select,')
      ? `${line.split(' = ', 1)[0]} = <已隐藏连接参数>` : line).join('\n')
  }
  if (platform === 'quantumultx') return body.trim().split('\n').filter(Boolean)
    .map(line => `${line.split('://', 1)[0]}://<已隐藏连接参数>`).join('\n')
  return null
}

function publishedSingBox(db: D1Database, profileId: string, versionId: string) {
  return db.prepare(
    "SELECT compiled_json, target_version FROM conversion_profile_versions WHERE profile_id=? AND id=? AND platform='singbox'",
  ).bind(profileId, versionId).first<{ compiled_json: string; target_version: string }>()
}

function singboxValidation<T>(run: () => T): T {
  try { return run() } catch (error) {
    if (error instanceof TemplateValidationError) {
      throw apiError(422, 'TEMPLATE_INVALID', 'sing-box 配置校验失败', { diagnostics: error.diagnostics })
    }
    throw error
  }
}

templateRoutes.post('/preview', async c => {
  c.header('Cache-Control', 'no-store')
  const input = await readJson(c, previewSchema)
  const row = input.profileId ? await getTemplate(c.env.DB, input.profileId) : null
  const version = input.versionId && row ? await c.env.DB.prepare(
    `SELECT l.* FROM conversion_profile_outputs v
       JOIN subscription_template_versions l ON l.id=v.id
       WHERE v.profile_id=? AND v.id=? AND v.platform='mihomo'`,
  ).bind(row.id, input.versionId).first<TemplateVersionRow>() : null
  if (input.versionId && !version) throw apiError(404, 'VERSION_NOT_FOUND', '版本不存在')
  const yaml = version?.yaml ?? input.yaml
  const validation = yaml === undefined || (input.platform !== 'mihomo' && input.platform !== 'singbox') ? undefined : validateForAdmin(yaml, version ? isLegacyTemplateVersion(version.validator_version) : false)
  const { template, ignored = [], diagnostics = [] } = validation ?? {}
  const subscription = input.subscriptionId ? await getTemplateSubscription(c.env, input.subscriptionId) : null
  const published = input.platform === 'singbox' && version ? await publishedSingBox(c.env.DB, version.template_id, version.id) : null
  const sourceDiagnostics = template && !published && !(version && isLegacyTemplateVersion(version.validator_version))
    ? await checkRuleSources(c.env.DB, template) : []
  const options = template && input.platform === 'singbox' ? {
    targetVersion: published?.target_version ?? TARGET_SINGBOX_VERSION,
    ruleSets: published ? JSON.parse(published.compiled_json).route.rule_set ?? []
      : sourceDiagnostics.length ? [] : await loadSingBoxRuleSets(c.env.DB, template),
  } : undefined
  const model = options && !sourceDiagnostics.length ? singboxValidation(() => compileSingBoxConfig(template, [], options)) : undefined
  const artifact = subscription && !sourceDiagnostics.length && (!options || model) ? await renderEntitledSubscription(c.env, subscription, input.platform, undefined, template, true, options) : null
  const rendered = input.sample && !sourceDiagnostics.length && (!options || model) ? prepareClientRender(input.platform, [previewNode]).render(template, options) : artifact
  const output = (input.platform === 'mihomo' || input.platform === 'singbox') && rendered?.outputNodes
    ? (input.platform === 'mihomo' ? parse(rendered.body) as Record<string, unknown> : template)
    : template
  const native = input.platform === 'singbox' ? (rendered ? JSON.parse(rendered.body) : model?.config) : undefined
  const groups = native ? (native.outbounds as { type: string; tag: string; outbounds?: string[] }[])
    .flatMap(({ type, tag, outbounds }) => outbounds ? [{ name: tag, type, proxies: outbounds }] : [])
    : output?.['proxy-groups'] ?? []
  const rules = native ? (native.route?.rules as unknown[] | undefined)?.map(rule => JSON.stringify(rule)) ?? []
    : output?.rules ?? []
  const body = rendered ? input.sample ? rendered.body : previewBody(rendered.body, input.platform) : null
  return c.json({
    ignored, diagnostics: [...diagnostics, ...sourceDiagnostics, ...(model?.policyDiagnostics ?? [])],
    groups,
    rules,
    ruleProviders: sourceDiagnostics.length ? {} : output?.['rule-providers'] ?? {},
    subscriptionName: subscription?.name ?? (input.sample ? '合成节点样本' : null),
    inputNodes: artifact?.previewInputNodes ?? rendered?.inputNodes ?? 0,
    authorizedNodes: artifact?.previewAuthorizedNodes ?? rendered?.inputNodes ?? 0,
    outputNodes: rendered?.outputNodes ?? null,
    skippedNodes: rendered?.skippedNodes ?? 0,
    nodeDiagnostics: rendered?.diagnostics ?? [],
    rendererVersion: artifact?.rendererVersion ?? RENDERER_VERSION,
    effectiveVersionId: (input.platform === 'mihomo' || input.platform === 'singbox') ? version?.id ?? artifact?.templateVersionId ?? (yaml === undefined ? row?.published_id : null) ?? null : null,
    draftRevision: yaml !== undefined && !version && row?.draft === yaml ? row.revision : null,
    zeroNodeReason: artifact?.zeroNodeReason ?? null,
    body,
    capability: input.platform === 'mihomo' || (input.platform === 'singbox' && (template || native?.route)) ? 'full' : 'nodes',
    summary: rendered ? { bytes: new TextEncoder().encode(rendered.body).length, groups: Array.isArray(groups) ? groups.length : 0, rules: Array.isArray(rules) ? rules.length : 0 } : null,
  })
})

const previewImportSchema = z.object({
  url: z.string().max(4096),
})

// Shared by the one-shot preview and the saved-template import. Both are
// administrator clicks; neither schedules another fetch.
async function loadRemoteCandidate(url: string, conditional: { etag?: string | null; lastModified?: string | null } = {}) {
  const headers: Record<string, string> = {}
  if (conditional.etag) headers['If-None-Match'] = conditional.etag
  if (conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified
  const remote = await fetchRemoteTextWithMetadata({ url, headers }, fetch, 10_000).catch(error => {
    throw apiError(422, error instanceof RemoteFetchError ? error.code : 'REMOTE_FETCH_FAILED', '导入失败，请手动重试')
  })
  if (remote.notModified) return { notModified: true as const, message: '远程来源未更新' }
  const validation = validateForAdmin(remote.text)
  return {
    notModified: false as const,
    candidate: {
      yaml: remote.text,
      normalized: validation.normalized,
      ignored: validation.ignored,
      diagnostics: validation.diagnostics,
      contentHash: await computeContentHash(validation.normalized),
    },
    source: {
      url, fetchedAt: new Date().toISOString(), etag: remote.etag, lastModified: remote.lastModified,
    },
  }
}

// One click while creating a template: fetch once, return a candidate, write nothing.
templateRoutes.post('/import', async c => {
  const input = await readJson(c, previewImportSchema)
  return c.json(await loadRemoteCandidate(input.url))
})

templateRoutes.post('/:id/import', async c => {
  const input = await readJson(c, importSchema)
  const row = await getTemplate(c.env.DB, c.req.param('id'))
  if (row.archived || row.revision !== input.expectedRevision) throw templateConflict()

  const sameSource = row.source_url === input.url
  return c.json(await loadRemoteCandidate(input.url, {
    etag: input.ifNoneMatch ?? (sameSource ? row.source_etag : null),
    lastModified: input.ifModifiedSince ?? (sameSource ? row.source_last_modified : null),
  }))
})

templateRoutes.post('/:id/publish', async c => {
  const row = await getTemplate(c.env.DB, c.req.param('id'))
  const input = await readJson(c, publishSchema)

  if (row.archived || row.revision !== input.expectedRevision) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '配置已被修改，请刷新后重试')
  }

  if ((row.draft_hash ?? await computeDraftHash(row.draft)) !== input.draftHash) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '草稿内容已变更，请刷新后重试')
  }

  // Re-validate draft before publishing
  const validation = validateForAdmin(row.draft)

  const ruleDiagnostics = await checkRuleSources(c.env.DB, validation.normalized)
  if (ruleDiagnostics.length) throw apiError(422, 'TEMPLATE_INVALID', '规则集校验失败', { diagnostics: ruleDiagnostics })

  // Check if there are unacknowledged ignored fields
  if (validation.ignored.length > 0 && !input.ignoredAcknowledged) {
    throw apiError(422, 'TEMPLATE_INVALID', '请确认被忽略的字段', { diagnostics: validation.diagnostics })
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const normalizedJson = JSON.stringify(validation.normalized)
  assertTemplateFitsD1(row.draft, normalizedJson)
  const contentHash = await computeContentHash(validation.normalized)
  const previousSingBox = Boolean(row.published_id && await publishedSingBox(c.env.DB, row.id, row.published_id))
  const enableSingBox = input.singbox ?? previousSingBox
  const snapshots: RuleVersionSnapshot[] = []
  const native = enableSingBox ? { ruleSets: await loadSingBoxRuleSets(c.env.DB, validation.template, snapshots) } : undefined
  const compiled = native ? singboxValidation(() => compileSingBoxConfig(validation.template, [previewNode], native)) : undefined
  const compiledDiagnostics = compiled ? JSON.stringify([...compiled.policyDiagnostics, ...compiled.diagnostics]) : undefined
  if (compiled && compiledDiagnostics) assertTemplateFitsD1(normalizedJson, compiled.json, compiledDiagnostics)

  // Atomic batch: create version + update template pointer
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO subscription_template_versions (id, template_id, yaml, created_at, sequence, normalized_json, content_hash, validator_version, created_by)
       SELECT ?, t.id, t.draft, ?, (SELECT COALESCE(MAX(sequence), 0) + 1
         FROM subscription_template_versions WHERE template_id=t.id), ?, ?, ?, ?
       FROM subscription_templates t WHERE t.id=? AND t.revision=? AND t.archived=0`
    ).bind(id, now, normalizedJson, contentHash, VALIDATOR_VERSION, c.get('principal')?.id ?? null, row.id, input.expectedRevision),
    c.env.DB.prepare(
      `UPDATE subscription_templates SET published_id=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=? AND archived=0 AND EXISTS (SELECT 1 FROM subscription_template_versions WHERE id=?)`
    ).bind(id, now, row.id, input.expectedRevision, id),
    ...(compiled && compiledDiagnostics ? [c.env.DB.prepare(`
      INSERT INTO conversion_profile_versions
        (profile_id,id,platform,target_version,source_json,compiled_json,diagnostics_json,created_at)
      SELECT template_id,id,'singbox',?,?,?,?,? FROM subscription_template_versions WHERE id=?
    `).bind(TARGET_SINGBOX_VERSION, normalizedJson, compiled.json, compiledDiagnostics, now, id)] : []),
    ...(snapshots.length ? [c.env.DB.prepare(`
      INSERT INTO conversion_rule_version_snapshots (version_id,versions_json)
      SELECT id,? FROM subscription_template_versions WHERE id=?
    `).bind(JSON.stringify(snapshots), id)] : []),
  ])

  // Check if template update succeeded (condition matched)
  if (!results[1].meta.changes) {
    throw apiError(409, 'TEMPLATE_CONFLICT', '并发修改导致发布失败，请重试')
  }

  // Get reference summary for response
  const refs = await getReferencedSummary(c.env, row.id)
  const actor = c.get('principal')
  if (actor) await logAudit(c.env.DB, actor.id, 'template.publish', 'subscription_template', row.id, { versionId: id, references: refs,
    platforms: previousSingBox || compiled ? ['mihomo', 'singbox'] : ['mihomo'],
  }).catch(() => {})

  return c.json({
    versionId: id,
    sequence: (await c.env.DB.prepare('SELECT sequence FROM subscription_template_versions WHERE id=?').bind(id).first<{sequence: number}>())?.sequence ?? 1,
    contentHash,
    singboxPublished: Boolean(compiled),
    references: refs,
    revision: input.expectedRevision + 1,
  })
})

templateRoutes.get('/:id/versions', async c => {
  const id = c.req.param('id')
  await getTemplate(c.env.DB, id)
  const { page, pageSize, offset } = pagination(c.req.query('page'), c.req.query('pageSize'))
  const [total, versions] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM subscription_template_versions WHERE template_id=?').bind(id).first<{ count: number }>(),
    c.env.DB.prepare(`
      SELECT id,sequence,created_at,content_hash,validator_version,created_by
      FROM subscription_template_versions WHERE template_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?
    `).bind(id, pageSize, offset).all<TemplateVersionRow>(),
  ])
  return c.json({ versions: versions.results.map(versionSummary), total: total?.count ?? 0, page, pageSize })
})

templateRoutes.get('/:id/versions/:versionId', async c => {
  const version = await c.env.DB.prepare('SELECT * FROM subscription_template_versions WHERE template_id=? AND id=?')
    .bind(c.req.param('id'), c.req.param('versionId')).first<TemplateVersionRow>()
  if (!version) throw apiError(404, 'VERSION_NOT_FOUND', '版本不存在')
  const validation = validateForAdmin(version.yaml, isLegacyTemplateVersion(version.validator_version))
  return c.json({
    ...versionSummary(version), yaml: version.yaml, normalized: validation.normalized,
    contentHash: version.content_hash ?? await computeContentHash(validation.normalized),
  })
})

templateRoutes.post('/:id/rollback', async c => {
  const { versionId, expectedRevision } = await readJson(c, rollbackSchema)
  const id = c.req.param('id')
  const row = await getTemplate(c.env.DB, id)
  if (row.archived || row.revision !== expectedRevision) throw templateConflict()
  const version = await c.env.DB.prepare(
    'SELECT yaml, validator_version FROM subscription_template_versions WHERE id=? AND template_id=?'
  ).bind(versionId, id).first<{ yaml: string; validator_version: string | null }>()
  if (!version) throw apiError(404, 'VERSION_NOT_FOUND', '版本不存在')
  const { normalized } = validateForAdmin(version.yaml, isLegacyTemplateVersion(version.validator_version))
  const diagnostics = await checkRuleSources(c.env.DB, normalized)
  if (diagnostics.length) throw apiError(422, 'TEMPLATE_INVALID', '规则集校验失败', { diagnostics })
  const updated = await c.env.DB.prepare(`
    UPDATE subscription_templates SET published_id=?, updated_at=?, revision=revision+1
    WHERE id=? AND revision=? AND archived=0
  `).bind(versionId, new Date().toISOString(), id, expectedRevision).run()
  if (!updated.meta.changes) throw templateConflict()
  const references = await getReferencedSummary(c.env, id)
  const actor = c.get('principal')
  if (actor) await logAudit(c.env.DB, actor.id, 'template.rollback', 'subscription_template', id, { versionId, references }).catch(() => {})
  return c.json({ ok: true, revision: expectedRevision + 1, versionId, references })
})

templateRoutes.post('/:id/archive', async c => {
  const { expectedRevision } = await readJson(c, archiveSchema)
  const id = c.req.param('id')
  await getTemplate(c.env.DB, id)
  const updated = await c.env.DB.prepare(`
    UPDATE subscription_templates SET archived=1, updated_at=?, revision=revision+1
    WHERE id=? AND revision=? AND archived=0 AND NOT (${templateReferencesSql('subscription_templates')})
  `).bind(new Date().toISOString(), id, expectedRevision).run()
  if (!updated.meta.changes) {
    const row = await getTemplate(c.env.DB, id)
    if (row.archived || row.revision !== expectedRevision) throw templateConflict()
    const references = await getReferencedSummary(c.env, id)
    if (references.isDefault || references.directBindings) {
      throw apiError(409, 'TEMPLATE_REFERENCED', '配置正在被引用', { references })
    }
    throw templateConflict()
  }
  return c.json({ ok: true, revision: expectedRevision + 1 })
})

templateRoutes.put('/default', async c => {
  const { templateId, expectedRevision } = await readJson(c, defaultSchema)
  if (templateId !== null) await requirePublished(c.env.DB, templateId)
  const updated = await c.env.DB.prepare(`
    UPDATE subscription_template_default SET template_id=?, revision=revision+1, updated_at=?
    WHERE id=1 AND revision=? AND (? IS NULL OR EXISTS (
      SELECT 1 FROM subscription_templates WHERE id=? AND archived=0 AND published_id IS NOT NULL
    ))
  `).bind(templateId, new Date().toISOString(), expectedRevision, templateId, templateId).run()
  if (!updated.meta.changes) throw templateConflict()
  const ids = await subscriptionIds(c.env)
  const references = await checkTemplateReferences(c.env.DB, templateId ?? '', ids)
  const inheritedCount = templateId === null ? await countInheritedSubscriptions(c.env.DB, ids) : references.inheritedCount
  return c.json({ ok: true, revision: expectedRevision + 1, references, inheritedCount })
})

templateRoutes.get('/bindings/:id', async c => {
  const id = c.req.param('id')
  await getTemplateSubscription(c.env, id)
  const row = await getEffectiveTemplate(c.env.DB, id)
  const singbox = await getEffectiveTemplate(c.env.DB, id, 'singbox').catch(() => undefined)
  return c.json({
    subscriptionId: id, mode: row.mode, templateId: row.binding_template_id,
    revision: row.revision, updatedAt: row.updated_at,
    singboxTemplate: singbox?.version_id ? {
      templateId: singbox.template_id, templateName: singbox.template_name, versionId: singbox.version_id, sequence: singbox.sequence,
    } : null,
    effectiveTemplate: row.version_id ? {
      templateId: row.template_id, templateName: row.template_name, versionId: row.version_id, sequence: row.sequence,
    } : null,
  })
})

templateRoutes.put('/bindings/:id', async c => {
  const id = c.req.param('id')
  await getTemplateSubscription(c.env, id)
  const input = await readJson(c, bindingSchema)
  if (input.mode === 'specific') await requirePublished(c.env.DB, input.templateId)
  const inD1 = await isModuleReady(c.env.DB, DELIVERY_D1_READY_KEY)
  await bindingWrite(c.env.DB, id, input, new Date().toISOString(), inD1).run().catch(rethrowBindingError)
  return c.json({ ok: true, revision: input.expectedRevision + 1 })
})

// Register after the literal /default route.
templateRoutes.put('/:id', async c => {
  const input = await readJson(c, draftSchema.extend({ expectedRevision: z.number().int().positive() }))
  const id = c.req.param('id')
  const row = await getTemplate(c.env.DB, id)
  assertTemplateFitsD1(input.yaml)
  const draftHash = await computeDraftHash(input.yaml)
  const source = input.source === undefined ? {
    url: row.source_url, fetchedAt: row.source_fetched_at, etag: row.source_etag, lastModified: row.source_last_modified,
  } : input.source
  const updated = await c.env.DB.prepare(`
    UPDATE subscription_templates SET name=?, draft=?, draft_hash=?, updated_at=?, revision=revision+1,
      source_url=?, source_fetched_at=?, source_etag=?, source_last_modified=?
    WHERE id=? AND revision=? AND archived=0
  `).bind(input.name, input.yaml, draftHash, new Date().toISOString(),
    source?.url ?? null, source?.fetchedAt ?? null, source?.etag ?? null, source?.lastModified ?? null,
    id, input.expectedRevision).run()
  if (!updated.meta.changes) throw templateConflict()
  return c.json({ ok: true, revision: input.expectedRevision + 1, draftHash })
})
