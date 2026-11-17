import { parseDocument } from 'yaml'
import { z } from 'zod'

export const NODES = '$SUBPANEL_NODES'
export const RESERVED = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']
const groupSchema = z.object({ name: z.string().min(1).refine(v => !v.includes(',') && !RESERVED.includes(v) && !v.includes(NODES)), type: z.literal('select'), proxies: z.array(z.string().min(1)).min(1) }).strict()
const providerSchema = z.object({ type: z.literal('http'), behavior: z.enum(['domain','ipcidr','classical']), url: z.url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password }), path: z.string().optional(), interval: z.number().int().positive().optional(), format: z.enum(['yaml','text','mrs']).optional() }).strict()
const templateSchema = z.object({ 'proxy-groups': z.array(groupSchema).min(1), rules: z.array(z.string().min(1)).min(1), 'rule-providers': z.record(z.string(),providerSchema).optional() })
export type Template = z.infer<typeof templateSchema>
export function validateTemplate(yaml: string): { template: Template; ignored: string[] } {
 if (new TextEncoder().encode(yaml).length > 5 * 1024 * 1024) throw new Error('模板超过 5 MB')
 const doc = parseDocument(yaml, { uniqueKeys: true })
 if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('\n'))
 const raw: unknown = doc.toJS({ maxAliasCount: 50 })
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模板必须是 YAML 对象')
 const allowed = ['proxy-groups','rules','rule-providers']
 const values = raw as Record<string,unknown>
 const ignored = Object.keys(values).filter(k => !allowed.includes(k))
 const template = templateSchema.parse(Object.fromEntries(Object.entries(values).filter(([k]) => allowed.includes(k))))
 const groups = template['proxy-groups']
 const names = new Set(groups.map(g => g.name))
 if (names.size !== groups.length) throw new Error('proxy-groups: 策略组名称重复')
 if (!groups.some(g => g.proxies.includes(NODES))) throw new Error('proxy-groups: 至少一个 select 组必须接收 $SUBPANEL_NODES')
 const target = (name: string, path: string) => { if (!names.has(name) && !RESERVED.includes(name)) throw new Error(`${path}: 未知目标 ${name}`) }
 for (const g of groups) for (const p of g.proxies) if (p !== NODES) target(p,`proxy-groups.${g.name}`)
 const visited = new Set<string>(), active = new Set<string>()
 const visit = (name: string) => {
  if (active.has(name)) throw new Error(`proxy-groups.${name}: 循环引用`)
  if (visited.has(name)) return
  active.add(name)
  for (const p of groups.find(g => g.name === name)!.proxies) if (names.has(p)) visit(p)
  active.delete(name); visited.add(name)
 }
 for (const g of groups) visit(g.name)
 for (const [i, rule] of template.rules.entries()) {
  const parts = rule.split(',').map(p => p.trim())
  if (parts.some(p => p.includes(NODES))) throw new Error(`rules.${i}: 占位符只能用于策略组成员`)
  const supported = ['MATCH','DOMAIN','DOMAIN-SUFFIX','DOMAIN-KEYWORD','DOMAIN-REGEX','GEOSITE','GEOIP','IP-CIDR','IP-CIDR6','IP-SUFFIX','IP-ASN','SRC-IP-CIDR','SRC-PORT','DST-PORT','PROCESS-NAME','PROCESS-PATH','PROCESS-NAME-REGEX','PROCESS-PATH-REGEX','NETWORK','IN-TYPE','IN-USER','IN-NAME','UID','DSCP','RULE-SET']
  if (!supported.includes(parts[0])) throw new Error(`rules.${i}: 不支持的规则类型 ${parts[0]}`)
  if (parts.at(-1) === 'no-resolve' && !['GEOIP','IP-CIDR','IP-CIDR6','IP-ASN','RULE-SET'].includes(parts[0])) throw new Error(`rules.${i}: no-resolve 不适用于此规则`)
  const final = parts[0] === 'MATCH'
  if (final ? parts.length !== 2 : parts.length !== (parts.at(-1) === 'no-resolve' ? 4 : 3)) throw new Error(`rules.${i}: 规则格式无效`)
  if (final && i !== template.rules.length - 1) throw new Error(`rules.${i}: MATCH 必须位于末尾`)
  target(parts[parts.length - (parts.at(-1) === 'no-resolve' ? 2 : 1)],`rules.${i}`)
  if (parts[0] === 'RULE-SET' && !template['rule-providers']?.[parts[1]]) throw new Error(`rules.${i}: 未知规则集 ${parts[1]}`)
 }
 if (!template.rules.at(-1)!.startsWith('MATCH,')) throw new Error('rules: 缺少末尾 MATCH 兜底规则')
 if (JSON.stringify(template['rule-providers'] ?? {}).includes(NODES)) throw new Error('rule-providers: 占位符只能用于策略组成员')
 return { template, ignored }
}
export function expandTemplate(template: Template, nodes: string[]) {
 return { ...template, 'proxy-groups': template['proxy-groups'].map(g => ({ ...g, proxies: g.proxies.flatMap(p => p === NODES ? nodes : [p]) })) }
}
