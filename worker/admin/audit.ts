import type { MiddlewareHandler } from 'hono'
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
 let changes: Record<string,unknown> = {}
 if (c.req.header('content-type')?.includes('application/json')) {
  try { const body = await c.req.raw.clone().json() as Record<string,unknown>; changes = Object.fromEntries(['action','role','enabled','planId','userId'].filter(key => key in body).map(key => [key,body[key]])) } catch { /* Route validates malformed input. */ }
 }
 await next()
 if (!['POST','PUT','PATCH','DELETE'].includes(c.req.method) || c.res.status >= 400) return
 const path = c.req.path.replace(/^\/api\/admin\//,'')
 if (!/^(subscriptions|subscription-templates|delivery|shares|users|invitations|invites|invite-codes|email-domains|share-settings|system|plans|entitlements|tickets|notices|mail-templates|mail-broadcasts|jobs)(\/|$)/.test(path)) return
 const parts = path.split('/')
 if (parts[0] === 'entitlements' && parts[1] === 'trial' || parts[0] === 'subscriptions' && parts[1] === 'trial') {
  try { await logAudit(c.env.DB,c.get('principal').id,'put.subscriptions.trial','subscriptions',null,{ method:c.req.method,path,status:c.res.status,...changes }) } catch { /* Best effort. */ }
  return
 }
 if (parts[0] === 'users' && ['entitlement', 'subscription-plan'].includes(parts[2])) {
  const response = await c.res.clone().json() as { latest?: { id: string }; subscriptionId?: string }
  try { await logAudit(c.env.DB,c.get('principal').id,`post.subscriptions.${String(changes.action)}`,'subscriptions',response.subscriptionId ?? response.latest?.id ?? null,{ method:c.req.method,path,userId:parts[1],status:c.res.status,...changes }) } catch { /* Best effort. */ }
  return
 }
 let targetId = parts[1] ?? null
 if (!targetId && c.res.headers.get('content-type')?.includes('application/json')) {
  const response = await c.res.clone().json() as Record<string,unknown>
  const entity = response.user ?? response.subscription ?? response.plan ?? response.template ?? response.invite ?? response.invitation ?? response.ticket ?? response.notice ?? response
  if (entity && typeof entity === 'object' && 'id' in entity) targetId = String(entity.id)
 }
 try { await logAudit(c.env.DB,c.get('principal').id,`${c.req.method.toLowerCase()}.${parts[0]}${parts.length > 2 ? '.' + parts.slice(2).join('.') : ''}${typeof changes.action === 'string' ? '.' + changes.action : ''}`,parts[0],targetId,{ method:c.req.method,path,status:c.res.status,...changes }) } catch { /* Audit logging is best-effort: a missing or unmigrated audit table must never break the primary admin operation. */ }
}
