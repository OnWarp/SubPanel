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
 it.each(['generic','surge','loon','quantumultx','v2rayn','nekobox','shadowrocket'] as const)('preserves %s output',client=>{
 expect(renderClient(client,[node('x')],validateTemplate(yaml).template).body).toBe(renderClient(client,[node('x')]).body)
 })
 it('compiles full singbox config when template is provided',()=>{
   const result = JSON.parse(renderClient('singbox',[node('x')],validateTemplate(yaml).template).body)
   expect(result).toHaveProperty('outbounds')
   expect(result).toHaveProperty('route')
   expect(result).toHaveProperty('dns')
 })
})

describe('Mihomo policy syntax and names', () => {
  it.each([
    ['invalid CIDR', 'IP-CIDR,192.168.0.999/16,DIRECT', 'INVALID_RULE_VALUE'],
    ['invalid IPv6 prefix', 'IP-CIDR6,2001:db8::/129,DIRECT', 'INVALID_RULE_VALUE'],
    ['invalid port range', 'DST-PORT,9000-8000,DIRECT', 'INVALID_RULE_VALUE'],
    ['invalid domain', 'DOMAIN,bad..example,DIRECT', 'INVALID_RULE_VALUE'],
    ['invalid regex', 'DOMAIN-REGEX,[,DIRECT', 'INVALID_RULE_VALUE'],
    ['comma in regex', 'DOMAIN-REGEX,a{1,2},DIRECT', 'UNSUPPORTED_REGEX_SYNTAX'],
    ['nested logic', 'AND,((DOMAIN,a.example),(NETWORK,tcp)),DIRECT', 'UNSUPPORTED_RULE_TYPE'],
  ])('diagnoses %s with a path and line', (_label, rule, code) => {
    const input = yaml.replace('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', rule)
    try {
      validateTemplate(input)
      throw new Error('Expected policy validation to fail')
    } catch (error) {
      expect(error).toMatchObject({
        diagnostics: expect.arrayContaining([expect.objectContaining({ code, path: 'rules.0', line: 8, column: 4 })]),
      })
    }
  })

  it.each([
    ['duplicate keys', yaml + 'rules: [MATCH,Proxy]\n'],
    ['multiple documents', yaml + '---\nother: true\n'],
    ['unknown tag', yaml.replace('name: Proxy', 'name: !unsupported Proxy')],
    ['recursive alias', yaml.replace('proxies: ["$SUBPANEL_NODES", DIRECT]', 'proxies: &members ["$SUBPANEL_NODES", *members]')],
  ])('rejects %s', (_, input) => expect(() => validateTemplate(input)).toThrow())

  it('assigns deterministic, collision-free provider paths and checks mrs and no-resolve', () => {
    const providers = `rule-providers:
  domain:
    type: http
    behavior: domain
    format: mrs
    url: https://example.test/domain.mrs
    path: ../../same
  ip:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://example.test/ip.mrs
    path: ../../same
`
    const input = yaml.replace('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', 'RULE-SET,ip,DIRECT,no-resolve') + providers
    expect(validateTemplate(input).normalized['rule-providers']).toMatchObject({
      domain: { path: './rulesets/subpanel-646f6d61696e.mrs', interval: 86400 },
      ip: { path: './rulesets/subpanel-6970.mrs', interval: 86400 },
    })
    const longName = '规则'.repeat(50)
    const longPath = validateTemplate(input.replace('  domain:', `  ${longName}:`)).normalized['rule-providers']?.[longName].path
    expect(longPath?.split('/').every(segment => segment.length < 255)).toBe(true)
    expect(() => validateTemplate(input.replace('RULE-SET,ip,', 'RULE-SET,domain,'))).toThrow(/no-resolve/u)
    expect(() => validateTemplate(input.replace('behavior: domain', 'behavior: classical'))).toThrow(/mrs/u)
    expect(() => validateTemplate(input.replace('https://example.test/domain.mrs', 'invalid-uri')))
      .toThrow(expect.objectContaining({ diagnostics: expect.arrayContaining([expect.objectContaining({ path: 'rule-providers.domain.url' })]) }))
  })

  it('assigns names by stable ID after compatibility filtering and preserves operator ordering', () => {
    const alpha = { ...node('Proxy'), id: 'nod_1', server: 'a.example' }
    const beta = { ...node('Proxy'), id: 'nod_2', server: 'b.example' }
    const skipped = { ...node('Proxy'), id: 'nod_0', extensions: { shadowtls: {} } }
    const template = validateTemplate(yaml.replace('"$SUBPANEL_NODES", DIRECT', '"$SUBPANEL_NODES", DIRECT, DIRECT')).template
    const forward = renderClient('mihomo', [skipped, beta, alpha], template)
    expect(renderClient('mihomo', [skipped, beta, alpha], template).body).toBe(forward.body)
    const output = parse(forward.body)
    expect(output.proxies).toEqual([
      expect.objectContaining({ name: 'Proxy (3)', server: 'b.example' }),
      expect.objectContaining({ name: 'Proxy (2)', server: 'a.example' }),
    ])
    expect(output['proxy-groups'][0].proxies).toEqual(['Proxy (3)', 'Proxy (2)', 'DIRECT'])
    expect(parse(renderClient('mihomo', [alpha, beta], template).body).proxies).toEqual([...output.proxies].reverse())
  })
})
