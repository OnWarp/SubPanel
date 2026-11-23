import { apiError } from '../platform/api-error.js'
import { validateTemplate } from './validation.js'
import { sha256Base64Url } from '../platform/hash.js'
import { z } from 'zod'

export type TemplateRow = {
  id: string
  name: string
  draft: string
  published_id: string | null
  archived: number
  source_url: string | null
  updated_at: string
  revision: number
  draft_hash: string | null
  source_fetched_at: string | null
  source_etag: string | null
  source_last_modified: string | null
  created_at: string
}

export type TemplateVersionRow = {
  id: string
  template_id: string
  yaml: string
  created_at: string
  sequence: number
  normalized_json: string | null
  content_hash: string | null
  validator_version: string | null
  created_by: string | null
}

export type TemplateDefaultRow = {
  id: number
  template_id: string | null
  revision: number
  updated_at: string
}

export const bindingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('specific'), templateId: z.string().min(1), expectedRevision: z.number().int().positive() }),
  z.object({ mode: z.enum(['inherit', 'base']), templateId: z.null().optional(), expectedRevision: z.number().int().positive() }),
])

export type BindingInput = z.infer<typeof bindingSchema>

export const computeDraftHash = sha256Base64Url

export function templateConflict() {
  return apiError(409, 'TEMPLATE_CONFLICT', '配置已被修改，请刷新后重试')
}

export function bindingWrite(db: D1Database, id: string, input: BindingInput, now: string, requireD1Subscription: boolean) {
  const templateId = input.templateId ?? null
  // A failed precondition violates NOT NULL and rolls back the surrounding D1 batch.
  return db.prepare(`
    INSERT INTO subscription_template_bindings (subscription_id, mode, template_id, revision, updated_at)
    VALUES (?, ?, ?, CASE WHEN
      COALESCE((SELECT revision FROM subscription_template_bindings WHERE subscription_id=?), 1) = ?
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM subscription_templates WHERE id=? AND archived=0 AND published_id IS NOT NULL
      ))
      AND (? = 0 OR EXISTS (SELECT 1 FROM subscriptions WHERE id=?))
      THEN ? ELSE NULL END, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET
      mode=excluded.mode, template_id=excluded.template_id,
      revision=excluded.revision, updated_at=excluded.updated_at
  `).bind(id, input.mode, templateId, id, input.expectedRevision, templateId, templateId,
    Number(requireD1Subscription), id, input.expectedRevision + 1, now)
}

export function rethrowBindingError(error: unknown): never {
  if (error instanceof Error && error.message.includes('NOT NULL constraint failed: subscription_template_bindings.revision')) {
    throw templateConflict()
  }
  throw error
}

export async function getTemplate(db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM subscription_templates WHERE id=?').bind(id).first<TemplateRow>()
  if (!row) throw apiError(404, 'TEMPLATE_NOT_FOUND', '配置不存在')
  return row
}

export async function requirePublished(db: D1Database, id: string) {
  const row = await db.prepare(`
    SELECT t.archived, v.id AS version_id
    FROM subscription_templates t
    LEFT JOIN subscription_template_versions v ON v.template_id=t.id AND v.id=t.published_id
    WHERE t.id=?
  `).bind(id).first<{ archived: number; version_id: string | null }>()
  if (!row) throw apiError(404, 'TEMPLATE_NOT_FOUND', '配置不存在')
  if (row.archived) throw templateConflict()
  if (!row.version_id) throw apiError(422, 'TEMPLATE_UNPUBLISHED', '请先发布配置')
}

export async function getDefault(db: D1Database) {
  return await db.prepare(
    'SELECT id, template_id, revision, updated_at FROM subscription_template_default WHERE id=1'
  ).first<TemplateDefaultRow>() ?? { id: 1, template_id: null, revision: 1, updated_at: '1970-01-01T00:00:00.000Z' }
}

async function getMihomoTemplate(db: D1Database, subscriptionId: string) {
  const row = await db.prepare(`
    SELECT CASE COALESCE(b.mode, 'inherit')
             WHEN 'specific' THEN b.template_id WHEN 'inherit' THEN d.template_id END AS selected_id,
           t.id AS template_id, t.name AS template_name, t.archived,
           v.id AS version_id, v.sequence, v.yaml, v.validator_version,
           COALESCE(b.mode, 'inherit') AS mode, b.template_id AS binding_template_id,
           COALESCE(b.revision, 1) AS revision, b.updated_at
    FROM (SELECT ? AS id) AS subscription
    LEFT JOIN subscription_template_bindings b ON b.subscription_id = subscription.id
    LEFT JOIN subscription_template_default d ON d.id = 1
    LEFT JOIN subscription_templates t ON t.id = CASE COALESCE(b.mode, 'inherit')
      WHEN 'specific' THEN b.template_id WHEN 'inherit' THEN d.template_id END
    LEFT JOIN subscription_template_versions v ON v.id = t.published_id AND v.template_id = t.id
  `).bind(subscriptionId).first<{
    selected_id: string | null
    template_id: string | null
    template_name: string | null
    archived: number | null
    version_id: string | null
    sequence: number | null
    yaml: string | null
    validator_version: string | null
    mode: BindingInput['mode']
    binding_template_id: string | null
    revision: number
    updated_at: string | null
  }>()
  if (!row || (row.selected_id && (!row.version_id || row.archived))) {
    throw apiError(500, 'TEMPLATE_OUTPUT_INVALID', '已发布配置不可用')
  }
  return { ...row, target_version: null, compiled_json: null }
}

export async function getEffectiveTemplate(db: D1Database, subscriptionId: string, platform: 'mihomo' | 'singbox' = 'mihomo') {
  if (platform === 'mihomo') return getMihomoTemplate(db, subscriptionId)
  const row = await db.prepare(`
    WITH binding AS (
      SELECT COALESCE(cb.mode, b.mode, 'inherit') AS mode,
             CASE WHEN cb.mode IS NULL THEN b.template_id ELSE cb.profile_id END AS binding_template_id,
             COALESCE(cb.revision, b.revision, 1) AS revision,
             COALESCE(cb.updated_at, b.updated_at) AS updated_at
      FROM (SELECT ? AS id) AS subscription
      LEFT JOIN subscription_template_bindings b ON b.subscription_id=subscription.id
      LEFT JOIN conversion_bindings cb ON cb.subscription_id=subscription.id AND cb.platform='singbox'
    )
    SELECT binding.*, t.id AS template_id, t.name AS template_name, t.archived,
           sv.id AS version_id, CASE WHEN sv.id IS NOT NULL THEN v.sequence END AS sequence,
           CASE WHEN sv.id IS NOT NULL THEN v.yaml END AS yaml, v.validator_version,
           sv.target_version, sv.compiled_json,
           CASE binding.mode WHEN 'specific' THEN binding.binding_template_id WHEN 'inherit' THEN d.template_id END AS selected_id
    FROM binding
    LEFT JOIN subscription_template_default d ON d.id=1
    LEFT JOIN subscription_templates t ON t.id=CASE binding.mode
      WHEN 'specific' THEN binding.binding_template_id WHEN 'inherit' THEN d.template_id END
    LEFT JOIN subscription_template_versions v ON v.id=t.published_id AND v.template_id=t.id
    LEFT JOIN conversion_profile_versions sv ON sv.profile_id=t.id AND sv.id=v.id AND sv.platform='singbox'
  `).bind(subscriptionId).first<{
    target_version: string | null
    compiled_json: string | null
    selected_id: string | null
    template_id: string | null
    template_name: string | null
    archived: number | null
    version_id: string | null
    sequence: number | null
    yaml: string | null
    validator_version: string | null
    mode: BindingInput['mode']
    binding_template_id: string | null
    revision: number
    updated_at: string | null
  }>()
  if (!row || (row.selected_id && row.archived)) {
    throw apiError(500, 'TEMPLATE_OUTPUT_INVALID', '已发布配置不可用')
  }
  return row
}

export async function resolvedTemplate(db: D1Database, subscriptionId: string) {
  const row = await getMihomoTemplate(db, subscriptionId)
  return row.yaml === null ? undefined : validateTemplate(row.yaml, isLegacyTemplateVersion(row.validator_version)).template
}

export function templateReferencesSql(alias: string) {
  return `EXISTS(SELECT 1 FROM subscription_template_default WHERE template_id=${alias}.id)
    OR EXISTS(SELECT 1 FROM subscription_template_bindings WHERE mode='specific' AND template_id=${alias}.id)`
}

export async function countInheritedSubscriptions(db: D1Database, subscriptionIds: string[]) {
  const overrides = await db.prepare(`
    SELECT COUNT(*) AS count FROM subscription_template_bindings
    WHERE mode!='inherit' AND subscription_id IN (SELECT value FROM json_each(?))
  `).bind(JSON.stringify(subscriptionIds)).first<{ count: number }>()
  return subscriptionIds.length - (overrides?.count ?? 0)
}

export async function checkTemplateReferences(db: D1Database, templateId: string, subscriptionIds: string[]) {
  const row = await db.prepare(`
    SELECT EXISTS(SELECT 1 FROM subscription_template_default WHERE template_id=?) AS is_default,
           (SELECT COUNT(*) FROM subscription_template_bindings WHERE mode='specific' AND template_id=?) AS direct
  `).bind(templateId, templateId).first<{ is_default: number; direct: number }>()
  return {
    isDefault: Boolean(row?.is_default),
    directBindings: row?.direct ?? 0,
    inheritedCount: row?.is_default ? await countInheritedSubscriptions(db, subscriptionIds) : 0,
  }
}

export function isLegacyTemplateVersion(validatorVersion: string | null) {
  return validatorVersion === null || validatorVersion === '1' || validatorVersion === '2'
}
