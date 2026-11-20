import { Input, Textarea, FormSelect } from '../../ui/Controls'
import { useCallback, useEffect, useState } from 'react'
import { api, jsonBody, peekApi, readData } from '../../app/api'
import { DataHeader } from '../../ui/DataHeader'
import { FormField } from '../../ui/FormField'
import { ErrorState } from '../../ui/ErrorState'
type Template={key:string;subject:string;body:string}
type Broadcast={id:string;subject:string;status:string;total:number;sent:number;failed:number;created_at:string}
export function AdminMailSection() {
 const [templates, setTemplates] = useState(() => peekApi<{ templates: Template[] }>('/api/admin/mail-templates')?.templates ?? [])
 const [history, setHistory] = useState(() => peekApi<{ broadcasts: Broadcast[] }>('/api/admin/mail-broadcasts')?.broadcasts ?? [])
 const [subject,setSubject]=useState(''),[body,setBody]=useState(''),[target,setTarget]=useState('all')
 const [days, setDays] = useState(() => peekApi<{ reminder_days: number }>('/api/admin/system/reminders')?.reminder_days ?? 3)
 const [error,setError]=useState(''),[result,setResult]=useState(''),[busy,setBusy]=useState(false)
 const load = useCallback(async () => {
  const before = peekApi<{ templates: Template[] }>('/api/admin/mail-templates')?.templates
  const beforeDays = peekApi<{ reminder_days: number }>('/api/admin/system/reminders')?.reminder_days ?? 3
  try {
   await readData((read) => Promise.all([
    read<{ templates: Template[] }>('/api/admin/mail-templates'),
    read<{ broadcasts: Broadcast[] }>('/api/admin/mail-broadcasts'),
    read<{ reminder_days: number }>('/api/admin/system/reminders'),
   ]), ([templateData, broadcastData, reminders]) => {
    setTemplates((current) => !before || current === before ? templateData.templates : current)
    setHistory(broadcastData.broadcasts)
    setDays((current) => current === beforeDays ? reminders.reminder_days : current)
   })
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : '加载失败')
  }
 }, [])
 useEffect(()=>{void load()},[load])
 async function run(action:()=>Promise<unknown>) {setBusy(true);setError('');setResult('');try{const value=await action();const counts=value as {total?:number;processed?:number;sent?:number;failed?:number;skipped?:number}|null;setResult(counts && typeof counts.sent==='number' ? `处理 ${counts.processed ?? counts.total ?? 0}，发送 ${counts.sent}，失败 ${counts.failed ?? 0}，跳过 ${counts.skipped ?? 0}` : '已保存');await load()}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}}
 return <section className="data-section sys-section"><DataHeader title="邮件模板与群发" />
 {error?<ErrorState message={error} onRetry={()=>void load()}/>:null}
 {result?<p role="status">{result}</p>:null}
 <p className="sys-hint">文本变量：验证码 verification：{'{{username}}, {{code}}, {{purpose}}'}；到期 expiry_reminder：{'{{username}}, {{plan}}, {{expires_at}}'}；群发 broadcast：{'{{username}}, {{subject}}, {{body}}'}。恢复默认会删除自定义模板。</p>
 {templates.map((t,i)=><form className="sys-form" key={t.key} onSubmit={e=>{e.preventDefault();void run(()=>api(`/api/admin/mail-templates/${t.key}`,{method:'PUT',body:jsonBody({subject:t.subject,body:t.body})}))}}>
 <DataHeader title={t.key} actions={<button className="button primary" type="submit" disabled={busy}>保存模板</button>} /><FormField label="标题"><Input required maxLength={500} value={t.subject} onChange={e=>setTemplates(templates.map((v,j)=>j===i?{...v,subject:e.target.value}:v))}/></FormField>
 <FormField label="正文"><Textarea required value={t.body} onChange={e=>setTemplates(templates.map((v,j)=>j===i?{...v,body:e.target.value}:v))}/></FormField>
 <div className="sys-actions"><button type="button" className="button ghost" disabled={busy} onClick={()=>void run(()=>api(`/api/admin/mail-templates/${t.key}`,{method:'DELETE'}))}>恢复默认</button></div></form>)}
 <form className="sys-form" onSubmit={e=>{e.preventDefault();void run(()=>api('/api/admin/mail-broadcasts',{method:'POST',body:jsonBody({subject,body,target})}))}}>
 <h3>群发邮件</h3><p className="sys-hint">逐个发送并记录结果；无邮箱或邮件服务未配置会计为失败。</p>
 <FormField label="目标"><FormSelect aria-label="目标" value={target} onChange={e=>setTarget(e.target.value)}><option value="all">全部用户</option><option value="active">有效订阅用户</option><option value="expiring">7 日内到期用户</option></FormSelect></FormField>
 <FormField label="标题"><Input required maxLength={500} value={subject} onChange={e=>setSubject(e.target.value)}/></FormField><FormField label="正文"><Textarea required maxLength={50000} value={body} onChange={e=>setBody(e.target.value)}/></FormField><button className="button primary" disabled={busy}>发送群发邮件</button></form>
 <h3>发送历史（最近 100 条）</h3><ul>{history.map(h=><li key={h.id}>{h.created_at} · {h.subject} · {h.status} · 总数 {h.total} / 成功 {h.sent} / 失败 {h.failed}</li>)}</ul>
 <form className="sys-form" onSubmit={e=>{e.preventDefault();void run(()=>api('/api/admin/system/reminders',{method:'PUT',body:jsonBody({reminder_days:days})}))}}><DataHeader title="到期提醒" actions={<button className="button primary" type="submit" disabled={busy}>保存天数</button>} /><FormField label="提前天数"><Input type="number" min={1} max={365} required value={days} onChange={e=>setDays(Number(e.target.value))}/></FormField><div className="sys-actions"><button className="button" type="button" disabled={busy} onClick={()=>void run(()=>api('/api/admin/jobs/expiry-reminders',{method:'POST'}))}>手动发送到期提醒</button></div><p className="sys-hint">同一到期日只提醒一次；失败可重试。自动定时触发待 cron 修复。</p></form>
 </section>
}
