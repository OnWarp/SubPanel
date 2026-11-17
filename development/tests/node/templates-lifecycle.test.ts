import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { renderEntitledSubscription } from '../../../worker/delivery/compiler'
import { getUserEntitlement } from '../../../worker/entitlements/service'
import { templateRoutes } from '../../../worker/templates/routes'
import { resolvedTemplate } from '../../../worker/templates/repository'
import { renderClient, type RenderNode } from '../../../worker/renderers'
import { createHash } from 'node:crypto'
const hashToken = async (body:string) => createHash('sha256').update(body).digest('hex')
import { ApiError } from '../../../worker/platform/api-error'
vi.mock('../../../worker/delivery/service',()=>({getSubscription:async (_env:unknown,id:string)=>({id,name:id,groupIds:['grp_1']})}))
vi.mock('../../../worker/delivery/compiler',()=>({renderEntitledSubscription:vi.fn()}))
vi.mock('../../../worker/entitlements/service',()=>({getUserEntitlement:vi.fn()}))
let db:D1Database, app:Hono
const base='proxy-groups:\n - name: Proxy\n   type: select\n   proxies: ["$SUBPANEL_NODES"]\nrules:\n - MATCH,Proxy\n'
const changed=base.replace(' - MATCH,Proxy',' - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve\n - MATCH,Proxy')
const node={id:'nod_1',displayName:'A',enabled:true,protocol:'trojan',server:'secret.example',port:443,credentials:{password:'secret'},rawVariants:[],tls:{},transport:{},plugin:{},extensions:{}} as RenderNode
beforeEach(()=>{
 const sqlite=new DatabaseSync(':memory:')
 sqlite.exec(readFileSync('migrations/0015_subscription_templates.sql','utf8'))
 const prepare=(sql:string)=>{
  let values:unknown[]=[]
  const stmt={bind:(...args:unknown[])=>{values=args;return stmt},first:async()=>sqlite.prepare(sql).get(...values as never[])??null,all:async()=>({results:sqlite.prepare(sql).all(...values as never[])}),run:async()=>({meta:{changes:sqlite.prepare(sql).run(...values as never[]).changes}})}
  return stmt
 }
 db={prepare,batch:async (statements:{run:()=>Promise<unknown>}[])=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results}catch(e){sqlite.exec('ROLLBACK');throw e}}} as unknown as D1Database
 app=new Hono();app.route('/templates',templateRoutes as never)
 app.onError((e,c)=>c.json({error:e.message},e instanceof ApiError?e.status:500))
})
const request=(path:string,body?:unknown,method='POST')=>app.request('/templates'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},{DB:db})
async function create(){const r=await request('',{name:'Policy',yaml:base});return (await r.json() as {id:string}).id}
async function output(id:string){return renderClient('mihomo',[node],await resolvedTemplate(db,id)).body}
it('keeps legacy output; isolates single binding; default changes final ETag; base overrides default; rollback restores bytes',async()=>{
 const original=await output('old')
 expect(original).toBe(renderClient('mihomo',[node]).body)
 const id=await create();expect((await request(`/${id}/publish`)).status).toBe(200)
 const versions=await db.prepare('SELECT id FROM subscription_template_versions').all<{id:string}>()
 const v1=versions.results[0].id
 expect((await request('/bindings/trial',{mode:'specific',templateId:id},'PUT')).status).toBe(200)
 await request(`/${id}`,{name:'Policy',yaml:changed},'PUT');await request(`/${id}/publish`)
 expect(await output('trial')).toContain('192.168.0.0/16')
 expect(await output('old')).toBe(original)
 await request('/default',{templateId:id},'PUT')
 const newer=await output('old');expect(newer).toContain('192.168.0.0/16')
 expect(await hashToken(newer)).not.toBe(await hashToken(original))
 await request('/bindings/base',{mode:'base'},'PUT');expect(await output('base')).toBe(original)
 expect((await request(`/${id}/archive`)).status).toBe(409)
 await request(`/${id}/rollback`,{versionId:v1});expect(await output('old')).toBe(original)
 expect(await hashToken(await output('old'))).toBe(await hashToken(original))
})
it('keeps published output after invalid draft and failed remote import; does not retry or fetch providers',async()=>{
 const id=await create();await request(`/${id}/publish`);await request('/default',{templateId:id},'PUT')
 const original=await output('old')
 await request(`/${id}`,{name:'Policy',yaml:base.replace('MATCH,Proxy','MATCH,missing')},'PUT')
 expect((await request(`/${id}/publish`)).status).toBe(422)
 expect(await output('old')).toBe(original)
 const fetcher=vi.fn().mockRejectedValue(new Error('offline'));vi.stubGlobal('fetch',fetcher)
 try {
 expect((await request(`/${id}/import`,{url:'https://template.example/policy'})).status).toBe(422)
 expect(fetcher).toHaveBeenCalledTimes(1)
 expect(await output('old')).toBe(original)
 expect((await request(`/${id}/import`,{url:'http://template.example/policy'})).status).toBe(422)
 expect(fetcher).toHaveBeenCalledTimes(1)
 }finally{vi.unstubAllGlobals()}
})
it('blocks unsafe redirects without requesting their target',async()=>{
 const id=await create()
 const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}}));vi.stubGlobal('fetch',fetcher)
 try{expect((await request(`/${id}/import`,{url:'https://template.example/policy'})).status).toBe(422);expect(fetcher).toHaveBeenCalledTimes(1)}finally{vi.unstubAllGlobals()}
})

it.each([
 ['无有效权益',false,[],0],
 ['分组无交集',true,[],0],
 ['组内无启用节点',true,['grp_1'],0],
 ['格式不兼容',true,['grp_1'],1],
])('explains zero nodes: %s',async(reason,current,groupIds,inputNodes)=>{
 vi.mocked(getUserEntitlement).mockResolvedValue({current:current?{plan:{groupIds}}:null} as never)
 vi.mocked(renderEntitledSubscription).mockResolvedValue({body:renderClient('mihomo',[]).body,outputNodes:0,inputNodes} as never)
 const response=await request('/preview',{yaml:base,subscriptionId:'zero'})
 expect(response.status).toBe(200)
 const data=await response.json() as {reason:string;outputNodes:number;subscriptionName:string}
 expect(data).toMatchObject({reason,outputNodes:0,subscriptionName:'zero'})
 expect(JSON.stringify(data)).not.toContain('secret')
})
it('imports into draft only and leaves HTTPS rule-providers entirely to the client',async()=>{
 const id=await create();await request(`/${id}/publish`);await request('/default',{templateId:id},'PUT')
 const original=await output('old')
 const providerYaml=changed+'rule-providers:\n  ads:\n    type: http\n    behavior: domain\n    url: https://rules.example/ads.yaml\n'
 const fetcher=vi.fn().mockResolvedValue(new Response(providerYaml));vi.stubGlobal('fetch',fetcher)
 try{
 expect((await request(`/${id}/import`,{url:'https://template.example/policy'})).status).toBe(200)
 expect(await output('old')).toBe(original)
 await request(`/${id}/publish`)
 expect(await output('old')).toContain('https://rules.example/ads.yaml')
 expect(fetcher).toHaveBeenCalledTimes(1)
 }finally{vi.unstubAllGlobals()}
})
