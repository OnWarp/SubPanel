import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { validateTemplate } from '../../../worker/templates/validation'
import { renderClient, type RenderNode } from '../../../worker/renderers'
const yaml = `proxies: []
dns: {enable: true}
proxy-groups:
 - name: Proxy
   type: select
   proxies: ["$SUBPANEL_NODES", DIRECT]
rules:
 - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
 - MATCH,Proxy
`
const node = (name:string):RenderNode => ({id:'nod_1',displayName:name,enabled:true,protocol:'trojan',server:'private.example',port:443,credentials:{password:'secret'},rawVariants:[],tls:{},transport:{},plugin:{},extensions:{}} as RenderNode)
describe('Mihomo policy templates',()=>{
 it('reports ignored full-config fields',()=>expect(validateTemplate(yaml).ignored).toEqual(['proxies','dns']))
 it.each([
  ['unknown target',yaml.replace('MATCH,Proxy','MATCH,Unknown')],
  ['missing fallback',yaml.replace(' - MATCH,Proxy','')],
  ['cycle',yaml.replace('"$SUBPANEL_NODES", DIRECT','"$SUBPANEL_NODES", Proxy')],
  ['unknown provider',yaml.replace('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve','RULE-SET,missing,DIRECT')],
  ['reserved name',yaml.replaceAll('Proxy','DIRECT')],
  ['empty group',yaml.replace('["$SUBPANEL_NODES", DIRECT]','[]')],
  ['duplicate group',yaml.replace('rules:', ' - name: Proxy\n   type: select\n   proxies: [DIRECT]\nrules:')],
 ])('rejects %s before publication',(_,input)=>expect(()=>validateTemplate(input)).toThrow())
 it('expands structural names with punctuation and resolves all collisions',()=>{
 const template=validateTemplate(yaml).template
 const result=parse(renderClient('mihomo',[node('Proxy'),node('a, b'),node('a, b'),node('a, b (2)')],template).body)
 const names=result.proxies.map((p:{name:string})=>p.name)
 expect(new Set(names).size).toBe(4)
 expect(names).not.toContain('Proxy')
 expect(result['proxy-groups'][0].proxies).toEqual([...names,'DIRECT'])
 expect(result.rules).toEqual(template.rules)
 })
 it('uses only the supplied entitlement-filtered nodes',()=>{
 const t=validateTemplate(yaml).template
 expect(renderClient('mihomo',[node('User A')],t).body).not.toContain('User B')
 expect(renderClient('mihomo',[node('User B')],t).body).not.toContain('User A')
 })
 it('preserves base output and empty paths',()=>{
 const t=validateTemplate(yaml).template
 expect(renderClient('mihomo',[],t).body).toBe(renderClient('mihomo',[]).body)
 expect(renderClient('mihomo',[{...node('x'),enabled:false}],t).body).toBe(renderClient('mihomo',[]).body)
 })
 it.each(['generic','singbox','surge','loon','quantumultx','v2rayn','nekobox','shadowrocket'] as const)('preserves %s output',client=>{
 expect(renderClient(client,[node('x')],validateTemplate(yaml).template).body).toBe(renderClient(client,[node('x')]).body)
 })
})
