import { apiError } from '../platform/api-error.js'
import { validateTemplate } from './validation.js'
export type TemplateRow = { id: string; name: string; draft: string; published_id: string | null; archived: number; source_url: string | null; updated_at: string }
export async function getTemplate(db: D1Database, id: string) {
 const row = await db.prepare('SELECT * FROM subscription_templates WHERE id=? AND archived=0').bind(id).first<TemplateRow>()
 if (!row) throw apiError(404,'TEMPLATE_NOT_FOUND','配置不存在')
 return row
}
export async function requirePublished(db: D1Database,id: string) {
 const row = await getTemplate(db,id)
 if (!row.published_id) throw apiError(422,'TEMPLATE_UNPUBLISHED','请先发布配置')
 return row
}
export async function binding(db: D1Database, id: string) {
 return await db.prepare('SELECT mode,template_id FROM subscription_template_bindings WHERE subscription_id=?').bind(id).first<{mode: 'inherit'|'specific'|'base'; template_id: string|null}>() ?? { mode: 'inherit' as const, template_id: null }
}
export async function resolvedTemplate(db: D1Database, subscriptionId: string) {
 const b = await binding(db,subscriptionId)
 if (b.mode === 'base') return undefined
 const id = b.mode === 'specific' ? b.template_id : (await db.prepare('SELECT template_id FROM subscription_template_default WHERE id=1').first<{template_id:string|null}>())?.template_id
 if (!id) return undefined
 const row = await requirePublished(db,id)
 const version = await db.prepare('SELECT yaml FROM subscription_template_versions WHERE id=? AND template_id=?').bind(row.published_id,id).first<{yaml:string}>()
 if (!version) throw new Error('已发布配置版本不存在')
 return validateTemplate(version.yaml).template
}
