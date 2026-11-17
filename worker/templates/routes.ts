import { fetchRemoteText, RemoteFetchError } from '../catalog/remote.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { parse, stringify } from 'yaml'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { getSubscription } from '../delivery/service.js'
import { renderEntitledSubscription } from '../delivery/compiler.js'
import { getUserEntitlement } from '../entitlements/service.js'
import { binding, getTemplate, requirePublished } from './repository.js'
import { validateTemplate } from './validation.js'

export const templateRoutes = new Hono<AppEnv>()
const draftSchema = z.object({ name: z.string().trim().min(1).max(128), yaml: z.string().max(5*1024*1024) })
function checked(yaml: string) {
 try { return validateTemplate(yaml) } catch (e) { throw apiError(422,'TEMPLATE_INVALID', e instanceof Error ? e.message : '配置无效') }
}
templateRoutes.get('/', async c => {
 const templates = await c.env.DB.prepare('SELECT t.*, v.created_at AS published_at FROM subscription_templates t LEFT JOIN subscription_template_versions v ON v.id=t.published_id WHERE archived=0 ORDER BY t.updated_at DESC').all()
 const current = await c.env.DB.prepare('SELECT template_id FROM subscription_template_default WHERE id=1').first()
 return c.json({ templates: templates.results, defaultId: current?.template_id ?? null })
})
templateRoutes.post('/', async c => {
 const input = await readJson(c,draftSchema), id = crypto.randomUUID()
 await c.env.DB.prepare('INSERT INTO subscription_templates(id,name,draft,updated_at) VALUES(?,?,?,?)').bind(id,input.name,input.yaml,new Date().toISOString()).run()
 return c.json({ id },201)
})
templateRoutes.put('/default', async c => {
 const { templateId } = await readJson(c,z.object({templateId:z.string().nullable()}))
 if (templateId) await requirePublished(c.env.DB,templateId)
 const updated = await c.env.DB.prepare('UPDATE subscription_template_default SET template_id=? WHERE id=1 AND (? IS NULL OR EXISTS(SELECT 1 FROM subscription_templates WHERE id=? AND archived=0 AND published_id IS NOT NULL))').bind(templateId,templateId,templateId).run()
 if (!updated.meta.changes) throw apiError(409,'TEMPLATE_UNAVAILABLE','配置不可用，请刷新重试')
 return c.json({ok:true})
})
templateRoutes.get('/bindings/:id', async c => {
 await getSubscription(c.env,c.req.param('id'))
 return c.json(await binding(c.env.DB,c.req.param('id')))
})
templateRoutes.put('/bindings/:id', async c => {
 await getSubscription(c.env,c.req.param('id'))
 const b = await readJson(c,z.discriminatedUnion('mode',[
  z.object({mode:z.literal('specific'),templateId:z.string().min(1)}),
  z.object({mode:z.enum(['inherit','base']),templateId:z.null().optional()}),
 ]))
 if (b.mode === 'specific') await requirePublished(c.env.DB,b.templateId)
 const templateId = b.templateId ?? null
 const updated = await c.env.DB.prepare('INSERT INTO subscription_template_bindings(subscription_id,mode,template_id) SELECT ?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM subscription_templates WHERE id=? AND archived=0 AND published_id IS NOT NULL) ON CONFLICT(subscription_id) DO UPDATE SET mode=excluded.mode,template_id=excluded.template_id').bind(c.req.param('id'),b.mode,templateId,templateId,templateId).run()
 if (!updated.meta.changes) throw apiError(409,'TEMPLATE_UNAVAILABLE','配置不可用，请刷新重试')
 return c.json({ok:true})
})
templateRoutes.put('/:id', async c => {
 const input = await readJson(c,draftSchema)
 await getTemplate(c.env.DB,c.req.param('id'))
 await c.env.DB.prepare('UPDATE subscription_templates SET name=?,draft=?,updated_at=? WHERE id=?').bind(input.name,input.yaml,new Date().toISOString(),c.req.param('id')).run()
 return c.json({ok:true})
})
templateRoutes.post('/:id/publish', async c => {
 const row = await getTemplate(c.env.DB,c.req.param('id'))
 checked(row.draft)
 const id = crypto.randomUUID(), now = new Date().toISOString()
 await c.env.DB.batch([
  c.env.DB.prepare('INSERT INTO subscription_template_versions(id,template_id,yaml,created_at) VALUES(?,?,?,?)').bind(id,row.id,row.draft,now),
  c.env.DB.prepare('UPDATE subscription_templates SET published_id=?,updated_at=? WHERE id=?').bind(id,now,row.id),
 ])
 return c.json({ok:true})
})
templateRoutes.get('/:id/versions', async c => {
 await getTemplate(c.env.DB,c.req.param('id'))
 const versions = await c.env.DB.prepare('SELECT id,created_at FROM subscription_template_versions WHERE template_id=? ORDER BY created_at DESC').bind(c.req.param('id')).all()
 return c.json({versions:versions.results})
})
templateRoutes.post('/:id/rollback', async c => {
 const {versionId} = await readJson(c,z.object({versionId:z.string()}))
 await getTemplate(c.env.DB,c.req.param('id'))
 const version = await c.env.DB.prepare('SELECT id FROM subscription_template_versions WHERE id=? AND template_id=?').bind(versionId,c.req.param('id')).first()
 if (!version) throw apiError(404,'VERSION_NOT_FOUND','版本不存在')
 await c.env.DB.prepare('UPDATE subscription_templates SET published_id=?,updated_at=? WHERE id=?').bind(versionId,new Date().toISOString(),c.req.param('id')).run()
 return c.json({ok:true})
})
templateRoutes.post('/:id/archive', async c => {
 const id = c.req.param('id')
 await getTemplate(c.env.DB,id)
 const result = await c.env.DB.prepare(`UPDATE subscription_templates SET archived=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM subscription_template_default WHERE template_id=?) AND NOT EXISTS(SELECT 1 FROM subscription_template_bindings WHERE template_id=?)`).bind(id,id,id).run()
 if (!result.meta.changes) throw apiError(409,'TEMPLATE_REFERENCED','请先解除默认配置和订阅引用')
 return c.json({ok:true})
})
templateRoutes.post('/preview', async c => {
 const input = await readJson(c,z.object({yaml:z.string().max(5*1024*1024),subscriptionId:z.string().optional()}))
 const {template,ignored} = checked(input.yaml)
 if (!input.subscriptionId) return c.json({ignored,groups:template['proxy-groups'],rules:template.rules,subscriptionName:null,outputNodes:null})
 const subscription = await getSubscription(c.env,input.subscriptionId)
 const artifact = await renderEntitledSubscription(c.env,subscription,'mihomo',undefined,template)
 const rights = await getUserEntitlement(c.env.DB,subscription.userId)
 const reason = artifact.outputNodes ? null : !rights.current ? '无有效权益' : !subscription.groupIds.some(id => rights.current!.plan.groupIds.includes(id)) ? '分组无交集' : artifact.inputNodes === 0 ? '组内无启用节点' : '格式不兼容'
 const output = parse(artifact.body) as Record<string,unknown>
 // Only policy structure is returned. Never serialize node addresses or credentials.
 return c.json({subscriptionName:subscription.name,outputNodes:artifact.outputNodes,reason,ignored,groups:output['proxy-groups'],rules:output.rules, yaml:stringify({'proxy-groups':output['proxy-groups'],rules:output.rules})})
})

// Explicit admin action only: no cron integration and no retries.
templateRoutes.post('/:id/import', async c => {
 const row = await getTemplate(c.env.DB,c.req.param('id'))
 const {url} = await readJson(c,z.object({url:z.string().max(4096)}))
 let yaml: string
 try { yaml = await fetchRemoteText({url,headers:{}}) }
 catch(e) { throw apiError(422,e instanceof RemoteFetchError ? e.code : 'REMOTE_FETCH_FAILED','导入失败，请手动重试') }
 const result = checked(yaml)
 await c.env.DB.prepare('UPDATE subscription_templates SET draft=?,source_url=?,updated_at=? WHERE id=?').bind(yaml,url,new Date().toISOString(),row.id).run()
 return c.json({ignored:result.ignored})
})
