import type { MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import type { AppEnv } from '../app-env.js'
export function auditStatement(db: D1Database, actor: string, action: string, targetType: string, targetId: string | null, detail: Record<string,unknown> = {}, now = new Date().toISOString()) {
 return db.prepare('INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,targetType,targetId,JSON.stringify(detail),now)
}
export async function logAudit(db: D1Database, actor: string, action: string, targetType: string, targetId: string | null, detail: Record<string,unknown> = {}) {
 await auditStatement(db, actor, action, targetType, targetId, detail).run()
}
// Only request metadata is recorded: never passwords, tokens, or mail secrets.
export const auditAdminMutation: MiddlewareHandler<AppEnv> = async (c,next) => {
 if (/^\/api\/admin\/redemption-(batches|codes|records)(\/|$)/.test(c.req.path)) return next()
 await next()
 if (!['POST','PUT','PATCH','DELETE'].includes(c.req.method) || c.res.status >= 400) return
 const body = c.get('validatedBody')
 const changes: Record<string, unknown> = {}
 if (body && typeof body === 'object') {
  const fields = body as Record<string, unknown>
  if (typeof fields.enabled === 'boolean') changes.enabled = fields.enabled
  if (typeof fields.role === 'string' && ['admin', 'user'].includes(fields.role)) changes.role = fields.role
  if (typeof fields.action === 'string' && ['grant', 'extend', 'revoke', 'replace', 'assign', 'clear', 'set', 'remove'].includes(fields.action)) changes.action = fields.action
 }
 const path = routePath(c).replace(/^\/api\/admin\//,'')
 if (!/^(subscriptions|subscription-templates|delivery|shares|users|invitations|invites|invite-codes|email-domains|share-settings|system|plans|entitlements|tickets|notices|mail-templates|mail-broadcasts|jobs)(\/|$)/.test(path)) return
 const parts = path.split('/')
 if (parts[0] === 'entitlements' && parts[1] === 'trial' || parts[0] === 'subscriptions' && parts[1] === 'trial') {
  try { await logAudit(c.env.DB,c.get('principal').id,'put.subscriptions.trial','subscriptions',null,{ method:c.req.method,status:c.res.status,...changes }) } catch { /* Best effort. */ }
  return
 }
 if (parts[0] === 'users' && ['entitlement', 'subscription-plan'].includes(parts[2])) {
  const response = await c.res.clone().json() as { latest?: { id: string }; subscriptionId?: string }
  try { await logAudit(c.env.DB,c.get('principal').id,`post.subscriptions.${String(changes.action)}`,'subscriptions',response.subscriptionId ?? response.latest?.id ?? null,{ method:c.req.method,status:c.res.status,...changes }) } catch { /* Best effort. */ }
  return
 }
 const candidate = parts[1]?.startsWith(':') ? c.req.param(parts[1].slice(1)) : null
 let targetId = candidate && /^(?:[a-z]+_\d+|[a-f\d-]{36})$/u.test(candidate) ? candidate : null
 if (!targetId && c.res.headers.get('content-type')?.includes('application/json')) {
  const response = await c.res.clone().json() as Record<string,unknown>
  const entity = response.user ?? response.subscription ?? response.plan ?? response.template ?? response.invite ?? response.invitation ?? response.ticket ?? response.notice ?? response
  if (entity && typeof entity === 'object' && 'id' in entity) targetId = String(entity.id)
 }
 try { await logAudit(c.env.DB,c.get('principal').id,`${c.req.method.toLowerCase()}.${parts[0]}${parts.length > 2 ? '.' + parts.slice(2).filter(part => /^[a-z-]+$/u.test(part)).join('.') : ''}${typeof changes.action === 'string' ? '.' + changes.action : ''}`,parts[0],targetId,{ method:c.req.method,status:c.res.status,...changes }) } catch { /* Audit logging is best-effort: a missing or unmigrated audit table must never break the primary admin operation. */ }
}
