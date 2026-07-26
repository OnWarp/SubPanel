import type { JsonValue, Protocol } from '../catalog/schema.js'
import type { ImportResult, ParsedNode } from './model.js'
import { tokenizeLoonRow } from './loon.js'

const protocols: Record<string, Protocol> = {
  ss: 'shadowsocks',
  shadowsocks: 'shadowsocks',
  snell: 'snell',
  vmess: 'vmess',
  trojan: 'trojan',
  tuic: 'tuic',
  hysteria2: 'hysteria2',
  anytls: 'anytls',
  http: 'http',
  https: 'https',
  socks5: 'socks5',
  'socks5-tls': 'socks5',
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

function parseLine(line: string): ParsedNode {
  const separator = line.indexOf('=')
  if (separator <= 0) throw new Error('Invalid Surge row')
  const displayName = line.slice(0, separator).trim()
  const tokens = tokenizeLoonRow(line.slice(separator + 1))
  const protocol = protocols[tokens[0]?.toLowerCase()]
  const server = tokens[1]
  const port = Number(tokens[2])
  if (!displayName || !protocol || !server || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Surge row')
  const positionalCredentials = ['http', 'https', 'socks5'].includes(protocol) && tokens[3] && !tokens[3].includes('=')
  const values = options(tokens.slice(positionalCredentials ? 5 : 3))
  const credentials: Record<string, JsonValue> = {}
  if (protocol === 'shadowsocks') {
    const method = text(values['encrypt-method'] ?? values.method ?? values.cipher)
    const password = text(values.password)
    if (!method || !password) throw new Error('Missing Surge credentials')
    credentials.method = method
    credentials.password = password
    delete values['encrypt-method']
    delete values.method
    delete values.cipher
    delete values.password
  } else if (protocol === 'snell') {
    const psk = text(values.psk)
    const version = text(values.version)
    if (!psk || !version) throw new Error('Missing Snell credentials')
    credentials.psk = psk
    credentials.version = version
    delete values.psk
    delete values.version
  } else if (protocol === 'vmess') {
    const uuid = text(values.username ?? values.uuid)
    if (!uuid) throw new Error('Missing Surge credentials')
    credentials.uuid = uuid
    credentials.alterId = '0'
    credentials.security = 'auto'
    delete values.username
    delete values.uuid
  } else if (protocol === 'trojan') {
    const password = text(values.password)
    if (!password) throw new Error('Missing Surge credentials')
    credentials.password = password
    delete values.password
  } else if (protocol === 'tuic') {
    const token = text(values.token)
    const uuid = text(values.username ?? values.uuid)
    const password = text(values.password)
    if (!token && (!uuid || !password)) throw new Error('Missing TUIC credentials')
    if (token) {
      credentials.token = token
      credentials.password = token
      delete values.token
    } else {
      credentials.uuid = uuid!
      credentials.password = password!
      delete values.username
      delete values.uuid
      delete values.password
    }
  } else if (protocol === 'hysteria2' || protocol === 'anytls') {
    const password = text(values.password)
    if (!password) throw new Error('Missing credentials')
    credentials.password = password
    delete values.password
  } else {
    if (positionalCredentials) {
      if (tokens[3]) credentials.username = tokens[3]
      if (tokens[4]) credentials.password = tokens[4]
    } else {
      if (text(values.username)) credentials.username = text(values.username)!
      if (text(values.password)) credentials.password = text(values.password)!
    }
    delete values.username
    delete values.password
  }

  const tls: Record<string, JsonValue> = {}
  if (protocol === 'trojan' || protocol === 'tuic' || protocol === 'hysteria2' || protocol === 'anytls' || protocol === 'https' || tokens[0]?.toLowerCase() === 'socks5-tls' || values.tls === true) tls.enabled = true
  if (text(values.sni)) tls.serverName = text(values.sni)!
  if (typeof values['skip-cert-verify'] === 'boolean') tls.insecure = values['skip-cert-verify']
  if (text(values['server-cert-fingerprint-sha256'])) tls.certificateFingerprint = text(values['server-cert-fingerprint-sha256'])!
  if (text(values.alpn)) tls.alpn = text(values.alpn)!.split(',').map((item) => item.trim()).filter(Boolean)
  delete values.tls
  delete values.sni
  delete values['skip-cert-verify']
  delete values['server-cert-fingerprint-sha256']
  delete values.alpn

  let plugin: Record<string, JsonValue> | undefined
  const obfs = text(values.obfs)
  const obfsHost = text(values['obfs-host'])
  const obfsUri = text(values['obfs-uri'])
  if ((protocol === 'shadowsocks' || protocol === 'snell') && obfs) plugin = { name: obfs, ...((obfsHost || obfsUri) ? { options: { ...(obfsHost ? { host: obfsHost } : {}), ...(obfsUri ? { uri: obfsUri } : {}) } } : {}) }
  delete values.obfs
  delete values['obfs-host']
  delete values['obfs-uri']

  const transport: Record<string, JsonValue> = {}
  if (values.ws === true) transport.type = 'ws'
  if (text(values['ws-path'])) transport.path = text(values['ws-path'])!
  if (text(values['ws-headers'])) {
    const headers: Record<string, JsonValue> = {}
    for (const item of text(values['ws-headers'])!.split(';')) {
      const separator = item.indexOf(':')
      if (separator > 0) headers[item.slice(0, separator).trim()] = item.slice(separator + 1).trim()
    }
    if (Object.keys(headers).length > 0) transport.headers = headers
  }
  if (text(values['download-bandwidth'])) transport.downMbps = text(values['download-bandwidth'])!
  if (text(values['port-hopping'])) transport.mport = text(values['port-hopping'])!
  if (text(values['port-hopping-interval'])) transport.hopInterval = text(values['port-hopping-interval'])!
  if (text(values['salamander-password'])) {
    transport.obfs = 'salamander'
    transport.obfsPassword = text(values['salamander-password'])!
  } else if (text(values['gecko-password'])) {
    transport.obfs = 'gecko'
    transport.obfsPassword = text(values['gecko-password'])!
  }
  delete values.ws
  delete values['ws-path']
  delete values['ws-headers']
  delete values['download-bandwidth']
  delete values['port-hopping']
  delete values['port-hopping-interval']
  delete values['salamander-password']
  delete values['gecko-password']

  return {
    protocol,
    displayName,
    server,
    port,
    credentials,
    tls: Object.keys(tls).length > 0 ? tls : undefined,
    transport: Object.keys(transport).length > 0 ? transport : undefined,
    plugin,
    extensions: values,
    raw: line,
    format: 'surge',
  }
}

export function isSurgeContent(content: string): boolean {
  return /^\s*\[Proxy\]\s*$/imu.test(content)
}

export function parseSurge(content: string): ImportResult {
  const nodes: ParsedNode[] = []
  const warnings: ImportResult['warnings'] = []
  let section = ''
  for (const [index, original] of content.split(/\r?\n/u).entries()) {
    const line = original.trim()
    const header = /^\[([^\]]+)\]$/u.exec(line)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    if (!line || line.startsWith('#') || line.startsWith(';') || (section && section !== 'proxy')) continue
    try {
      nodes.push(parseLine(line))
    } catch {
      warnings.push({ code: 'INVALID_SURGE_NODE', message: 'Invalid Surge proxy entry', line: index + 1 })
    }
  }
  return { format: 'surge', nodes, warnings }
}
