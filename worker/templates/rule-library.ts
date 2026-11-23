import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { fetchRemoteTextWithPolicy as fetchRemoteTextWithMetadata } from '../catalog/egress-policy.js'
import { RemoteFetchError, validateRemoteUrl } from '../catalog/remote.js'
import { sha256Base64Url } from '../platform/hash.js'
import { apiError } from '../platform/api-error.js'
import { validRuleValue, type Template } from './validation.js'
import { z } from 'zod'

const TRUSTED_ORIGINS = new Set(['https://raw.githubusercontent.com', 'https://cdn.jsdelivr.net'])
const MAX_BYTES = 256 * 1024
const MAX_RULES = 10_000

export const ruleSource = z.object({
  url: z.string().max(2048),
  behavior: z.enum(['domain', 'ipcidr', 'classical']),
  format: z.enum(['yaml', 'text']),
})

type Source = z.infer<typeof ruleSource>
type RuleSourceRow = {
  url: string
  behavior: Source['behavior']
  format: Source['format']
  version: string | null
  last_success_at: string | null
  etag: string | null
  last_modified: string | null
  error_code: string | null
}

export function ruleSourceUrl(value: string) {
  const url = validateRemoteUrl(value)
  if (!TRUSTED_ORIGINS.has(url.origin) || url.hash || url.search) {
    throw new RemoteFetchError('REMOTE_TARGET_BLOCKED')
  }
  return url
}

function validEntry(rule: string, behavior: Source['behavior']) {
  if (behavior === 'domain') return validRuleValue('DOMAIN-SUFFIX', rule.replace(/^(?:[+*]\.)/u, ''))
  if (behavior === 'ipcidr') return validRuleValue('IP-CIDR', rule)
  // Classical provider entries omit the outbound policy.
  const [type, value, option, ...extra] = rule.split(',').map(part => part.trim())
  return /^[A-Z][A-Z0-9-]*$/u.test(type) && type !== 'MATCH' && type !== 'RULE-SET' && Boolean(value)
    && validRuleValue(type, value) && !extra.length && (!option || option === 'no-resolve')
}

function isNativeRuleSource(source: Pick<Source, 'url' | 'behavior' | 'format'>) {
  return source.behavior === 'classical' && source.format === 'text'
    && /^https:\/\/raw\.githubusercontent\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/[a-f0-9]{40}\/[a-z0-9_./-]+\.json$/iu.test(source.url)
}

function validateNativeRulePayload(text: string) {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new RemoteFetchError('REMOTE_BODY_INVALID') }
  const fields: Record<string, string> = {
    domain: 'DOMAIN', domain_suffix: 'DOMAIN-SUFFIX', domain_keyword: 'DOMAIN-KEYWORD',
    ip_cidr: 'IP-CIDR', source_ip_cidr: 'SRC-IP-CIDR',
  }
  const shape = z.strictObject({ version: z.number().int().min(1).max(4),
    rules: z.array(z.partialRecord(z.enum(['domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'source_ip_cidr']),
      z.array(z.string().min(1).max(1024)).min(1).max(MAX_RULES))).min(1).max(MAX_RULES),
  }).safeParse(value)
  let count = 0
  if (!shape.success || shape.data.rules.some(rule => {
    const entries = Object.entries(rule)
    return !entries.length || entries.some(([key, values]) => {
      count += values.length
      return count > MAX_RULES || values.some(value => !validRuleValue(fields[key], value))
    })
  })) throw new RemoteFetchError('REMOTE_BODY_INVALID')
}

export function validateRulePayload(text: string, { format, behavior }: Pick<Source, 'format' | 'behavior'>) {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new RemoteFetchError('REMOTE_BODY_TOO_LARGE')
  let rules: unknown[]
  if (format === 'yaml') {
    let doc
    try { doc = parseDocument(text, { uniqueKeys: true }) } catch { throw new RemoteFetchError('REMOTE_BODY_INVALID') }
    const contents = doc.contents
    const payload = doc.get('payload', true)
    if (doc.errors.length || doc.warnings.length || !isMap(contents) || contents.items.length !== 1 || contents.anchor || !isSeq(payload) || payload.anchor
      || payload.items.some(item => isAlias(item) || !isScalar(item) || item.anchor)) {
      throw new RemoteFetchError('REMOTE_BODY_INVALID')
    }
    rules = payload.items.map(item => isScalar(item) ? item.value : null)
  } else {
    rules = text.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  }
  if (!rules.length || rules.length > MAX_RULES || rules.some(rule => typeof rule !== 'string' || !rule.trim() || rule.length > 1024 || /\p{Cc}/u.test(rule) || !validEntry(rule.trim(), behavior))) {
    throw new RemoteFetchError('REMOTE_BODY_INVALID')
  }
}

export async function refreshRuleSource(db: D1Database, source: Source, fetcher: typeof fetch = fetch) {
  let url: string
  try { url = ruleSourceUrl(source.url).href }
  catch { throw apiError(422, 'RULE_SOURCE_BLOCKED', '规则源须使用白名单 HTTPS 地址，且不能包含查询参数或片段') }
  const key = [url, source.behavior, source.format]
  const attempt = crypto.randomUUID()
  const row = await db.prepare(`
    INSERT INTO conversion_rule_sources(url,behavior,format,attempt_id)
    VALUES (?,?,?,?) ON CONFLICT(url,behavior,format) DO UPDATE SET attempt_id=excluded.attempt_id
    RETURNING *
  `).bind(...key, attempt).first<RuleSourceRow>()
  const headers: Record<string, string> = {}
  if (row?.etag) headers['If-None-Match'] = row.etag
  if (row?.last_modified) headers['If-Modified-Since'] = row.last_modified
  try {
    const result = await fetchRemoteTextWithMetadata({ url, headers }, fetcher, 7000, undefined, { maxBytes: MAX_BYTES, maxRedirects: 0 })
    const now = new Date().toISOString()
    if (result.notModified) {
      await db.prepare(`UPDATE conversion_rule_sources SET last_success_at=?,error_code=NULL
        WHERE url=? AND behavior=? AND format=? AND attempt_id=?`).bind(now, ...key, attempt).run()
    } else {
      if (isNativeRuleSource({ ...source, url })) validateNativeRulePayload(result.text)
      else validateRulePayload(result.text, source)
      await db.prepare(`UPDATE conversion_rule_sources SET version=?,payload=?,last_success_at=?,etag=?,last_modified=?,error_code=NULL
        WHERE url=? AND behavior=? AND format=? AND attempt_id=?`).bind(await sha256Base64Url(result.text), result.text, now,
        result.etag?.slice(0, 1024) ?? null, result.lastModified?.slice(0, 128) ?? null, ...key, attempt).run()
    }
  } catch (error) {
    if (!(error instanceof RemoteFetchError)) throw error
    await db.prepare(`UPDATE conversion_rule_sources SET error_code=? WHERE url=? AND behavior=? AND format=? AND attempt_id=?`)
      .bind(error.code, ...key, attempt).run()
    throw apiError(422, error.code, '规则源抓取或格式校验失败')
  }
}

export async function listRuleSources(db: D1Database) {
  const { results } = await db.prepare(`SELECT url,behavior,format,version,last_success_at,error_code
    FROM conversion_rule_sources ORDER BY COALESCE(last_success_at,'') DESC, url LIMIT 100`).all<RuleSourceRow>()
  return results.map(row => ({ ...row, nativeSingbox: isNativeRuleSource(row) }))
}

export async function checkRuleSources(db: D1Database, template: Template) {
  const names = Object.keys(template['rule-providers'] ?? {})
  if (!names.length) return []
  const providers = template['rule-providers']!
  const requested = names.map(name => {
    const { url, behavior, format } = providers[name]
    try {
      const normalized = ruleSourceUrl(url).href
      return { name, url: isNativeRuleSource({ url: normalized, behavior, format: format === 'text' ? 'text' : 'yaml' }) ? null : normalized, behavior, format }
    }
    catch { return { name, url: null, behavior, format } }
  })
  const records = await db.prepare(`
    SELECT json_extract(j.value,'$.name') AS name
    FROM json_each(?) j JOIN conversion_rule_sources s
      ON s.url=json_extract(j.value,'$.url') AND s.behavior=json_extract(j.value,'$.behavior')
      AND s.format=json_extract(j.value,'$.format')
    WHERE s.version IS NOT NULL AND s.error_code IS NULL AND s.last_success_at >= ?
  `).bind(JSON.stringify(requested), new Date(Date.now() - 7 * 86400_000).toISOString()).all<{ name: string }>()
  const available = new Set(records.results.map(row => row.name))
  return names.filter(name => !available.has(name)).map(name => ({
    code: 'RULE_SOURCE_UNVERIFIED', severity: 'error' as const, path: `rule-providers.${name}`,
    message: '发布前请在规则库成功抓取对应规则源（七天内，支持 YAML 和文本）',
  }))
}

export const localRuleSet = z.object({
  name: z.string().trim().min(1).max(80),
  rules: z.array(z.string().trim().min(1).max(1024).refine(rule => !/^MATCH\s*,/u.test(rule))).min(1).max(100),
})

export function saveLocalRuleSet(db: D1Database, input: z.infer<typeof localRuleSet>) {
  return db.prepare(`
    INSERT INTO conversion_local_rule_sets (name,rules_json,revision,updated_at) VALUES (?,?,1,?)
    ON CONFLICT(name) DO UPDATE SET rules_json=excluded.rules_json, revision=revision+1, updated_at=excluded.updated_at
  `).bind(input.name, JSON.stringify(input.rules), new Date().toISOString()).run()
}

export async function listLocalRuleSets(db: D1Database) {
  const { results } = await db.prepare(`
    SELECT name,rules_json,revision,updated_at FROM conversion_local_rule_sets ORDER BY name LIMIT 100
  `).all<{ name: string; rules_json: string; revision: number; updated_at: string }>()
  return results.map(({ rules_json, ...row }) => ({ ...row, rules: JSON.parse(rules_json) as string[] }))
}

const SINGBOX_MATCH_FIELDS: Record<string, string> = {
  DOMAIN: 'domain', 'DOMAIN-SUFFIX': 'domain_suffix', 'DOMAIN-KEYWORD': 'domain_keyword',
  'IP-CIDR': 'ip_cidr', 'IP-CIDR6': 'ip_cidr', 'SRC-IP-CIDR': 'source_ip_cidr',
}

export async function loadSingBoxRuleSets(db: D1Database, template: Template) {
  const names = [...new Set(template.rules.filter(rule => rule.startsWith('RULE-SET,')).map(rule => rule.split(',')[1]))]
  const locals = template.subpanel?.singbox?.localRuleSets ?? []
  const remotes = template.subpanel?.singbox?.remoteRuleSets ?? []
  if (names.length === 0 && locals.length === 0 && remotes.length === 0) return []
  const requested = names.map(name => {
    const provider = template['rule-providers']![name]
    return { ...provider, name, url: ruleSourceUrl(provider.url).href }
  })
  const { results } = await db.prepare(`
    SELECT json_extract(j.value,'$.name') AS name, s.url, s.behavior, s.format, s.payload
    FROM json_each(?) j JOIN conversion_rule_sources s
      ON s.url=json_extract(j.value,'$.url') AND s.behavior=json_extract(j.value,'$.behavior')
      AND s.format=json_extract(j.value,'$.format')
    WHERE s.version IS NOT NULL
      AND (SELECT SUM(length(CAST(p.payload AS BLOB))) FROM conversion_rule_sources p JOIN json_each(?) k
           ON p.url=json_extract(k.value,'$.url') AND p.behavior=json_extract(k.value,'$.behavior')
           AND p.format=json_extract(k.value,'$.format')) <= ?
  `).bind(JSON.stringify(requested), JSON.stringify(requested), MAX_BYTES).all<Source & { name: string; payload: string }>()
  const byName = new Map(results.map(row => [row.name, row]))
  let count = 0
  const sets: Record<string, unknown>[] = names.map(name => {
    const row = byName.get(name)
    const invalid = () => apiError(422, 'TEMPLATE_INVALID', 'sing-box 规则集校验失败', { diagnostics: [{
      code: 'SINGBOX_RULE_SET_INVALID', severity: 'error', path: `rule-providers.${name}`,
      message: '规则集未验证、包含不兼容规则或超过合并上限',
    }] })
    if (!row) throw invalid()
    ruleSourceUrl(row.url)
    validateRulePayload(row.payload, row)
    const entries: string[] = row.format === 'yaml' ? parseDocument(row.payload).toJS().payload
      : row.payload.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    count += entries.length
    if (count > MAX_RULES) throw invalid()
    const rules = entries.map(entry => {
      const [type, value] = row.behavior === 'classical' ? entry.split(',').map(part => part.trim())
        : [row.behavior === 'ipcidr' ? 'IP-CIDR' : 'DOMAIN-SUFFIX', entry.trim().replace(/^\+\./u, '')]
      const field = SINGBOX_MATCH_FIELDS[type]
      if (!field || !validRuleValue(type, value)) throw invalid()
      return { [field]: [value] }
    })
    return { type: 'inline', tag: name, rules }
  })
  const tags = new Set(names)
  if (locals.length) {
    const { results: records } = await db.prepare(`
      SELECT name,rules_json FROM conversion_local_rule_sets WHERE name IN (SELECT value FROM json_each(?))
    `).bind(JSON.stringify(locals.map(({ name }) => name))).all<{ name: string; rules_json: string }>()
    const stored = new Map(records.map(record => [record.name, record.rules_json]))
    for (const { name } of locals) {
      const invalid = () => apiError(422, 'TEMPLATE_INVALID', 'sing-box 本地规则集校验失败', { diagnostics: [{
        code: 'SINGBOX_RULE_SET_INVALID', severity: 'error', path: 'subpanel.singbox.localRuleSets',
        message: `规则集「${name}」缺失、重名或包含不兼容规则`,
      }] })
      const raw = stored.get(name)
      if (!raw || tags.has(name)) throw invalid()
      tags.add(name)
      const rules = (JSON.parse(raw) as string[]).map(entry => {
        const [type, value] = entry.split(',').map(part => part.trim())
        const field = SINGBOX_MATCH_FIELDS[type]
        if (!field || !value || !validRuleValue(type, value)) throw invalid()
        return { [field]: [value] }
      })
      count += rules.length
      if (count > MAX_RULES) throw invalid()
      sets.push({ type: 'inline', tag: name, rules })
    }
  }
  if (remotes.length) {
    const { results: verified } = await db.prepare(`
      SELECT url FROM conversion_rule_sources
      WHERE url IN (SELECT value FROM json_each(?)) AND behavior='classical' AND format='text'
        AND version IS NOT NULL AND error_code IS NULL AND last_success_at >= ?
    `).bind(JSON.stringify(remotes.map(({ url }) => url)), new Date(Date.now() - 7 * 86400_000).toISOString()).all<{ url: string }>()
    const available = new Set(verified.map(({ url }) => url))
    for (const { name, url } of remotes) {
      if (tags.has(name) || !isNativeRuleSource({ url, behavior: 'classical', format: 'text' }) || !available.has(url)) {
        throw apiError(422, 'TEMPLATE_INVALID', 'sing-box 远程规则集校验失败', { diagnostics: [{
          code: 'SINGBOX_RULE_SET_INVALID', severity: 'error', path: 'subpanel.singbox.remoteRuleSets',
          message: `规则集「${name}」须使用规则库近七天验证的固定提交 JSON，且名称不能重复`,
        }] })
      }
      tags.add(name)
      sets.push({ type: 'remote', tag: name, format: 'source', url })
    }
  }
  return sets
}
