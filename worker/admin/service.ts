import { sendMail, type MailMessage, type MailSendResult } from '../accounts/email.js'
import { getSetting } from '../db/settings-repository.js'
import { templateContent } from './templates.js'
type Recipient = { id:string; email:string|null; username:string; expires_at:number|null; last_reminded_at:number|null; plan:string }
export async function recipients(db:D1Database,target:'all'|'active'|'expiring',now=new Date().toISOString(),days=7):Promise<Recipient[]> {
 if(target==='all') return (await db.prepare('SELECT id,email,username FROM users WHERE deleted_at IS NULL ORDER BY id').all<Recipient>()).results
 const time=Date.parse(now), end=time+days*86400000
  return (await db.prepare(`WITH windows AS (
    SELECT b.user_id, CASE WHEN count(*)=count(b.expires_at) THEN max(b.expires_at) END AS expires_at
    FROM user_template_bindings b JOIN entitlement_templates t ON t.id=b.template_id
    JOIN user_subscription_access a ON a.user_id=b.user_id
    LEFT JOIN entitlement_plan_policies ep ON ep.template_id=t.id
    LEFT JOIN plans p ON p.id=ep.plan_id
    WHERE b.status='active' AND t.status='enabled' AND a.enabled=1 AND coalesce(p.enabled,1)=1
      AND b.starts_at<=? AND (b.expires_at IS NULL OR b.expires_at>?)
    GROUP BY b.user_id
  )
  SELECT u.id,u.email,u.username,w.expires_at,cast(r.expires_at/1000 AS INTEGER) last_reminded_at,
    '统一' AS plan
  FROM windows w JOIN users u ON u.id=w.user_id LEFT JOIN user_subscription_reminders r ON r.user_id=u.id
  WHERE u.enabled=1 AND u.deleted_at IS NULL ${target === 'expiring' ? 'AND w.expires_at<=?' : ''}
  ORDER BY w.expires_at,u.id`).bind(time,time,...(target==='expiring'?[end]:[])).all<Recipient>()).results
}
export async function adminStats(db:D1Database,now=new Date().toISOString()) {
  const [stats, active] = await Promise.all([
   db.prepare(`SELECT (SELECT count(*) FROM users WHERE deleted_at IS NULL) users,
     (SELECT count(*) FROM tickets WHERE status='open') pendingTickets,
     (SELECT count(*) FROM plans) plans,(SELECT count(*) FROM groups) groups,(SELECT count(*) FROM nodes) nodes`).first(),
   recipients(db,'active',now),
  ])
  const deadline = Date.parse(now) + 7 * 86_400_000
  return { ...stats, activeSubscriptions: active.length,
    expiringSubscriptions: active.filter(user => user.expires_at !== null && user.expires_at <= deadline).length }
}
type Sender=(message:MailMessage)=>Promise<MailSendResult>
async function deliver(sender:Sender,message:MailMessage) { try { return (await sender(message)).ok } catch { return false } }
export async function broadcast(db:D1Database,actor:string,input:{subject:string;body:string;target:'all'|'active'|'expiring'},sender:Sender=sendMail) {
 const now=new Date().toISOString(),id=crypto.randomUUID()
 const users=[...new Map((await recipients(db,input.target,now)).map(user => [user.id,user])).values()]
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
 if(user.expires_at===null) continue
 const expiresAt=new Date(user.expires_at).toISOString()
 if(alreadyReminded(user.last_reminded_at,expiresAt)) { skipped++; continue }
 const content=await templateContent(db,'expiry_reminder',{username:user.username,plan:user.plan,expires_at:expiresAt})
 if(user.email && await deliver(sender,{to:user.email,...content})) {
 // Store the reminded expiry date as a Unix timestamp; renewal changes the date and permits another reminder.
  await db.prepare(`INSERT INTO user_subscription_reminders (user_id,expires_at) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at`)
    .bind(user.id,user.expires_at).run()
 sent++
 } else failed++
 }
 return {processed:users.length,sent,failed,skipped}
}
