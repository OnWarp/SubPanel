import { useEffect, useState } from 'react'
import { api, jsonBody } from '../../app/api'
import { FormField } from '../../ui/FormField'
import { FormSelect } from '../../ui/Controls'
import { StatusMessage } from '../../ui/StatusMessage'
const ROOT='/api/admin/system/subscription-templates'
export function TemplateBinding({subscriptionId}:{subscriptionId:string}) {
 const [value,setValue]=useState('inherit'),[rows,setRows]=useState<{id:string;name:string;published_id:string|null}[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(true)
 useEffect(()=>{let live=true;void Promise.all([api<{mode:string;template_id:string|null}>(`${ROOT}/bindings/${subscriptionId}`),api<{templates:typeof rows}>(ROOT)]).then(([b,r])=>{if(live){setValue(b.mode==='specific'?b.template_id!:b.mode);setRows(r.templates)}}).catch(e=>{if(live)setError(String(e))}).finally(()=>{if(live)setBusy(false)});return()=>{live=false}},[subscriptionId])
 return <FormField label="附加配置"><FormSelect aria-label="附加配置" disabled={busy} value={value} onChange={e=>{const next=e.target.value;setBusy(true);setError('');void api(`${ROOT}/bindings/${subscriptionId}`,{method:'PUT',body:jsonBody(next==='inherit'||next==='base'?{mode:next}:{mode:'specific',templateId:next})}).then(()=>setValue(next)).catch(e=>setError(String(e))).finally(()=>setBusy(false))}}><option value="inherit">继承默认</option><option value="base">基础配置</option>{rows.filter(r=>r.published_id).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</FormSelect><span className="sys-hint">选择后立即保存</span>{error?<StatusMessage tone="error">{error}</StatusMessage>:null}</FormField>
}
