import { LineCounter, isNode, parseDocument } from 'yaml'
import { sha256Base64Url } from '../platform/hash.js'
import { z } from 'zod'
import { mihomoClientLayer, nodeLayer } from './layers.js'

export const NODES = '$SUBPANEL_NODES'
export const RESERVED = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']

/** Current validator version for tracking schema evolution */
export const VALIDATOR_VERSION = '3'
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024
const MAX_GROUPS = 100
const MAX_PROVIDERS = 100
const MAX_RULES = 20_000

export interface Diagnostic {
  code: string
  severity: 'error' | 'warning' | 'info'
  path: string
  line?: number
  column?: number
  message: string
}

const groupSchema = z.object({
  name: z.string().min(1).refine(v => v.trim() === v && !/[,\p{Cc}]/u.test(v) && !RESERVED.includes(v) && !v.includes(NODES)),
  type: z.enum(['select', 'url-test', 'fallback', 'load-balance']),
  url: z.string().max(2048).refine(isHttpsTemplateUrl).optional(),
  interval: z.number().int().min(30).max(86400).optional(),
  lazy: z.boolean().optional(),
  tolerance: z.number().int().min(0).max(10000).optional(),
  strategy: z.enum(['consistent-hashing', 'round-robin']).optional(),
  proxies: z.array(z.string().min(1)).min(1),
}).strict().superRefine((group, context) => {
  const invalid = (path: string) => context.addIssue({ code: 'custom', path: [path], message: '字段与策略组类型不兼容' })
  if (group.type === 'select') {
    for (const key of ['url', 'interval', 'lazy'] as const) if (group[key] !== undefined) invalid(key)
  }
  if (group.type !== 'url-test' && group.tolerance !== undefined) invalid('tolerance')
  if (group.type !== 'load-balance' && group.strategy !== undefined) invalid('strategy')
})

export function isHttpsTemplateUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password
}

const providerSchema = z.object({
  type: z.literal('http'),
  behavior: z.enum(['domain', 'ipcidr', 'classical']),
  url: z.string().max(4096).refine(isHttpsTemplateUrl),
  path: z.string().optional(),
  interval: z.number().int().positive().optional(),
  format: z.enum(['yaml', 'text', 'mrs']).optional(),
}).strict()

const templateSchema = z.object({
  subpanel: z.object({ ruleLibrary: z.array(z.object({
    type: z.enum(['system', 'local']), name: z.string().min(1).max(80),
    revision: z.number().int().positive(), rules: z.array(z.string().min(1).max(1200)).min(1).max(100),
  }).strict()).max(20).optional(), nodes: nodeLayer.optional(), client: mihomoClientLayer.optional(), singbox: z.object({
    fakeIp: z.boolean().optional(), sniff: z.boolean().optional(), autoDetectInterface: z.boolean().optional(),
    dnsRules: z.array(z.object({
      domainSuffix: z.string().refine(value => validRuleValue('DOMAIN-SUFFIX', value)),
      resolver: z.enum(['local', 'remote']),
    }).strict()).max(100).optional(),
    localRuleSets: z.array(z.object({
      name: z.string().min(1).max(80), outbound: z.string().min(1).max(128),
    }).strict()).max(10).optional(),
    remoteRuleSets: z.array(z.object({
      name: z.string().min(1).max(80), outbound: z.string().min(1).max(128),
      url: z.string().max(2048).refine(isHttpsTemplateUrl),
    }).strict()).max(10).optional(),
  }).strict().optional() }).strict().optional(),
  'proxy-groups': z.array(groupSchema).min(1).max(MAX_GROUPS),
  rules: z.array(z.string().min(1)).min(1).max(MAX_RULES),
  'rule-providers': z.record(z.string().regex(/^[^,\s\p{Cc}]{1,100}$/u), providerSchema)
    .refine(providers => Object.keys(providers).length <= MAX_PROVIDERS).optional(),
})

export type Template = z.infer<typeof templateSchema>

export interface ValidationResult {
  template: Template
  ignored: string[]
  diagnostics: Diagnostic[]
  normalized: Template
}

export class TemplateValidationError extends Error {
  readonly diagnostics: Diagnostic[]

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.filter(item => item.severity === 'error').map(item => item.message).join('\n'))
    this.diagnostics = diagnostics
  }
}

function invalid(code: string, message: string): never {
  throw new TemplateValidationError([{ code, message, severity: 'error', path: '' }])
}

function validateStructure(yaml: string, legacy: boolean) {
  if (new TextEncoder().encode(yaml).length > MAX_TEMPLATE_BYTES) {
    invalid('YAML_TOO_LARGE', '模板超过 5 MiB')
  }
  const lineCounter = new LineCounter()
  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(yaml, { uniqueKeys: true, lineCounter })
  } catch {
    invalid('YAML_PARSE_ERROR', '无法解析 YAML，请检查文档结构和嵌套深度')
  }
  const problems = [...doc.errors, ...doc.warnings]
  if (problems.length) {
    throw new TemplateValidationError(problems.map(error => ({
      code: error.code, severity: 'error', path: '',
      line: error.linePos?.[0]?.line, column: error.linePos?.[0]?.col,
      message: error.message.split(' at line ')[0],
    })))
  }
  let raw: unknown
  try {
    raw = doc.toJS({ maxAliasCount: 50, mapAsMap: true })
  } catch {
    invalid('YAML_ALIAS_LIMIT', 'YAML 别名展开超过限制')
  }
  if (!(raw instanceof Map) || [...raw.keys()].some(key => typeof key !== 'string')) {
    invalid('YAML_OBJECT_REQUIRED', '模板必须是字符串键的 YAML 对象')
  }
  const active = new WeakSet<object>()
  function toObject(value: unknown, depth = 0): unknown {
    if (!Array.isArray(value) && !(value instanceof Map)) return value
    if (depth > 32) invalid('YAML_NESTING_LIMIT', '模板结构嵌套过深')
    if (active.has(value)) invalid('YAML_CYCLIC_ALIAS', 'YAML 别名不能形成循环')
    active.add(value)
    let converted: unknown
    if (Array.isArray(value)) {
      converted = value.map(item => toObject(item, depth + 1))
    } else {
      if ([...value.keys()].some(key => typeof key !== 'string')) invalid('YAML_STRING_KEYS_REQUIRED', 'YAML 对象键必须是字符串')
      converted = Object.fromEntries([...value].map(([key, item]) => [key, toObject(item, depth + 1)]))
    }
    active.delete(value)
    return converted
  }
  const allowed = ['proxy-groups', 'rules', 'rule-providers']
  if (!legacy) allowed.push('subpanel')
  const ignored = [...raw.keys()].filter(key => !allowed.includes(key)) as string[]
  const diagnostics: Diagnostic[] = ignored.map(field => ({
    code: 'FIELD_IGNORED', severity: 'info', path: field, message: `字段 "${field}" 将被忽略`,
  }))
  function locate(diagnostic: Diagnostic, path: (string | number)[]) {
    const node = doc.getIn(path, true)
    if (!isNode(node) || !node.range) return diagnostic
    const { line, col } = lineCounter.linePos(node.range[0])
    return { ...diagnostic, line, column: col }
  }
  const result = templateSchema.safeParse(Object.fromEntries(
    [...raw].filter(([key]) => allowed.includes(key)).map(([key, item]) => [key, toObject(item)])
  ))
  if (!result.success) {
    throw new TemplateValidationError(result.error.issues.map(issue => {
      const path = issue.path.map(key => typeof key === 'number' ? key : String(key))
      return locate({ code: 'INVALID_STRUCTURE', severity: 'error', path: path.join('.'), message: issue.message }, path)
    }))
  }
  return { template: result.data, ignored, diagnostics, locate }
}

/**
 * Validates proxy-groups: unique names, at least one group receives $SUBPANEL_NODES,
 * no cycles, all referenced targets exist.
 */
export function validateGroups(template: Template, baseDiagnostics: Diagnostic[]): Diagnostic[] {
  const diagnostics = [...baseDiagnostics]
  const groups = template['proxy-groups']
  const names = new Set(groups.map(g => g.name))

  if (names.size !== groups.length) {
    diagnostics.push({
      code: 'DUPLICATE_GROUP_NAME',
      severity: 'error',
      path: 'proxy-groups',
      message: 'proxy-groups: 策略组名称重复',
    })
  }

  if (!groups.some(g => g.proxies.includes(NODES))) {
    diagnostics.push({
      code: 'MISSING_NODES_PLACEHOLDER',
      severity: 'error',
      path: 'proxy-groups',
      message: 'proxy-groups: 至少一个策略组必须接收 $SUBPANEL_NODES',
    })
  }

  const target = (name: string, path: string) => {
    if (!names.has(name) && !RESERVED.includes(name)) {
      diagnostics.push({
        code: 'UNKNOWN_TARGET',
        severity: 'error',
        path,
        message: `${path}: 未知目标 ${name}`,
      })
    }
  }

  for (const [groupIndex, g] of groups.entries()) {
    for (const [index, p] of g.proxies.entries()) {
      if (p !== NODES) target(p, `proxy-groups.${groupIndex}.proxies.${index}`)
    }
  }

  const visited = new Set<string>()
  const active = new Set<string>()
  const visit = (name: string) => {
    if (active.has(name)) {
      diagnostics.push({
        code: 'CYCLE_REFERENCE',
        severity: 'error',
        path: `proxy-groups.${name}`,
        message: `proxy-groups.${name}: 循环引用`,
      })
      return
    }
    if (visited.has(name)) return
    active.add(name)
    const group = groups.find(g => g.name === name)
    if (group) {
      for (const p of group.proxies) {
        if (names.has(p)) visit(p)
      }
    }
    active.delete(name)
    visited.add(name)
  }

  for (const g of groups) visit(g.name)

  return diagnostics
}

/**
 * Validates rules: supported types, field counts, MATCH at end, targets exist,
 * RULE-SET providers exist, no-resolve compatibility.
 */
export function validateRules(template: Template, baseDiagnostics: Diagnostic[]): Diagnostic[] {
  const diagnostics = [...baseDiagnostics]
  const groups = template['proxy-groups']
  const groupNames = new Set(groups.map(g => g.name))
  const target = (name: string, path: string) => {
    if (!groupNames.has(name) && !RESERVED.includes(name)) {
      diagnostics.push({
        code: 'UNKNOWN_RULE_TARGET',
        severity: 'error',
        path,
        message: `${path}: 未知目标 ${name}`,
      })
    }
  }

  const supported = [
    'MATCH', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
    'GEOSITE', 'GEOIP', 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN',
    'SRC-IP-CIDR', 'SRC-PORT', 'DST-PORT', 'PROCESS-NAME', 'PROCESS-PATH',
    'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX', 'NETWORK', 'IN-TYPE',
    'IN-USER', 'IN-NAME', 'UID', 'DSCP', 'RULE-SET',
  ]

  for (const [i, rule] of template.rules.entries()) {
    const parts = rule.split(',').map(p => p.trim())
    const path = `rules.${i}`

    if (parts.some(p => p.includes(NODES))) {
      diagnostics.push({
        code: 'PLACEHOLDER_IN_RULES',
        severity: 'error',
        path,
        message: `${path}: 占位符只能用于策略组成员`,
      })
    }

    if (!supported.includes(parts[0])) {
      diagnostics.push({
        code: 'UNSUPPORTED_RULE_TYPE',
        severity: 'error',
        path,
        message: `${path}: 不支持的规则类型 ${parts[0]}`,
      })
      continue
    }

    const hasNoResolve = parts.at(-1) === 'no-resolve'
    const noResolveTypes = ['GEOIP', 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'RULE-SET']
    if (hasNoResolve && !noResolveTypes.includes(parts[0])) {
      diagnostics.push({
        code: 'NO_RESOLVE_INCOMPATIBLE',
        severity: 'error',
        path,
        message: `${path}: no-resolve 不适用于此规则`,
      })
    }

    const final = parts[0] === 'MATCH'
    const expectedLength = final ? 2 : (hasNoResolve ? 4 : 3)
    if (parts.length !== expectedLength || parts.some(part => !part)) {
      diagnostics.push({
        code: parts[0].endsWith('-REGEX') ? 'UNSUPPORTED_REGEX_SYNTAX' : 'INVALID_RULE_FORMAT',
        severity: 'error',
        path,
        message: parts[0].endsWith('-REGEX') ? `${path}: 暂不支持含逗号的正则表达式` : `${path}: 规则格式无效`,
      })
      continue
    }

    if (final && i !== template.rules.length - 1) {
      diagnostics.push({
        code: 'MATCH_NOT_LAST',
        severity: 'error',
        path,
        message: `${path}: MATCH 必须位于末尾`,
      })
    }

    const targetIndex = parts.length - (hasNoResolve ? 2 : 1)
    if (parts[targetIndex]) target(parts[targetIndex], path)

    if (!final && !validRuleValue(parts[0], parts[1])) {
      diagnostics.push({ code: 'INVALID_RULE_VALUE', severity: 'error', path, message: `${path}: 规则参数无效` })
    }
    if (parts[0] === 'RULE-SET') {
      const providers = template['rule-providers']
      const provider = providers && Object.hasOwn(providers, parts[1]) ? providers[parts[1]] : undefined
      if (!provider) {
        diagnostics.push({ code: 'UNKNOWN_RULE_PROVIDER', severity: 'error', path, message: `${path}: 未知规则集 ${parts[1]}` })
      } else if (hasNoResolve && provider.behavior === 'domain') {
        diagnostics.push({ code: 'NO_RESOLVE_INCOMPATIBLE', severity: 'error', path, message: `${path}: 域名规则集不支持 no-resolve` })
      }
    }
  }

  if (template.rules.at(-1)?.split(',')[0].trim() !== 'MATCH') {
    diagnostics.push({
      code: 'MISSING_MATCH_FALLBACK',
      severity: 'error',
      path: 'rules',
      message: 'rules: 缺少末尾 MATCH 兜底规则',
    })
  }

  return diagnostics
}

function validCidr(value: string) {
  const [address, prefix, extra] = value.split('/')
  if (extra !== undefined || !/^\d{1,3}$/u.test(prefix ?? '')) return false
  if (address.includes(':')) {
    if (!/^[\da-f:.]+$/iu.test(address) || Number(prefix) > 128) return false
    return URL.canParse(`https://[${address}]/`)
  }
  if (Number(prefix) > 32) return false
  const octets = address.split('.')
  return octets.length === 4 && octets.every(octet => /^(0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255)
}

function validRanges(value: string, min: number, max: number) {
  const enclosed = value.startsWith('[') && value.endsWith(']')
  return (enclosed ? value.slice(1, -1) : value).split('/').every(item => {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(item)
    if (!match) return false
    const low = Number(match[1])
    const high = Number(match[2] ?? match[1])
    return low >= min && high <= max && low <= high
  })
}

export function validRuleValue(type: string, value: string) {
  if (type.endsWith('-REGEX')) {
    // Support the simple expression syntax common to JavaScript and Mihomo,
    // including the leading inline flags shown in the Mihomo examples.
    const inline = /^\(\?([ims]+)\)/u.exec(value)
    try {
      new RegExp(inline ? value.slice(inline[0].length) : value, inline?.[1])
      return true
    } catch {
      return false
    }
  }
  switch (type) {
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX':
      return value.length <= 253 && value.replace(/\.$/u, '').split('.')
        .every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/iu.test(label))
    case 'DOMAIN-KEYWORD':
      return !/\s/u.test(value)
    case 'IP-CIDR':
    case 'IP-CIDR6':
    case 'SRC-IP-CIDR':
    case 'IP-SUFFIX':
      return validCidr(value)
    case 'SRC-PORT':
    case 'DST-PORT':
      return validRanges(value, 1, 65_535)
    case 'DSCP':
      return /^\d{1,2}$/u.test(value) && Number(value) <= 63
    case 'UID':
      return validRanges(value, 0, 4_294_967_295)
    case 'IP-ASN':
      return /^\d+$/u.test(value) && Number(value) > 0 && Number(value) <= 4_294_967_295
    case 'NETWORK':
      return /^(tcp|udp)$/iu.test(value)
    case 'GEOIP':
    case 'GEOSITE':
      return /^[a-z0-9_@.-]+$/iu.test(value)
    default:
      return !/\p{Cc}/u.test(value)
  }
}

function normalizeRuleProviders(template: Template, diagnostics: Diagnostic[]): Template {
  if (!template['rule-providers']) return template
  const providers = Object.fromEntries(Object.entries(template['rule-providers']).map(([name, provider]) => {
    const path = `rule-providers.${name}`
    const format = provider.format ?? 'yaml'
    if (format === 'mrs' && provider.behavior === 'classical') {
      diagnostics.push({ code: 'INCOMPATIBLE_PROVIDER_FORMAT', severity: 'error', path, message: `${path}: mrs 仅支持 domain 和 ipcidr` })
    }
    if (name.includes(NODES) || provider.url.includes(NODES) || provider.path?.includes(NODES)) {
      diagnostics.push({ code: 'PLACEHOLDER_IN_PROVIDERS', severity: 'error', path, message: `${path}: 占位符只能用于策略组成员` })
    }
    const hex = Array.from(new TextEncoder().encode(name), byte => byte.toString(16).padStart(2, '0')).join('')
    const key = hex.match(/.{1,160}/gu)!.join('/')
    return [name, { ...provider, format, interval: provider.interval ?? 86400, path: `./rulesets/subpanel-${key}.${format}` }]
  }))
  return { ...template, 'rule-providers': providers }
}

export function validateTemplate(yaml: string, legacy = false): ValidationResult {
  const { template, ignored, diagnostics, locate } = validateStructure(yaml, legacy)
  const rules = validateRules(template, validateGroups(template, diagnostics))
  const normalized = normalizeRuleProviders({ ...template, rules: template.rules.map(rule => rule.split(',').map(part => part.trim()).join(',')) }, rules)
  const providerPrefix = 'rule-providers.'
  const located = rules.map(item => {
    const path = item.path.startsWith(providerPrefix)
      ? ['rule-providers', item.path.slice(providerPrefix.length)]
      : item.path.split('.').map(part => /^\d+$/u.test(part) ? Number(part) : part)
    return locate(item, path)
  })
  if (located.some(item => item.severity === 'error')) throw new TemplateValidationError(located)
  return { template: normalized, normalized, ignored, diagnostics: located }
}

export function computeContentHash(template: Template) {
  return sha256Base64Url(JSON.stringify(template))
}

export function expandTemplate(template: Template, nodes: string[]) {
  const { subpanel, ...policy } = template
  return {
    ...subpanel?.client,
    ...policy,
    'proxy-groups': template['proxy-groups'].map(group => ({
      ...(group.type !== 'select' && { url: 'https://www.gstatic.com/generate_204', interval: 300 }),
      ...group,
      proxies: [...new Set(group.proxies.flatMap(member => member === NODES ? nodes : [member]))],
    })),
  }
}
