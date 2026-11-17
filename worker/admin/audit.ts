import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app-env.js'
export async function logAudit(db: D1Database, actor: string, action: string, targetType: string, targetId: string | null, detail: Record<string,unknown> = {}) {
 await db.prepare('INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,targetType,targetId,JSON.stringify(detail),new Date().toISOString()).run()
}
// Only request metadata is recorded: never passwords, tokens, or mail secrets.
export const auditAdminMutation: MiddlewareHandler<AppEnv> = async (c,next) => {
 let changes: Record<string,unknown> = {}
 if (c.req.header('content-type')?.includes('application/json')) {
  try { const body = await c.req.raw.clone().json() as Record<string,unknown>; changes = Object.fromEntries(['action','role','enabled','planId'].filter(key => key in body).map(key => [key,body[key]])) } catch { /* Route validates malformed input. */ }
 }
 await next()
 if (!['POST','PUT','PATCH','DELETE'].includes(c.req.method) || c.res.status >= 400) return
 const path = c.req.path.replace(/^\/api\/admin\//,'')
 if (!/^(users|invitations|invites|invite-codes|email-domains|share-settings|system|plans|entitlements|tickets|notices|mail-templates|mail-broadcasts|jobs)(\/|$)/.test(path)) return
 const parts = path.split('/')
 let targetId = parts[1] ?? null
 if (!targetId && c.res.headers.get('content-type')?.includes('application/json')) {
  const response = await c.res.clone().json() as Record<string,unknown>
  const entity = response.user ?? response.plan ?? response.invite ?? response.invitation ?? response.ticket ?? response.notice ?? response
  if (entity && typeof entity === 'object' && 'id' in entity) targetId = String(entity.id)
 }
 try { await logAudit(c.env.DB,c.get('principal').id,`${c.req.method.toLowerCase()}.${parts[0]}${parts.length > 2 ? '.' + parts.slice(2).join('.') : ''}${typeof changes.action === 'string' ? '.' + changes.action : ''}`,parts[0],targetId,{ method:c.req.method,path,status:c.res.status,...changes }) } catch { /* Audit logging is best-effort: a missing or unmigrated audit table must never break the primary admin operation. */ }
}
