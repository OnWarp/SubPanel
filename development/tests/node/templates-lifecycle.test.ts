import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { renderEntitledSubscription } from '../../../worker/delivery/compiler'
import { templateRoutes } from '../../../worker/templates/routes'
import { resolvedTemplate } from '../../../worker/templates/repository'
import { renderClient, type RenderNode } from '../../../worker/renderers'
import { createHash } from 'node:crypto'
const hashToken = async (body:string) => createHash('sha256').update(body).digest('hex')
import { ApiError } from '../../../worker/platform/api-error'
vi.mock('../../../worker/delivery/service',()=>({getSubscription:async (_env:unknown,id:string)=>({id,name:id,groupIds:['grp_1']})}))
vi.mock('../../../worker/delivery/compiler',()=>({renderEntitledSubscription:vi.fn()}))
let db:D1Database, app:Hono
const base='proxy-groups:\n - name: Proxy\n   type: select\n   proxies: ["$SUBPANEL_NODES"]\nrules:\n - MATCH,Proxy\n'
const changed=base.replace(' - MATCH,Proxy',' - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve\n - MATCH,Proxy')
const node={id:'nod_1',displayName:'A',enabled:true,protocol:'trojan',server:'secret.example',port:443,credentials:{password:'secret'},rawVariants:[],tls:{},transport:{},plugin:{},extensions:{}} as RenderNode
beforeEach(()=>{
 const sqlite=new DatabaseSync(':memory:')
 for (const file of ['0001_init.sql', '0015_subscription_templates.sql', '0017_template_enhancements.sql']) {
  sqlite.exec(readFileSync(`migrations/${file}`,'utf8'))
 }
 const prepare=(sql:string)=>{
  let values:unknown[]=[]
  const stmt={bind:(...args:unknown[])=>{values=args;return stmt},first:async()=>sqlite.prepare(sql).get(...values as never[])??null,all:async()=>({results:sqlite.prepare(sql).all(...values as never[])}),run:async()=>({meta:{changes:sqlite.prepare(sql).run(...values as never[]).changes}})}
  return stmt
 }
 db={prepare,batch:async (statements:{run:()=>Promise<unknown>}[])=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results}catch(e){sqlite.exec('ROLLBACK');throw e}}} as unknown as D1Database
 app=new Hono();app.route('/templates',templateRoutes as never)
 app.onError((e,c)=>c.json({error:e.message},e instanceof ApiError?e.status:500))
})
async function request(path: string, body?: Record<string, unknown>, method = 'POST') {
 const match = /^\/([^/]+)(?:\/(.*))?$/u.exec(path)
 let payload = body
 if (match && (method === 'PUT' || ['publish', 'rollback', 'archive', 'import'].includes(match[2]))) {
  if (match[1] === 'default') {
   const row = await db.prepare('SELECT revision FROM subscription_template_default').first()
   payload = { expectedRevision: row?.revision, ...body }
  } else if (match[1] === 'bindings') {
   const row = await db.prepare('SELECT revision FROM subscription_template_bindings WHERE subscription_id=?').bind(match[2]).first()
   payload = { expectedRevision: row?.revision ?? 1, ...body }
  } else {
   const row = await db.prepare('SELECT revision,draft_hash FROM subscription_templates WHERE id=?').bind(match[1]).first()
   payload = { expectedRevision: row?.revision, ...(match[2] === 'publish' ? { draftHash: row?.draft_hash } : {}), ...body }
  }
 }
 return app.request('/templates' + path, {
  method, headers: { 'Content-Type': 'application/json' },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
 }, { DB: db, DATA: { get: async () => null } })
}
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

it.each(['noPlan', 'noGroupIntersection', 'noEnabledNodes', 'incompatible'])('explains zero nodes: %s',async zeroNodeReason => {
 vi.mocked(renderEntitledSubscription).mockResolvedValue({
  body:renderClient('mihomo',[]).body,outputNodes:0,available:false,zeroNodeReason,
 } as never)
 const response=await request('/preview',{yaml:base,subscriptionId:'zero'})
 expect(response.status).toBe(200)
 const data=await response.json()
 expect(data).toMatchObject({zeroNodeReason,outputNodes:0,subscriptionName:'zero'})
 expect(JSON.stringify(data)).not.toContain('secret')
})
it('imports a candidate before explicit save and leaves HTTPS rule-providers entirely to the client',async()=>{
 const id=await create();await request(`/${id}/publish`);await request('/default',{templateId:id},'PUT')
 const original=await output('old')
 const providerYaml=changed+'rule-providers:\n  ads:\n    type: http\n    behavior: domain\n    url: https://rules.example/ads.yaml\n'
 const fetcher=vi.fn().mockResolvedValue(new Response(providerYaml));vi.stubGlobal('fetch',fetcher)
 try{
 const imported = await request(`/${id}/import`,{url:'https://template.example/policy'})
 expect(imported.status).toBe(200)
 const { candidate, source } = await imported.json() as { candidate: { yaml: string }; source: unknown }
 expect((await request(`/${id}`,{name:'Policy',yaml:candidate.yaml,source},'PUT')).status).toBe(200)
 expect(await output('old')).toBe(original)
 await request(`/${id}/publish`)
 expect(await output('old')).toContain('https://rules.example/ads.yaml')
 expect(fetcher).toHaveBeenCalledTimes(1)
 }finally{vi.unstubAllGlobals()}
})
