import { sendMail, type MailMessage, type MailSendResult } from '../accounts/email.js'
import { getSetting } from '../db/settings-repository.js'
import { templateContent } from './templates.js'
export const activeEntitlementSql = "e.status='active' AND e.starts_at<=? AND e.expires_at>? AND p.enabled=1 AND u.enabled=1 AND u.deleted_at IS NULL"
type Recipient = { id:string; email:string|null; username:string; entitlement_id:string; expires_at:string; last_reminded_at:number|null; plan:string }
export async function recipients(db:D1Database,target:'all'|'active'|'expiring',now=new Date().toISOString(),days=7):Promise<Recipient[]> {
 if(target==='all') return (await db.prepare('SELECT id,email,username FROM users WHERE deleted_at IS NULL ORDER BY id').all<Recipient>()).results
 const end=new Date(Date.parse(now)+days*86400000).toISOString()
 return (await db.prepare(`SELECT u.id,u.email,u.username,e.id entitlement_id,e.expires_at,e.last_reminded_at,p.name plan FROM user_entitlements e JOIN users u ON u.id=e.user_id JOIN plans p ON p.id=e.plan_id WHERE ${activeEntitlementSql}${target==='expiring'?' AND e.expires_at<=?':''} ORDER BY e.id`).bind(now,now,...(target==='expiring'?[end]:[])).all<Recipient>()).results
}
export async function adminStats(db:D1Database,now=new Date().toISOString()) {
 const end=new Date(Date.parse(now)+7*86400000).toISOString()
 const row=await db.prepare(`SELECT (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) users,
 (SELECT COUNT(*) FROM user_entitlements e JOIN plans p ON p.id=e.plan_id JOIN users u ON u.id=e.user_id WHERE ${activeEntitlementSql}) activeEntitlements,
 (SELECT COUNT(*) FROM user_entitlements e JOIN plans p ON p.id=e.plan_id JOIN users u ON u.id=e.user_id WHERE ${activeEntitlementSql} AND e.expires_at<=?) expiringEntitlements,
 (SELECT COUNT(*) FROM tickets WHERE status='open') pendingTickets,
 (SELECT COUNT(*) FROM plans) plans,(SELECT COUNT(*) FROM groups) groups,(SELECT COUNT(*) FROM nodes) nodes`).bind(now,now,now,now,end).first()
 return row
}
type Sender=(message:MailMessage)=>Promise<MailSendResult>
async function deliver(sender:Sender,message:MailMessage) { try { return (await sender(message)).ok } catch { return false } }
export async function broadcast(db:D1Database,actor:string,input:{subject:string;body:string;target:'all'|'active'|'expiring'},sender:Sender=sendMail) {
 const now=new Date().toISOString(),id=crypto.randomUUID(), users=await recipients(db,input.target,now)
 await db.prepare("INSERT INTO mail_broadcasts(id,subject,body,target,status,total,created_by,created_at) VALUES(?,?,?,?,'sending',?,?,?)").bind(id,input.subject,input.body,input.target,users.length,actor,now).run()
 let sent=0,failed=0
 for(const user of users) {
 const content=await templateContent(db,'broadcast',{subject:input.subject,body:input.body,username:user.username})
 if(user.email && await deliver(sender,{to:user.email,...content})) sent++; else failed++
 // Persist progress so interrupted jobs remain reviewable as sending.
 await db.prepare('UPDATE mail_broadcasts SET sent=?,failed=? WHERE id=?').bind(sent,failed,id).run()
 }
 const status=failed===0?'sent':sent===0?'failed':'partial'
 await db.prepare('UPDATE mail_broadcasts SET status=?,sent_at=? WHERE id=?').bind(status,new Date().toISOString(),id).run()
 return {id,status,total:users.length,sent,failed}
}
export function alreadyReminded(last:number|null,expires:string):boolean {
 return last!==null && new Date(last*1000).toISOString().slice(0,10)===expires.slice(0,10)
}
export async function reminderDays(db:D1Database) {
 const raw=await getSetting(db,'reminder_days'); const value=raw===null?3:JSON.parse(raw)
 return typeof value==='number' && Number.isInteger(value) && value>=1 && value<=365 ? value:3
}
export async function expiryReminders(db:D1Database,sender:Sender=sendMail,now=new Date().toISOString()) {
 const users=await recipients(db,'expiring',now,await reminderDays(db))
 let sent=0,failed=0,skipped=0
 for(const user of users) {
 if(alreadyReminded(user.last_reminded_at,user.expires_at)) { skipped++; continue }
 const content=await templateContent(db,'expiry_reminder',{username:user.username,plan:user.plan,expires_at:user.expires_at})
 if(user.email && await deliver(sender,{to:user.email,...content})) {
 // Store the reminded expiry date as a Unix timestamp; renewal changes the date and permits another reminder.
 await db.prepare('UPDATE user_entitlements SET last_reminded_at=? WHERE id=? AND expires_at=?').bind(Math.floor(Date.parse(user.expires_at)/1000),user.entitlement_id,user.expires_at).run(); sent++
 } else failed++
 }
 return {processed:users.length,sent,failed,skipped}
}
