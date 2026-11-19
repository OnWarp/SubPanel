import { useEffect, useState } from 'react'
import { api, jsonBody, loadSubscriptionTemplates, subscriptionTemplatesPath as ROOT, type SubscriptionTemplate, type TemplateBinding as Binding } from '../../app/api'
import { FormField } from '../../ui/FormField'
import { FormSelect } from '../../ui/Controls'
import { StatusMessage } from '../../ui/StatusMessage'
export function TemplateBinding({subscriptionId}:{subscriptionId:string}) {
 const [value,setValue]=useState('inherit'),[rows,setRows]=useState<SubscriptionTemplate[]>([]),[revision,setRevision]=useState(1),[error,setError]=useState(''),[busy,setBusy]=useState(true)
 useEffect(()=>{let live=true;void Promise.all([api<Binding>(`${ROOT}/bindings/${subscriptionId}`),loadSubscriptionTemplates()]).then(([b,r])=>{if(live){setValue(b.mode==='specific'?b.templateId!:b.mode);setRows(r.templates);setRevision(b.revision)}}).catch(e=>{if(live)setError(String(e))}).finally(()=>{if(live)setBusy(false)});return()=>{live=false}},[subscriptionId])
 return <FormField label="附加配置"><FormSelect aria-label="附加配置" disabled={busy} value={value} onChange={e=>{const next=e.target.value;setBusy(true);setError('');void api<{revision:number}>(`${ROOT}/bindings/${subscriptionId}`,{method:'PUT',body:jsonBody(next==='inherit'||next==='base'?{mode:next,expectedRevision:revision}:{mode:'specific',templateId:next,expectedRevision:revision})}).then(result=>{setValue(next);setRevision(result.revision)}).catch(e=>setError(String(e))).finally(()=>setBusy(false))}}><option value="inherit">继承默认</option><option value="base">基础配置</option>{rows.filter(r=>r.publishedVersionId).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</FormSelect><span className="sys-hint">选择后立即保存</span>{error?<StatusMessage tone="error">{error}</StatusMessage>:null}</FormField>
}
