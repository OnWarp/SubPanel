import { apiError } from '../platform/api-error.js'
import { validateTemplate } from './validation.js'
import type { D1Database } from '@cloudflare/workers-types'

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

export type TemplateBindingRow = {
  subscription_id: string
  mode: 'inherit' | 'specific' | 'base'
  template_id: string | null
  revision: number
  updated_at: string
}

export type EffectiveTemplate = {
  binding: TemplateBindingRow
  defaultRow: TemplateDefaultRow | null
  template: TemplateRow
  version: TemplateVersionRow
}

function computeDraftHash(draft: string): string {
  const encoder = new TextEncoder()
  const data = encoder.encode(draft)
  const hash = Array.from(new Uint8Array(data)).map(b => b.toString(16).padStart(2, '0')).join('')
  return hash
}

export async function getTemplate(db: D1Database, id: string, includeArchived = false) {
  const row = await db.prepare(
    `SELECT * FROM subscription_templates WHERE id=? ${includeArchived ? '' : 'AND archived=0'}`
  ).bind(id).first<TemplateRow>()
  if (!row) throw apiError(404, 'TEMPLATE_NOT_FOUND', '配置不存在')
  return row
}

export async function requirePublished(db: D1Database, id: string) {
  const row = await getTemplate(db, id)
  if (!row.published_id) throw apiError(422, 'TEMPLATE_UNPUBLISHED', '请先发布配置')
  return row
}

export async function binding(db: D1Database, id: string) {
  return await db.prepare(
    'SELECT subscription_id, mode, template_id, revision, updated_at FROM subscription_template_bindings WHERE subscription_id=?'
  ).bind(id).first<TemplateBindingRow>() ?? {
    subscription_id: id,
    mode: 'inherit' as const,
    template_id: null,
    revision: 1,
    updated_at: new Date().toISOString(),
  }
}

export async function getDefault(db: D1Database) {
  return await db.prepare(
    'SELECT id, template_id, revision, updated_at FROM subscription_template_default WHERE id=1'
  ).first<TemplateDefaultRow>() ?? { id: 1, template_id: null, revision: 1, updated_at: new Date().toISOString() }
}

export async function resolvedTemplate(db: D1Database, subscriptionId: string) {
  const b = await binding(db, subscriptionId)
  if (b.mode === 'base') return undefined
  const id = b.mode === 'specific' ? b.template_id : (await getDefault(db)).template_id
  if (!id) return undefined
  const row = await requirePublished(db, id)
  const version = await db.prepare(
    'SELECT * FROM subscription_template_versions WHERE id=? AND template_id=?'
  ).bind(row.published_id, id).first<TemplateVersionRow>()
  if (!version) throw new Error('已发布配置版本不存在')
  return validateTemplate(version.yaml).template
}

/**
 * Determines the effective template for a subscription in a single JOIN query.
 * Returns all data needed to render the subscription in one snapshot.
 */
export async function getEffectiveTemplate(db: D1Database, subscriptionId: string): Promise<EffectiveTemplate | undefined> {
  const row = await db.prepare(`
    SELECT
      b.subscription_id, b.mode, b.template_id as binding_template_id, b.revision as binding_revision, b.updated_at as binding_updated_at,
      d.id as default_id, d.template_id as default_template_id, d.revision as default_revision, d.updated_at as default_updated_at,
      t.id as t_id, t.name, t.draft, t.published_id, t.archived, t.source_url, t.updated_at as template_updated_at,
        t.revision as template_revision, t.draft_hash, t.source_fetched_at, t.source_etag, t.source_last_modified, t.created_at,
      v.id as v_id, v.template_id as v_template_id, v.yaml, v.created_at as version_created_at,
        v.sequence, v.normalized_json, v.content_hash, v.validator_version, v.created_by
    FROM subscription_template_bindings b
    LEFT JOIN subscription_template_default d ON d.id = 1
    LEFT JOIN subscription_templates t ON t.id = CASE
      WHEN b.mode = 'specific' THEN b.template_id
      WHEN b.mode = 'inherit' THEN d.template_id
      ELSE NULL END
    LEFT JOIN subscription_template_versions v ON v.id = t.published_id AND v.template_id = t.id
    WHERE b.subscription_id = ? AND t.archived = 0 AND t.published_id IS NOT NULL
  `).bind(subscriptionId).first<{
    subscription_id: string
    mode: 'inherit' | 'specific' | 'base'
    binding_template_id: string | null
    binding_revision: number
    binding_updated_at: string
    default_id: number
    default_template_id: string | null
    default_revision: number
    default_updated_at: string
    t_id: string
    name: string
    draft: string
    published_id: string
    archived: number
    source_url: string | null
    template_updated_at: string
    template_revision: number
    draft_hash: string | null
    source_fetched_at: string | null
    source_etag: string | null
    source_last_modified: string | null
    created_at: string
    v_id: string
    v_template_id: string
    yaml: string
    version_created_at: string
    sequence: number
    normalized_json: string | null
    content_hash: string | null
    validator_version: string | null
    created_by: string | null
  }>()

  if (!row || !row.t_id) return undefined

  return {
    binding: {
      subscription_id: row.subscription_id,
      mode: row.mode,
      template_id: row.binding_template_id,
      revision: row.binding_revision,
      updated_at: row.binding_updated_at,
    },
    defaultRow: row.default_id ? {
      id: row.default_id,
      template_id: row.default_template_id,
      revision: row.default_revision,
      updated_at: row.default_updated_at,
    } : null,
    template: {
      id: row.t_id,
      name: row.name,
      draft: row.draft,
      published_id: row.published_id,
      archived: row.archived,
      source_url: row.source_url,
      updated_at: row.template_updated_at,
      revision: row.template_revision,
      draft_hash: row.draft_hash,
      source_fetched_at: row.source_fetched_at,
      source_etag: row.source_etag,
      source_last_modified: row.source_last_modified,
      created_at: row.created_at,
    },
    version: {
      id: row.v_id,
      template_id: row.v_template_id,
      yaml: row.yaml,
      created_at: row.version_created_at,
      sequence: row.sequence,
      normalized_json: row.normalized_json,
      content_hash: row.content_hash,
      validator_version: row.validator_version,
      created_by: row.created_by,
    },
  }
}

/**
 * Checks if a template is referenced (as default or by bindings).
 * Returns a summary of references for error messages.
 */
export async function checkTemplateReferences(db: D1Database, templateId: string): Promise<{
  isDefault: boolean
  directBindings: number
  inheritedCount: number
}> {
  const [defaultRow, directBindings, inherited] = await Promise.all([
    db.prepare('SELECT 1 FROM subscription_template_default WHERE template_id = ?').bind(templateId).first(),
    db.prepare('SELECT COUNT(*) as count FROM subscription_template_bindings WHERE mode = ? AND template_id = ?').bind('specific', templateId).first<{count: number}>(),
    db.prepare('SELECT COUNT(*) as count FROM subscription_template_bindings WHERE mode = ? AND (SELECT template_id FROM subscription_template_default WHERE id = 1) = ?').bind('inherit', templateId).first<{count: number}>(),
  ])

  return {
    isDefault: !!defaultRow,
    directBindings: directBindings?.count ?? 0,
    inheritedCount: inherited?.count ?? 0,
  }
}

export { computeDraftHash }