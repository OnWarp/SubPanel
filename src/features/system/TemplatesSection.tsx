import { useEffect, useState } from 'react'
import { api, jsonBody, loadSubscriptionTemplates, subscriptionTemplatesPath as ROOT, type SubscriptionTemplate as Row, type TemplateDetailResponse, type TemplateImportResponse, type TemplatePublishResponse, type TemplateSource, type TemplateValidateResponse, type TemplateVersion } from '../../app/api'
import { FormField } from '../../ui/FormField'
import { FormSelect, Input, Textarea } from '../../ui/Controls'
import { DataHeader } from '../../ui/DataHeader'
import { StatusMessage } from '../../ui/StatusMessage'

const INITIAL = 'proxy-groups:\n  - name: Proxy\n    type: select\n    proxies: ["$SUBPANEL_NODES"]\nrules:\n  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve\n  - MATCH,Proxy\n'
export function TemplatesSection() {
 const [rows,setRows] = useState<Row[]>([]), [defaultId,setDefault] = useState(''), [defaultRevision,setDefaultRevision] = useState(1)
 const [id,setId] = useState(''), [name,setName] = useState(''), [yaml,setYaml] = useState(INITIAL)
 const [subscriptionId,setSubscription] = useState(''), [subscriptions,setSubscriptions] = useState<{id:string;name:string}[]>([])
 const [preview,setPreview] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false)
 const [url,setUrl] = useState(''), [versions,setVersions] = useState<TemplateVersion[]>([])
 const [source,setSource] = useState<TemplateSource>(), [saved,setSaved] = useState<{revision:number;draftHash:string;name:string;yaml:string}>()
 const load = async () => { const data = await loadSubscriptionTemplates();setRows(data.templates);setDefault(data.defaultId ?? '');setDefaultRevision(data.defaultRevision) }
 const run = async (fn:()=>Promise<void>) => {setBusy(true);setError('');try {await fn()} catch(e) {setError(e instanceof Error ? e.message : '操作失败')} finally {setBusy(false)}}
 useEffect(() => {void run(async()=>{await load();setSubscriptions((await api<{subscriptions:{id:string;name:string}[]}>('/api/admin/subscriptions')).subscriptions)})},[])
 const edit = async (row:Row) => {
  const detail = await api<TemplateDetailResponse>(`${ROOT}/${row.id}`)
  setId(detail.id);setName(detail.name);setYaml(detail.draft);setUrl(detail.sourceUrl ?? '');setSource(undefined);setPreview('');setVersions([])
  setSaved({revision:detail.revision,draftHash:detail.draftHash,name:detail.name,yaml:detail.draft})
  return detail
 }
 const save = async () => {
  const body = jsonBody({name,yaml,source,expectedRevision:saved?.revision})
  const result = id
    ? await api<{revision:number;draftHash:string}>(`${ROOT}/${id}`,{method:'PUT',body})
    : await api<{id:string;revision:number;draftHash:string}>(ROOT,{method:'POST',body})
  if ('id' in result) setId(String(result.id))
  setSaved({...result,name,yaml});setSource(undefined)
  await load()
 }
 return <section className="data-section sys-section ops-template"><DataHeader title="附加配置" actions={<button className="button primary ops-primary" onClick={()=>{setId('');setName('');setYaml(INITIAL);setUrl('');setSaved(undefined);setSource(undefined);setPreview('');setVersions([])}}>新增配置</button>}/>
 <FormField label="默认配置"><FormSelect aria-label="默认配置" disabled={busy} value={defaultId} onChange={e=>{const value=e.target.value;void run(async()=>{await api(`${ROOT}/default`,{method:'PUT',body:jsonBody({templateId:value||null,expectedRevision:defaultRevision})});await load()})}}><option value="">基础配置</option>{rows.filter(r=>r.publishedVersionId).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</FormSelect></FormField>
 {rows.map(row=><article className="ops-template-row" key={row.id}><strong>{row.name}</strong> · {row.publishedVersionId?'已发布':'草稿'} · {row.publishedAt ?? '尚未发布'} <button className="button ghost" disabled={busy} onClick={()=>void run(async()=>{await edit(row)})}>编辑</button><button className="button ghost" disabled={busy} onClick={()=>void run(async()=>{const detail=await edit(row);setPreview(JSON.stringify(await api(`${ROOT}/preview`,{method:'POST',body:jsonBody({yaml:detail.draft,subscriptionId:subscriptionId||undefined})}),null,2))})}>预览</button><details><summary>更多</summary><button className="button ghost" disabled={busy} onClick={()=>void run(async()=>{await edit(row);setVersions((await api<{versions:TemplateVersion[]}>(`${ROOT}/${row.id}/versions`)).versions)})}>版本回退</button><button className="button ghost" disabled={busy} onClick={()=>void run(async()=>{await api(`${ROOT}/${row.id}/archive`,{method:'POST',body:jsonBody({expectedRevision:row.revision})});await load()})}>归档</button></details></article>)}
 <div className="form-stack ops-group"><FormField label="配置名称"><Input aria-label="配置名称" value={name} onChange={e=>setName(e.target.value)} maxLength={128}/></FormField><FormField label="粘贴 YAML"><Textarea aria-label="粘贴 YAML" rows={16} value={yaml} onChange={e=>{setYaml(e.target.value);setPreview('')}}/></FormField>
 <FormField label="从 HTTPS 地址导入"><Input aria-label="从 HTTPS 地址导入" type="url" value={url} onChange={e=>setUrl(e.target.value)}/></FormField><button className="button" disabled={busy||!id} onClick={()=>void run(async()=>{const result=await api<TemplateImportResponse>(`${ROOT}/${id}/import`,{method:'POST',body:jsonBody({url,expectedRevision:saved?.revision})});if(result.notModified){setPreview(result.message);return}setYaml(result.candidate.yaml);setSource(result.source);setPreview(JSON.stringify({ignored:result.candidate.ignored},null,2));})}>导入 / 重新导入</button><p className="sys-hint">先保存草稿再导入，每次点击仅发起一次导入，失败后手动重试</p>
 <FormField label="核对订阅"><FormSelect aria-label="核对订阅" value={subscriptionId} onChange={e=>{setSubscription(e.target.value);setPreview('')}}><option value="">仅校验配置</option>{subscriptions.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</FormSelect></FormField>
 <div className="sys-actions"><button className="button" disabled={busy||!name.trim()} onClick={()=>void run(save)}>保存草稿</button><button className="button" disabled={busy} onClick={()=>void run(async()=>setPreview(JSON.stringify(await api(`${ROOT}/preview`,{method:'POST',body:jsonBody({yaml,subscriptionId:subscriptionId||undefined})}),null,2)))}>预览</button><button className="button primary" disabled={busy||!id||!saved||saved.name!==name||saved.yaml!==yaml||Boolean(source)} onClick={()=>void run(async()=>{
  if(!saved)return
  const {ignored}=await api<TemplateValidateResponse>(`${ROOT}/validate`,{method:'POST',body:jsonBody({yaml})})
  if(ignored.length && !window.confirm(`发布时将忽略字段 ${ignored.join('、')}，是否继续？`))return
  const result=await api<TemplatePublishResponse>(`${ROOT}/${id}/publish`,{method:'POST',body:jsonBody({expectedRevision:saved.revision,draftHash:saved.draftHash,ignoredAcknowledged:ignored.length>0})})
  setSaved({...saved,revision:result.revision});await load()
 })}>发布已保存草稿</button></div>
 {versions.map(v=><button className="button" key={v.id} disabled={busy} onClick={()=>void run(async()=>{const result=await api<{revision:number}>(`${ROOT}/${id}/rollback`,{method:'POST',body:jsonBody({versionId:v.id,expectedRevision:saved?.revision})});setSaved(current=>current&&{...current,revision:result.revision});await load()})}>回退至 {v.createdAt}</button>)}
 {error?<StatusMessage tone="error">{error}</StatusMessage>:null}{preview?<><p className="sys-hint">预览已隐藏节点地址、凭据与订阅令牌，ignored 为被忽略字段</p><pre>{preview}</pre></>:null}</div></section>
}
