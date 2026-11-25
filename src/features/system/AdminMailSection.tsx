import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Dialog } from '../../ui/Dialog'
import { Input, Textarea, FormSelect } from '../../ui/Controls'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, jsonBody, peekApi, readData } from '../../app/api'
import { AdvancedFields, FormActions, FormField, FormGroup } from '../../ui/FormField'
import { Section } from '../../ui/Section'
import { StatusMessage } from '../../ui/StatusMessage'
import { ErrorState } from '../../ui/ErrorState'
type Template={key:string;subject:string;body:string}
type Broadcast={id:string;subject:string;status:string;total:number;sent:number;failed:number;created_at:string}
export function AdminMailSection() {
 const [templates, setTemplates] = useState(() => peekApi<{ templates: Template[] }>('/api/admin/mail-templates')?.templates ?? [])
 const [ready, setReady] = useState(() => peekApi('/api/admin/mail-templates') !== undefined)
 const editTrigger = useRef<HTMLButtonElement>(null)
 const [draft, setDraft] = useState<Template | null>(null)
 const [resetting, setResetting] = useState(false)
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
    setReady(true)
   })
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : '加载失败')
  }
 }, [])
 useEffect(()=>{void load()},[load])
 async function run(action:()=>Promise<unknown>, onSuccess?: () => void) {if (busy) return;setBusy(true);setError('');setResult('');try{const value=await action();const counts=value as {total?:number;processed?:number;sent?:number;failed?:number;skipped?:number}|null;setResult(counts && typeof counts.sent==='number' ? `处理 ${counts.processed ?? counts.total ?? 0}，发送 ${counts.sent}，失败 ${counts.failed ?? 0}，跳过 ${counts.skipped ?? 0}` : '已保存');await load();onSuccess?.()}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}}
 return <>
 <Section title="邮件模板与群发">
 {error && !draft?<ErrorState message={error} onRetry={()=>void load()}/>:null}
 {!ready && !error ? <p role="status">正在加载邮件模板</p> : null}
 {ready ? <>
 {result?<p role="status">{result}</p>:null}
 <ul className="form-stack">
   {templates.map(template => <li key={template.key}>
     <button className="button secondary" type="button" disabled={busy} onClick={(event) => { editTrigger.current = event.currentTarget; setError(''); setDraft(template) }}>
       编辑 {template.key}
     </button>
   </li>)}
 </ul>
 <Dialog open={draft !== null && !resetting} title={draft ? `编辑邮件模板 · ${draft.key}` : '编辑邮件模板'}
   size="xl" appearance="content" busy={busy} returnFocusRef={editTrigger} dirty={draft !== null && !templates.some(template => template.key === draft.key && template.subject === draft.subject && template.body === draft.body)}
   onClose={() => { setDraft(null); setError('') }}
   footer={(cancel) => <>
     <button type="button" className="button secondary" disabled={busy} onClick={cancel}>取消</button>
     <button type="submit" className="button primary" form="mail-template-editor" disabled={busy}>保存模板</button>
   </>}>
   {draft && <form id="mail-template-editor" className="form-stack" onSubmit={event => {
     event.preventDefault()
     void run(() => api(`/api/admin/mail-templates/${draft.key}`, {
       method: 'PUT', body: jsonBody({ subject: draft.subject, body: draft.body }),
     }), () => setDraft(null))
   }}>
     <FormField label="标题" htmlFor="mail-template-subject">
       <Input id="mail-template-subject" required maxLength={500} value={draft.subject} disabled={busy}
         onChange={event => setDraft({ ...draft, subject: event.currentTarget.value })} />
     </FormField>
     <FormField label="正文" htmlFor="mail-template-body">
       <Textarea id="mail-template-body" rows={10} required value={draft.body} disabled={busy}
         onChange={event => setDraft({ ...draft, body: event.currentTarget.value })} />
     </FormField>
     <p className="sys-hint">文本变量 {draft.key === 'verification' ? '{{username}}, {{code}}, {{purpose}}' : draft.key === 'expiry_reminder' ? '{{username}}, {{plan}}, {{expires_at}}' : '{{username}}, {{subject}}, {{body}}'}</p>
     {error && <StatusMessage tone="error">{error}</StatusMessage>}
     <div className="content-danger-zone">
       <p className="sys-hint">自定义模板及当前编辑将被清除</p>
       <button type="button" className="button ghost" disabled={busy} onClick={() => { setError(''); setResetting(true) }}>恢复默认</button>
     </div>
   </form>}
 </Dialog>
 <ConfirmDialog open={resetting} title="恢复默认模板" description="自定义模板及当前编辑将被清除"
   confirmLabel="恢复默认" danger busy={busy} appearance="content" returnFocusRef={editTrigger} onClose={() => { setResetting(false); setError('') }}
   onConfirm={() => {
     if (draft) void run(() => api(`/api/admin/mail-templates/${draft.key}`, { method: 'DELETE' }), () => {
       setResetting(false)
       setDraft(null)
     })
   }}>
   {error && <StatusMessage tone="error">{error}</StatusMessage>}
 </ConfirmDialog>
 <form className="sys-form sp-form-stack" onSubmit={e=>{e.preventDefault();void run(()=>api('/api/admin/mail-broadcasts',{method:'POST',body:jsonBody({subject,body,target})}))}}>
 <FormGroup id="sys-mail-broadcast-title" title="群发邮件" hint="逐个发送并记录结果；无邮箱或邮件服务未配置会计为失败">
 <FormField label="目标"><FormSelect aria-label="目标" value={target} onChange={e=>setTarget(e.target.value)}><option value="all">全部用户</option><option value="active">有效订阅用户</option><option value="expiring">7 日内到期用户</option></FormSelect></FormField>
 <FormField label="标题"><Input required maxLength={500} value={subject} onChange={e=>setSubject(e.target.value)}/></FormField>
 <FormField label="正文" wide><Textarea required maxLength={50000} value={body} onChange={e=>setBody(e.target.value)}/></FormField>
 <FormActions><button className="button primary" disabled={busy}>发送群发邮件</button></FormActions>
 </FormGroup></form>
 <AdvancedFields label="发送历史（最近 100 条）"><ul>{history.map(h=><li key={h.id}>{h.created_at} · {h.subject} · {h.status} · 总数 {h.total} / 成功 {h.sent} / 失败 {h.failed}</li>)}</ul></AdvancedFields>
 </> : null}
 </Section>
 {ready ? <form className="sys-form sp-form-stack" onSubmit={e=>{e.preventDefault();void run(()=>api('/api/admin/system/reminders',{method:'PUT',body:jsonBody({reminder_days:days})}))}}>
 <Section title="到期提醒" actions={<button className="button primary" type="submit" disabled={busy}>保存天数</button>}>
 <FormField label="提前天数"><Input type="number" min={1} max={365} required value={days} onChange={e=>setDays(Number(e.target.value))}/></FormField>
 <FormActions><button className="button" type="button" disabled={busy} onClick={()=>void run(()=>api('/api/admin/jobs/expiry-reminders',{method:'POST'}))}>手动发送到期提醒</button></FormActions>
 <p className="sys-hint">同一到期日只提醒一次；失败可重试。自动定时触发待 cron 修复</p>
 </Section>
 </form> : null}
 </>
}
