import type { JsonValue, Protocol } from '../catalog/schema.js'
import type { ImportResult, ParsedNode } from './model.js'

const protocols: Record<string, Protocol> = {
  shadowsocks: 'shadowsocks',
  ss: 'shadowsocks',
  shadowsocksr: 'ssr',
  ssr: 'ssr',
  trojan: 'trojan',
  hysteria2: 'hysteria2',
  vmess: 'vmess',
  vless: 'vless',
  http: 'http',
  https: 'https',
  wireguard: 'wireguard',
}

export function tokenizeLoonRow(value: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote = ''
  let escaped = false
  let bracketDepth = 0

  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
    } else if (quote) {
      if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if ('([{'.includes(character)) {
      bracketDepth += 1
      current += character
    } else if (')]}'.includes(character)) {
      bracketDepth -= 1
      if (bracketDepth < 0) throw new Error('Unbalanced brackets')
      current += character
    } else if (character === ',' && bracketDepth === 0) {
      tokens.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }

  if (escaped || quote || bracketDepth !== 0) throw new Error('Invalid quoted row')
  tokens.push(current.trim())
  return tokens
}

function port(value: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid port')
  return result
}

function optionValue(value: string): JsonValue {
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false
  return value
}

function parseOptions(tokens: string[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const token of tokens) {
    const separator = token.indexOf('=')
    if (separator <= 0) continue
    result[token.slice(0, separator).trim().toLowerCase()] = optionValue(token.slice(separator + 1).trim())
  }
  return result
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

function wireGuardNode(displayName: string, tokens: string[], raw: string): ParsedNode {
  const options = parseOptions(tokens.slice(1))
  const privateKey = stringValue(options['private-key'])
  const peers = stringValue(options.peers)
  if (!privateKey || !peers) throw new Error('Missing WireGuard fields')

  const peerRows = peers.replace(/^\[/u, '').replace(/\]$/u, '')
  const firstPeer = peerRows.match(/^\{([\s\S]*?)\}(?:,|$)/u)?.[1]
  if (!firstPeer) throw new Error('Missing WireGuard peer')
  const peer = parseOptions(tokenizeLoonRow(firstPeer))
  const endpoint = stringValue(peer.endpoint)
  const separator = endpoint?.lastIndexOf(':') ?? -1
  if (!endpoint || separator < 1) throw new Error('Missing WireGuard endpoint')
  const server = endpoint.slice(0, separator).replace(/^\[|\]$/gu, '')
  const serverPort = port(endpoint.slice(separator + 1))
  const publicKey = stringValue(peer['public-key'])
  if (!publicKey) throw new Error('Missing WireGuard public key')

  const extensions: Record<string, JsonValue> = {}
  const localAddress = stringValue(options['interface-ip'])
  const ipv6 = stringValue(options['interface-ipv6'])
  const mtu = numberValue(options.mtu)
  const keepalive = numberValue(options.keepalive ?? options.keeyalive)
  if (localAddress) extensions.localAddress = localAddress
  if (ipv6) extensions.ipv6 = ipv6
  if (mtu !== undefined) extensions.mtu = mtu
  if (stringValue(options.dns)) extensions.dns = options.dns
  if (stringValue(options.dnsv6)) extensions.dnsV6 = options.dnsv6
  if (keepalive !== undefined) extensions.keepalive = keepalive
  extensions.peers = peerRows
  for (const [key, value] of Object.entries(options)) {
    if (!['private-key', 'interface-ip', 'interface-ipv6', 'mtu', 'dns', 'dnsv6', 'keepalive', 'keeyalive', 'peers'].includes(key)) extensions[key] = value
  }

  return {
    protocol: 'wireguard',
    displayName,
    server,
    port: serverPort,
    credentials: {
      privateKey,
      publicKey,
      ...(stringValue(peer['preshared-key']) ? { preSharedKey: peer['preshared-key'] } : {}),
    },
    extensions,
    raw,
    format: 'loon',
  }
}

function parseLine(line: string): ParsedNode {
  const separator = line.indexOf('=')
  if (separator <= 0) throw new Error('Invalid row')
  const displayName = line.slice(0, separator).trim()
  if (!displayName) throw new Error('Missing name')
  const tokens = tokenizeLoonRow(line.slice(separator + 1))
  const protocol = protocols[tokens[0]?.toLowerCase()]
  if (!protocol || !tokens[1]) throw new Error('Unsupported protocol')
  if (protocol === 'wireguard') return wireGuardNode(displayName, tokens, line)
  const server = tokens[1]
  const serverPort = port(tokens[2] ?? '')
  let credentials: Record<string, string>
  let optionStart: number

  switch (protocol) {
    case 'shadowsocks':
    case 'ssr':
      if (!tokens[3] || !tokens[4]) throw new Error('Missing credentials')
      credentials = { method: tokens[3], password: tokens[4] }
      optionStart = 5
      break
    case 'vmess':
      if (!tokens[3] || !tokens[4]) throw new Error('Missing credentials')
      credentials = { security: tokens[3], uuid: tokens[4], alterId: '0' }
      optionStart = 5
      break
    case 'vless':
      if (!tokens[3]) throw new Error('Missing credentials')
      credentials = { uuid: tokens[3], encryption: 'none' }
      optionStart = 4
      break
    case 'tuic':
      if (!tokens[3] || !tokens[4]) throw new Error('Missing credentials')
      credentials = { uuid: tokens[3], password: tokens[4] }
      optionStart = 5
      break
    case 'http':
    case 'https':
    case 'socks5':
      credentials = {}
      optionStart = 3
      if (tokens[3] && !tokens[3].includes('=')) {
        credentials.username = tokens[3]
        if (tokens[4] && !tokens[4].includes('=')) credentials.password = tokens[4]
        optionStart = 5
      }
      break
    default:
      if (!tokens[3]) throw new Error('Missing credentials')
      credentials = { password: tokens[3] }
      optionStart = 4
  }

  const options = parseOptions(tokens.slice(optionStart))
  const tls: Record<string, JsonValue> = {}
  if (['trojan', 'hysteria2', 'tuic', 'anytls', 'https'].includes(protocol)) tls.enabled = true
  if (typeof options['over-tls'] === 'boolean') {
    tls.enabled = options['over-tls']
    delete options['over-tls']
  }
  if (typeof options['skip-cert-verify'] === 'boolean') {
    tls.insecure = options['skip-cert-verify']
    delete options['skip-cert-verify']
  }
  if (typeof options['tls-name'] === 'string') {
    tls.serverName = options['tls-name']
    delete options['tls-name']
  }
  if (typeof options.alpn === 'string') {
    tls.alpn = options.alpn.split(/[|,]/u).map((item) => item.trim()).filter(Boolean)
    delete options.alpn
  }

  const transport: Record<string, JsonValue> = {}
  const transportType = stringValue(options.transport ?? options.network)
  if (transportType) transport.type = transportType
  if (stringValue(options.path)) transport.path = options.path
  if (stringValue(options.host)) transport.headers = { Host: options.host }
  delete options.transport
  delete options.network
  delete options.path
  delete options.host

  if (protocol === 'vmess' && stringValue(options.alterid)) {
    credentials.alterId = stringValue(options.alterid)!
    delete options.alterid
  }
  if (protocol === 'ssr') {
    const protocolName = stringValue(options.protocol)
    const obfs = stringValue(options.obfs)
    if (!protocolName || !obfs) throw new Error('Missing ShadowsocksR fields')
    credentials.protocol = protocolName
    credentials.obfs = obfs
    delete options.protocol
    delete options.obfs
  }

  let plugin: Record<string, JsonValue> | undefined
  if (protocol === 'shadowsocks') {
    const name = stringValue(options['obfs-name'] ?? options.obfs)
    const host = stringValue(options['obfs-host'])
    const uri = stringValue(options['obfs-uri'])
    if (name) {
      plugin = { name, ...((host || uri) ? { options: { ...(host ? { host } : {}), ...(uri ? { uri } : {}) } } : {}) }
      delete options['obfs-name']
      delete options.obfs
      delete options['obfs-host']
      delete options['obfs-uri']
    }
  }

  return {
    protocol,
    displayName,
    server,
    port: serverPort,
    credentials,
    tls: Object.keys(tls).length > 0 ? tls : undefined,
    transport: Object.keys(transport).length > 0 ? transport : undefined,
    plugin,
    extensions: options,
    raw: line,
    format: 'loon',
  }
}

export function isLoonContent(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return false
    const separator = trimmed.indexOf('=')
    if (separator <= 0) return false
    const protocol = trimmed.slice(separator + 1).split(',', 1)[0].trim().toLowerCase()
    return protocol in protocols
  })
}

export function parseLoon(content: string): ImportResult {
  const nodes: ParsedNode[] = []
  const warnings: ImportResult['warnings'] = []
  for (const [index, original] of content.split(/\r?\n/u).entries()) {
    const line = original.replace(/^\uFEFF/u, '').trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || /^\[[^\]]+\]$/u.test(line)) continue
    try {
      nodes.push(parseLine(line))
    } catch {
      warnings.push({ code: 'INVALID_LOON_NODE', message: 'Invalid Loon node entry', line: index + 1 })
    }
  }
  return { format: 'loon', nodes, warnings }
}
