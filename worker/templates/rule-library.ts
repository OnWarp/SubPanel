import { Lexer, isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { fetchRemoteTextWithPolicy as fetchRemoteTextWithMetadata } from '../catalog/egress-policy.js'
import { RemoteFetchError, validateRemoteUrl } from '../catalog/remote.js'
import { sha256Base64Url } from '../platform/hash.js'
import { apiError } from '../platform/api-error.js'
import { validRuleValue, type Template } from './validation.js'
import { z } from 'zod'

const TRUSTED_ORIGINS = new Set(['https://raw.githubusercontent.com', 'https://cdn.jsdelivr.net'])
const MAX_BYTES = 256 * 1024
const MAX_RULES = 10_000
export const systemRuleSet = {
  name: '系统私网地址',
  revision: 1,
  rules: ['IP-CIDR,10.0.0.0/8', 'IP-CIDR,172.16.0.0/12', 'IP-CIDR,192.168.0.0/16', 'IP-CIDR6,fc00::/7'],
}
const matchFields: Record<string, string> = {
  DOMAIN: 'domain', 'DOMAIN-SUFFIX': 'domain_suffix', 'DOMAIN-KEYWORD': 'domain_keyword',
  'IP-CIDR': 'ip_cidr', 'IP-CIDR6': 'ip_cidr', 'SRC-IP-CIDR': 'source_ip_cidr',
}
export type RuleVersionSnapshot = { type: 'local' | 'remote' | 'system'; key: string; tag: string; version: string }


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
  // A native source has one root object, a rules array, objects and string arrays.
  let depth = 0
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]]/gu)) {
    if ((token[0] === '[' || token[0] === '{') && ++depth > 4) throw new RemoteFetchError('REMOTE_BODY_INVALID')
    if (token[0] === ']' || token[0] === '}') depth--
  }
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
    // Preflight flow nesting before the recursive YAML composer sees it.
    let depth = 0
    for (const token of new Lexer().lex(text, false)) {
      if ((token === '[' || token === '{') && ++depth > 2) throw new RemoteFetchError('REMOTE_BODY_INVALID')
      if (token === ']' || token === '}') depth--
    }
    if (/^[ \t]{33}|^[ \t]*-[ \t]+[?\-:][ \t]/mu.test(text)) throw new RemoteFetchError('REMOTE_BODY_INVALID')
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

export async function listRuleSources(db: D1Database, offset = 0) {
  const { results } = await db.prepare(`SELECT url,behavior,format,version,last_success_at,error_code
    FROM conversion_rule_sources ORDER BY url,behavior,format LIMIT 101 OFFSET ?`).bind(offset).all<RuleSourceRow>()
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
      return { name, url: isNativeRuleSource({ url: normalized, behavior, format: format === 'text' ? 'text' : 'yaml' }) ? null : normalized, behavior, format: format ?? 'yaml' }
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
  name: z.string().trim().min(1).max(80).refine(name => name !== systemRuleSet.name),
  rules: z.array(z.string().trim().min(1).max(1024).refine(rule => {
    const [type, value, ...extra] = rule.split(',').map(part => part.trim())
    return /^[A-Z][A-Z0-9-]*$/u.test(type) && !['MATCH', 'RULE-SET'].includes(type) && !!value
      && !/\p{Cc}/u.test(rule) && validRuleValue(type, value)
      && (extra.length === 0 ? Object.hasOwn(matchFields, type) : extra.length === 1 || (extra.length === 2 && extra[1] === 'no-resolve'))
  }, '请填写受支持的匹配类型和值，例如 DOMAIN-SUFFIX,example.com')).min(1).max(100),
})

export function saveLocalRuleSet(db: D1Database, input: z.infer<typeof localRuleSet>) {
  return db.prepare(`
    INSERT INTO conversion_local_rule_sets (name,rules_json,revision,updated_at) VALUES (?,?,1,?)
    ON CONFLICT(name) DO UPDATE SET rules_json=excluded.rules_json, revision=revision+1, updated_at=excluded.updated_at
  `).bind(input.name, JSON.stringify(input.rules), new Date().toISOString()).run()
}

export async function listLocalRuleSets(db: D1Database, offset = 0) {
  const { results } = await db.prepare(`
    SELECT name,rules_json,revision,updated_at FROM conversion_local_rule_sets ORDER BY name LIMIT 101 OFFSET ?
  `).bind(offset).all<{ name: string; rules_json: string; revision: number; updated_at: string }>()
  return results.map(({ rules_json, ...row }) => ({ ...row, rules: JSON.parse(rules_json) as string[] }))
}

export async function loadSingBoxRuleSets(db: D1Database, template: Template, snapshots?: RuleVersionSnapshot[]) {
  const names = [...new Set(template.rules.filter(rule => rule.startsWith('RULE-SET,')).map(rule => rule.split(',')[1]))]
  const locals = template.subpanel?.singbox?.localRuleSets ?? []
  const remotes = template.subpanel?.singbox?.remoteRuleSets ?? []
  if (names.length === 0 && locals.length === 0 && remotes.length === 0) return []
  const requested = names.map(name => {
    const provider = template['rule-providers']![name]
    return { ...provider, name, url: ruleSourceUrl(provider.url).href }
  })
  const { results } = await db.prepare(`
    SELECT json_extract(j.value,'$.name') AS name, s.url, s.behavior, s.format, s.payload, s.version
    FROM json_each(?) j JOIN conversion_rule_sources s
      ON s.url=json_extract(j.value,'$.url') AND s.behavior=json_extract(j.value,'$.behavior')
      AND s.format=json_extract(j.value,'$.format')
    WHERE s.version IS NOT NULL
      AND (SELECT SUM(length(CAST(p.payload AS BLOB))) FROM conversion_rule_sources p JOIN json_each(?) k
           ON p.url=json_extract(k.value,'$.url') AND p.behavior=json_extract(k.value,'$.behavior')
           AND p.format=json_extract(k.value,'$.format')) <= ?
  `).bind(JSON.stringify(requested), JSON.stringify(requested), MAX_BYTES).all<Source & { name: string; payload: string; version: string }>()
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
    snapshots?.push({ type: 'remote', key: JSON.stringify([row.url, row.behavior, row.format]), tag: name, version: row.version })
    validateRulePayload(row.payload, row)
    const entries: string[] = row.format === 'yaml' ? parseDocument(row.payload).toJS().payload
      : row.payload.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    count += entries.length
    if (count > MAX_RULES) throw invalid()
    const rules = entries.map(entry => {
      const [type, value] = row.behavior === 'classical' ? entry.split(',').map(part => part.trim())
        : [row.behavior === 'ipcidr' ? 'IP-CIDR' : 'DOMAIN-SUFFIX', entry.trim().replace(/^\+\./u, '')]
      const field = Object.hasOwn(matchFields, type) ? matchFields[type] : undefined
      if (!field || !validRuleValue(type, value)) throw invalid()
      return { [field]: [value] }
    })
    return { type: 'inline', tag: name, rules }
  })
  const tags = new Set(names)
  if (locals.length) {
    const { results: records } = await db.prepare(`
      SELECT name,rules_json,revision FROM conversion_local_rule_sets WHERE name IN (SELECT value FROM json_each(?))
    `).bind(JSON.stringify(locals.map(({ name }) => name))).all<{ name: string; rules_json: string; revision: number }>()
    const stored = new Map(records.map(record => [record.name, record]))
    for (const { name } of locals) {
      const invalid = () => apiError(422, 'TEMPLATE_INVALID', 'sing-box 本地规则集校验失败', { diagnostics: [{
        code: 'SINGBOX_RULE_SET_INVALID', severity: 'error', path: 'subpanel.singbox.localRuleSets',
        message: `规则集「${name}」缺失、重名或包含不兼容规则`,
      }] })
      const system = name === systemRuleSet.name
      const record = stored.get(name)
      const entries: string[] | undefined = system ? systemRuleSet.rules : record && JSON.parse(record.rules_json)
      if (!entries || tags.has(name)) throw invalid()
      snapshots?.push({ type: system ? 'system' : 'local', key: name, tag: name,
        version: String(system ? systemRuleSet.revision : record!.revision) })
      tags.add(name)
      const rules = entries.map(entry => {
        const [type, value] = entry.split(',').map(part => part.trim())
        const field = Object.hasOwn(matchFields, type) ? matchFields[type] : undefined
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
      SELECT url, version FROM conversion_rule_sources
      WHERE url IN (SELECT value FROM json_each(?)) AND behavior='classical' AND format='text'
        AND version IS NOT NULL AND error_code IS NULL AND last_success_at >= ?
    `).bind(JSON.stringify(remotes.map(({ url }) => url)), new Date(Date.now() - 7 * 86400_000).toISOString()).all<{ url: string; version: string }>()
    const available = new Map(verified.map(({ url, version }) => [url, version]))
    for (const { name, url } of remotes) {
      if (tags.has(name) || !isNativeRuleSource({ url, behavior: 'classical', format: 'text' }) || !available.has(url)) {
        throw apiError(422, 'TEMPLATE_INVALID', 'sing-box 远程规则集校验失败', { diagnostics: [{
          code: 'SINGBOX_RULE_SET_INVALID', severity: 'error', path: 'subpanel.singbox.remoteRuleSets',
          message: `规则集「${name}」须使用规则库近七天验证的固定提交 JSON，且名称不能重复`,
        }] })
      }
      tags.add(name)
      snapshots?.push({ type: 'remote', key: JSON.stringify([url, 'classical', 'text']), tag: name, version: available.get(url)! })
      sets.push({ type: 'remote', tag: name, format: 'source', url })
    }
  }
  return sets
}

export const ruleUsageQuery = z.object({
  type: z.enum(['local', 'system', 'remote']),
  key: z.string().min(1).max(2200),
  after: z.string().max(128).default(''),
})

export async function ruleUsage(db: D1Database, input: z.infer<typeof ruleUsageQuery>) {
  const { type, key, after } = input
  let source: Pick<Source, 'url' | 'behavior' | 'format'> | undefined
  let current: string | null = null
  if (type === 'remote') {
    let tuple: unknown
    try { tuple = JSON.parse(key) } catch { throw apiError(422, 'RULE_SOURCE_INVALID', '规则源标识不正确') }
    const parts = z.tuple([z.string(), ruleSource.shape.behavior, ruleSource.shape.format]).safeParse(tuple)
    if (!parts.success) throw apiError(422, 'RULE_SOURCE_INVALID', '规则源标识不正确')
    const [url, behavior, format] = parts.data
    source = { url, behavior, format }
    current = (await db.prepare('SELECT version FROM conversion_rule_sources WHERE url=? AND behavior=? AND format=?')
      .bind(url, behavior, format).first<{ version: string | null }>())?.version ?? null
  } else if (type === 'system') {
    if (key !== systemRuleSet.name) throw apiError(404, 'RULE_SOURCE_INVALID', '系统规则集不存在')
    current = String(systemRuleSet.revision)
  } else {
    const row = await db.prepare('SELECT revision FROM conversion_local_rule_sets WHERE name=?')
      .bind(key).first<{ revision: number }>()
    current = row ? String(row.revision) : null
  }

  const { results } = await db.prepare(`
    WITH profiles AS (
      SELECT t.id,t.name,t.archived,v.sequence,v.id AS version_id,v.normalized_json AS policy,
        sv.id IS NOT NULL AS singbox, snapshots.versions_json AS versions
      FROM subscription_templates t JOIN subscription_template_versions v ON v.id=t.published_id
      LEFT JOIN conversion_profile_versions sv ON sv.profile_id=t.id AND sv.id=v.id AND sv.platform='singbox'
      LEFT JOIN conversion_rule_version_snapshots snapshots ON snapshots.version_id=v.id
      WHERE t.id>?
    ), usage AS (
      SELECT p.id,p.name,p.archived,p.sequence,p.version_id,p.versions,'mihomo' AS platform,
        providers.key AS tag, 'client' AS mode
      FROM profiles p, json_each(p.policy,'$.rule-providers') providers
      WHERE ?='remote' AND json_extract(providers.value,'$.url')=?
        AND json_extract(providers.value,'$.behavior')=? AND coalesce(json_extract(providers.value,'$.format'),'yaml')=?
        AND EXISTS (SELECT 1 FROM json_each(p.policy,'$.rules') r
          WHERE substr(r.value,1,length(providers.key)+10)='RULE-SET,' || providers.key || ',')
      UNION ALL
      SELECT p.id,p.name,p.archived,p.sequence,p.version_id,p.versions,'singbox',providers.key,'inline'
      FROM profiles p, json_each(p.policy,'$.rule-providers') providers
      WHERE p.singbox AND ?='remote' AND json_extract(providers.value,'$.url')=?
        AND json_extract(providers.value,'$.behavior')=? AND coalesce(json_extract(providers.value,'$.format'),'yaml')=?
        AND EXISTS (SELECT 1 FROM json_each(p.policy,'$.rules') r
          WHERE substr(r.value,1,length(providers.key)+10)='RULE-SET,' || providers.key || ',')
      UNION ALL
      SELECT p.id,p.name,p.archived,p.sequence,p.version_id,p.versions,'singbox',json_extract(r.value,'$.name'),'client'
      FROM profiles p, json_each(p.policy,'$.subpanel.singbox.remoteRuleSets') r
      WHERE p.singbox AND ?='remote' AND ?='classical' AND ?='text' AND json_extract(r.value,'$.url')=?
      UNION ALL
      SELECT p.id,p.name,p.archived,p.sequence,p.version_id,p.versions,'mihomo',json_extract(r.value,'$.name'),'inline'
      FROM profiles p, json_each(p.policy,'$.subpanel.ruleLibrary') r
      WHERE json_extract(r.value,'$.type')=? AND json_extract(r.value,'$.name')=?
        AND EXISTS (SELECT 1 FROM json_each(r.value,'$.rules') tracked JOIN json_each(p.policy,'$.rules') active
          ON tracked.value=active.value)
      UNION ALL
      SELECT p.id,p.name,p.archived,p.sequence,p.version_id,p.versions,'singbox',json_extract(r.value,'$.name'),'inline'
      FROM profiles p, json_each(p.policy,'$.subpanel.singbox.localRuleSets') r
      WHERE p.singbox AND ? IN ('local','system') AND json_extract(r.value,'$.name')=?
    ), page AS (SELECT DISTINCT id FROM usage ORDER BY id LIMIT 21)
    SELECT u.id,u.name,u.archived,u.sequence,u.platform,u.tag,u.mode,
      CASE WHEN u.platform='mihomo' AND u.mode='inline' THEN (
        SELECT CAST(json_extract(r.value,'$.revision') AS TEXT) FROM profiles p, json_each(p.policy,'$.subpanel.ruleLibrary') r
        WHERE p.id=u.id AND json_extract(r.value,'$.name')=u.tag AND json_extract(r.value,'$.type')=? LIMIT 1
      ) ELSE (SELECT json_extract(v.value,'$.version') FROM json_each(u.versions) v
        WHERE json_extract(v.value,'$.tag')=u.tag AND json_extract(v.value,'$.key')=? LIMIT 1) END AS version
    FROM usage u JOIN page USING(id) ORDER BY u.id,u.platform,u.tag
  `).bind(after,
    type, source?.url ?? null, source?.behavior ?? null, source?.format ?? null,
    type, source?.url ?? null, source?.behavior ?? null, source?.format ?? null,
    type, source?.behavior ?? null, source?.format ?? null, source?.url ?? null, type, key, type, key, type, key,
  ).all<{ id: string; name: string; archived: number; sequence: number; platform: string; tag: string; mode: string; version: string | null }>()
  const ids = [...new Set(results.map(row => row.id))]
  return {
    references: results.filter(row => row.id !== ids[20]).map(row => ({
      ...row, version: row.mode === 'client' && row.platform === 'mihomo' ? null : row.version,
      changed: row.mode === 'inline' && row.version !== null && row.version !== current,
    })),
    next: ids.length > 20 ? ids[19] : null,
  }
}
