import type { JsonValue, Protocol } from '../catalog/schema.js'
import type { ImportResult, ParsedNode } from './model.js'
import { tokenizeLoonRow } from './loon.js'

const protocols: Record<string, Protocol> = {
  shadowsocks: 'shadowsocks',
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  http: 'http',
  https: 'https',
  socks5: 'socks5',
  hysteria2: 'hysteria2',
}

function optionValue(value: string): JsonValue {
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false
  return value
}

function options(tokens: string[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const token of tokens) {
    const separator = token.indexOf('=')
    if (separator <= 0) continue
    result[token.slice(0, separator).trim().toLowerCase()] = optionValue(token.slice(separator + 1).trim())
  }
  return result
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function endpoint(value: string): { server: string; port: number } {
  const url = new URL(`http://${value}`)
  const port = Number(url.port)
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Quantumult X endpoint')
  return { server: url.hostname.replace(/^\[|\]$/gu, ''), port }
}

function parseLine(line: string): ParsedNode {
  const separator = line.indexOf('=')
  if (separator <= 0) throw new Error('Invalid Quantumult X row')
  const protocol = protocols[line.slice(0, separator).trim().toLowerCase()]
  if (!protocol) throw new Error('Unsupported Quantumult X protocol')
  const tokens = tokenizeLoonRow(line.slice(separator + 1))
  const target = endpoint(tokens[0] ?? '')
  const values = options(tokens.slice(1))
  const displayName = text(values.tag) || `${protocol} ${target.server}`
  delete values.tag
  const credentials: Record<string, JsonValue> = {}
  if (protocol === 'shadowsocks') {
    const method = text(values.method)
    const password = text(values.password)
    if (!method || !password) throw new Error('Missing Quantumult X credentials')
    credentials.method = method
    credentials.password = password
    delete values.method
    delete values.password
  } else if (protocol === 'vmess' || protocol === 'vless') {
    const uuid = text(values.password ?? values.uuid)
    if (!uuid) throw new Error('Missing Quantumult X credentials')
    credentials.uuid = uuid
    if (protocol === 'vmess') {
      credentials.alterId = '0'
      credentials.security = 'auto'
    } else {
      credentials.encryption = 'none'
    }
    delete values.password
    delete values.uuid
  } else if (['trojan', 'hysteria2'].includes(protocol)) {
    const password = text(values.password)
    if (!password) throw new Error('Missing Quantumult X credentials')
    credentials.password = password
    delete values.password
  } else {
    if (text(values.username)) credentials.username = text(values.username)!
    if (text(values.password)) credentials.password = text(values.password)!
    delete values.username
    delete values.password
  }

  const tls: Record<string, JsonValue> = {}
  if (protocol === 'trojan' || protocol === 'https' || protocol === 'hysteria2' || values['over-tls'] === true) tls.enabled = true
  if (text(values['tls-host'])) tls.serverName = text(values['tls-host'])!
  if (values['tls-verification'] === false) tls.insecure = true
  delete values['over-tls']
  delete values['tls-host']
  delete values['tls-verification']

  let plugin: Record<string, JsonValue> | undefined
  const obfs = text(values.obfs)
  const obfsHost = text(values['obfs-host'])
  if (protocol === 'shadowsocks' && obfs) plugin = { name: obfs, ...(obfsHost ? { options: { host: obfsHost } } : {}) }
  delete values.obfs
  delete values['obfs-host']

  return {
    protocol,
    displayName,
    ...target,
    credentials,
    tls: Object.keys(tls).length > 0 ? tls : undefined,
    plugin,
    extensions: values,
    raw: line,
    format: 'quantumultx',
  }
}

export function isQuantumultXContent(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => {
    const protocol = line.trim().split('=', 1)[0]?.toLowerCase()
    return Boolean(protocol && protocols[protocol])
  })
}

export function parseQuantumultX(content: string): ImportResult {
  const nodes: ParsedNode[] = []
  const warnings: ImportResult['warnings'] = []
  for (const [index, original] of content.split(/\r?\n/u).entries()) {
    const line = original.trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || /^\[[^\]]+\]$/u.test(line)) continue
    try {
      nodes.push(parseLine(line))
    } catch {
      warnings.push({ code: 'INVALID_QUANTUMULTX_NODE', message: 'Invalid Quantumult X server entry', line: index + 1 })
    }
  }
  return { format: 'quantumultx', nodes, warnings }
}

