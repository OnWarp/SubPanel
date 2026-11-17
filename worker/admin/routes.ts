import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import { apiError } from '../platform/api-error.js'
import { readJson } from '../platform/http.js'
import { putSetting } from '../db/settings-repository.js'
import { templateDefaults } from './templates.js'
import { adminStats,broadcast,expiryReminders,reminderDays } from './service.js'
const keySchema=z.enum(['verification','expiry_reminder','broadcast'])
const contentSchema=z.object({subject:z.string().trim().min(1).max(500).refine(s=>!/[\r\n]/.test(s)),body:z.string().trim().min(1).max(50000)})
export const adminManagementRoutes=new Hono<AppEnv>()
adminManagementRoutes.get('/stats',async c=>c.json(await adminStats(c.env.DB)))
adminManagementRoutes.get('/audit-logs',async c=>{
 const q=c.req.query(), page=Math.max(1,Number.parseInt(q.page??'',10)||1),pageSize=Math.min(100,Math.max(1,Number.parseInt(q.pageSize??'',10)||20))
 const where:string[]=[],values:string[]=[]
 for(const [key,column] of [['action','action'],['actor','actor_user_id'],['from','created_at'],['to','created_at']]) if(q[key]) {where.push(`${column} ${key==='from'?'>=':key==='to'?'<=':'='} ?`);values.push(q[key])}
 const clause=where.length?' WHERE '+where.join(' AND '):''
 const total=(await c.env.DB.prepare('SELECT COUNT(*) total FROM audit_logs'+clause).bind(...values).first<{total:number}>())!.total
 const logs=(await c.env.DB.prepare('SELECT * FROM audit_logs'+clause+' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(...values,pageSize,(page-1)*pageSize).all()).results
 return c.json({logs,total,page,pageSize,pagination:{page,pageSize,total,pageCount:Math.max(1,Math.ceil(total/pageSize))}})
})
adminManagementRoutes.get('/mail-templates',async c=>{
 const stored=(await c.env.DB.prepare('SELECT * FROM mail_templates').all<{key:string;subject:string;body:string}>()).results
 return c.json({templates:Object.entries(templateDefaults).map(([key,value])=>({key,...value,...stored.find(row=>row.key===key)}))})
})
adminManagementRoutes.put('/mail-templates/:key',async c=>{
 const key=keySchema.safeParse(c.req.param('key')); if(!key.success) throw apiError(404,'TEMPLATE_NOT_FOUND','模板不存在'); const templateKey=key.data,input=await readJson(c,contentSchema)
 await c.env.DB.prepare('INSERT INTO mail_templates(key,subject,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET subject=excluded.subject,body=excluded.body,updated_at=excluded.updated_at').bind(templateKey,input.subject,input.body,new Date().toISOString()).run()
 return c.json({key:templateKey,...input})
})
adminManagementRoutes.delete('/mail-templates/:key',async c=>{const key=keySchema.safeParse(c.req.param('key')); if(!key.success) throw apiError(404,'TEMPLATE_NOT_FOUND','模板不存在'); const templateKey=key.data;await c.env.DB.prepare('DELETE FROM mail_templates WHERE key=?').bind(templateKey).run();return c.body(null,204)})
adminManagementRoutes.get('/mail-broadcasts',async c=>c.json({broadcasts:(await c.env.DB.prepare('SELECT * FROM mail_broadcasts ORDER BY created_at DESC,id DESC LIMIT 100').all()).results}))
adminManagementRoutes.post('/mail-broadcasts',async c=>c.json(await broadcast(c.env.DB,c.get('principal').id,await readJson(c,contentSchema.extend({target:z.enum(['all','active','expiring'])}))),201))
adminManagementRoutes.get('/system/reminders',async c=>c.json({reminder_days:await reminderDays(c.env.DB)}))
adminManagementRoutes.put('/system/reminders',async c=>{const input=await readJson(c,z.object({reminder_days:z.number().int().min(1).max(365)}));await putSetting(c.env.DB,'reminder_days',input.reminder_days);return c.json(input)})
adminManagementRoutes.post('/jobs/expiry-reminders',async c=>c.json(await expiryReminders(c.env.DB)))
