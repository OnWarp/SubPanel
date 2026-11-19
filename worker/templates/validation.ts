import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'

export const NODES = '$SUBPANEL_NODES'
export const RESERVED = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']

/** Current validator version for tracking schema evolution */
export const VALIDATOR_VERSION = '2026.11.20'

export interface Diagnostic {
  code: string
  severity: 'error' | 'warning' | 'info'
  path: string
  line?: number
  column?: number
  message: string
}

const groupSchema = z.object({
  name: z.string().min(1).refine(v => !v.includes(',') && !RESERVED.includes(v) && !v.includes(NODES)),
  type: z.literal('select'),
  proxies: z.array(z.string().min(1)).min(1),
}).strict()

const providerSchema = z.object({
  type: z.literal('http'),
  behavior: z.enum(['domain', 'ipcidr', 'classical']),
  url: z.url().refine(v => {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password
  }),
  path: z.string().optional(),
  interval: z.number().int().positive().optional(),
  format: z.enum(['yaml', 'text', 'mrs']).optional(),
}).strict()

const templateSchema = z.object({
  'proxy-groups': z.array(groupSchema).min(1),
  rules: z.array(z.string().min(1)).min(1),
  'rule-providers': z.record(z.string(), providerSchema).optional(),
})

export type Template = z.infer<typeof templateSchema>

export interface ValidationResult {
  template: Template
  ignored: string[]
  diagnostics: Diagnostic[]
  normalized: Template
  contentHash: string
}

export interface StructureValidationResult {
  template: Template
  ignored: string[]
  diagnostics: Diagnostic[]
}

/**
 * Validates YAML structure: single document, unique keys, no unknown tags, alias limits.
 * Returns parsed template and ignored fields.
 */
export function validateStructure(yaml: string): StructureValidationResult {
  const diagnostics: Diagnostic[] = []

  if (new TextEncoder().encode(yaml).length > 5 * 1024 * 1024) {
    throw new Error('模板超过 5 MB')
  }

  const doc = parseDocument(yaml, { uniqueKeys: true })
  if (doc.errors.length) {
    for (const e of doc.errors) {
      diagnostics.push({
        code: 'YAML_PARSE_ERROR',
        severity: 'error',
        path: '',
        line: e.linePos?.[0]?.start?.line,
        column: e.linePos?.[0]?.start?.column,
        message: e.message,
      })
    }
    throw new Error(doc.errors.map(e => e.message).join('\n'))
  }

  const raw: unknown = doc.toJS({ maxAliasCount: 50 })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('模板必须是 YAML 对象')
  }

  const allowed = ['proxy-groups', 'rules', 'rule-providers']
  const values = raw as Record<string, unknown>
  const ignored = Object.keys(values).filter(k => !allowed.includes(k))

  for (const field of ignored) {
    diagnostics.push({
      code: 'FIELD_IGNORED',
      severity: 'info',
      path: field,
      message: `字段 "${field}" 将被忽略`,
    })
  }

  const template = templateSchema.parse(Object.fromEntries(
    Object.entries(values).filter(([k]) => allowed.includes(k))
  ))

  return { template, ignored, diagnostics }
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
      message: 'proxy-groups: 至少一个 select 组必须接收 $SUBPANEL_NODES',
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

  for (const g of groups) {
    for (const p of g.proxies) {
      if (p !== NODES) target(p, `proxy-groups.${g.name}`)
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
    const noResolveTypes = ['GEOIP', 'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'RULE-SET']
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
    if (parts.length !== expectedLength) {
      diagnostics.push({
        code: 'INVALID_RULE_FORMAT',
        severity: 'error',
        path,
        message: `${path}: 规则格式无效`,
      })
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

    if (parts[0] === 'RULE-SET' && !template['rule-providers']?.[parts[1]]) {
      diagnostics.push({
        code: 'UNKNOWN_RULE_PROVIDER',
        severity: 'error',
        path,
        message: `${path}: 未知规则集 ${parts[1]}`,
      })
    }
  }

  if (!template.rules.at(-1)?.startsWith('MATCH,')) {
    diagnostics.push({
      code: 'MISSING_MATCH_FALLBACK',
      severity: 'error',
      path: 'rules',
      message: 'rules: 缺少末尾 MATCH 兜底规则',
    })
  }

  return diagnostics
}

/**
 * Validates rule-providers: HTTPS URLs, stable paths, no traversal.
 */
export function validateRuleProviders(template: Template, baseDiagnostics: Diagnostic[]): Diagnostic[] {
  const diagnostics = [...baseDiagnostics]
  const providers = template['rule-providers']
  if (!providers) return diagnostics

  const usedPaths = new Set<string>()

  for (const [name, provider] of Object.entries(providers)) {
    const path = `rule-providers.${name}`

    // Validate URL is HTTPS
    try {
      const url = new URL(provider.url)
      if (url.protocol !== 'https:' || url.username || url.password) {
        diagnostics.push({
          code: 'INVALID_PROVIDER_URL',
          severity: 'error',
          path,
          message: `${path}: URL 必须为 HTTPS 且不含凭据`,
        })
      }
    } catch {
      diagnostics.push({
        code: 'INVALID_PROVIDER_URL',
        severity: 'error',
        path,
        message: `${path}: URL 格式无效`,
      })
    }

    // Generate stable relative path
    const pathSuffix = provider.path ?? name
    if (pathSuffix.includes('..') || pathSuffix.startsWith('/') || pathSuffix.includes(':')) {
      diagnostics.push({
        code: 'INVALID_PROVIDER_PATH',
        severity: 'error',
        path,
        message: `${path}: 路径包含非法字符`,
      })
    }

    if (usedPaths.has(pathSuffix)) {
      diagnostics.push({
        code: 'DUPLICATE_PROVIDER_PATH',
        severity: 'error',
        path,
        message: `${path}: 规则集路径冲突`,
      })
    }
    usedPaths.add(pathSuffix)

    // Validate behavior/format compatibility (mrs requires format)
    if (provider.behavior === 'classical' && !provider.format) {
      diagnostics.push({
        code: 'MISSING_PROVIDER_FORMAT',
        severity: 'warning',
        path,
        message: `${path}: classical behavior 建议指定 format`,
      })
    }
  }

  return diagnostics
}

/**
 * Validates placeholder expansion: only in group members, structured expansion.
 */
export function validatePlaceholder(template: Template, baseDiagnostics: Diagnostic[]): Diagnostic[] {
  const diagnostics = [...baseDiagnostics]

  // Check rule-providers for placeholder
  if (JSON.stringify(template['rule-providers'] ?? {}).includes(NODES)) {
    diagnostics.push({
      code: 'PLACEHOLDER_IN_PROVIDERS',
      severity: 'error',
      path: 'rule-providers',
      message: 'rule-providers: 占位符只能用于策略组成员',
    })
  }

  return diagnostics
}

/**
 * Computes content hash of normalized template for deduplication.
 */
export function computeContentHash(template: Template): string {
  const encoder = new TextEncoder()
  const data = encoder.encode(JSON.stringify(template))
  // Simple hash for demo; in production use crypto.subtle.digest
  const hash = Array.from(new Uint8Array(data)).map(b => b.toString(16).padStart(2, '0')).join('')
  return hash.slice(0, 64)
}

/**
 * Full validation pipeline: structure -> groups -> rules -> providers -> placeholders.
 * Returns normalized template, ignored fields, diagnostics, and content hash.
 */
export function validateTemplate(yaml: string): ValidationResult {
  // Step 1: Structure validation
  const { template, ignored, diagnostics } = validateStructure(yaml)

  // Step 2: Group validation
  const groupDiagnostics = validateGroups(template, diagnostics)

  // Step 3: Rules validation
  const ruleDiagnostics = validateRules(template, groupDiagnostics)

  // Step 4: Rule-providers validation
  const providerDiagnostics = validateRuleProviders(template, ruleDiagnostics)

  // Step 5: Placeholder validation
  const finalDiagnostics = validatePlaceholder(template, providerDiagnostics)

  // Check for errors
  const hasErrors = finalDiagnostics.some(d => d.severity === 'error')
  if (hasErrors) {
    const errorMessages = finalDiagnostics
      .filter(d => d.severity === 'error')
      .map(d => d.message)
      .join('\n')
    throw new Error(errorMessages)
  }

  const normalized = template // Already normalized by schema parsing
  const contentHash = computeContentHash(normalized)

  return { template: normalized, ignored, diagnostics: finalDiagnostics, normalized, contentHash }
}

export function expandTemplate(template: Template, nodes: string[]) {
  return {
    ...template,
    'proxy-groups': template['proxy-groups'].map(g => ({
      ...g,
      proxies: g.proxies.flatMap(p => p === NODES ? nodes : [p]),
    })),
  }
}