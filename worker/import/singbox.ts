import { z } from 'zod'
import { jsonValueSchema, type JsonValue, type Protocol } from '../catalog/schema.js'
import type { ImportResult, ParsedNode } from './model.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const rootSchema = z.union([z.array(z.unknown()), z.object({ outbounds: z.array(z.unknown()) })])
const outboundSchema = z.record(z.string(), z.unknown())
const protocols: Record<string, Protocol> = {
  shadowsocks: 'shadowsocks',
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  hysteria: 'hysteria',
  hysteria2: 'hysteria2',
  tuic: 'tuic',
  wireguard: 'wireguard',
  anytls: 'anytls',
  naive: 'naive',
  http: 'http',
  socks: 'socks5',
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing string')
  return value
}

function firstString(entry: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string
  return undefined
}

function addTransportAliases(
  entry: Record<string, unknown>,
  transportValue: Record<string, JsonValue>,
  consumed: Set<string>,
  target: string,
  ...keys: string[]
): void {
  for (const key of keys) consumed.add(key)
  const value = keys.map((key) => entry[key]).find((candidate) => candidate !== undefined)
  if (value === undefined) return
  const parsed = jsonValueSchema.safeParse(value)
  if (parsed.success) transportValue[target] = parsed.data
}

function port(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid port')
  return result
}

function record(value: unknown): Record<string, unknown> | null {
  const result = outboundSchema.safeParse(value)
  return result.success ? result.data : null
}

function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  const result = jsonValueSchema.safeParse(value)
  return result.success && value !== null && typeof value === 'object' && !Array.isArray(value) ? result.data as Record<string, JsonValue> : undefined
}

function normalizeTls(value: unknown): Record<string, JsonValue> | undefined {
  const source = record(value)
  if (!source) return undefined
  const result: Record<string, JsonValue> = {}
  const consumed = new Set(['enabled', 'server_name', 'insecure', 'alpn', 'utls', 'certificate', 'certificate_public_key_sha256', 'reality'])
  if (typeof source.enabled === 'boolean') result.enabled = source.enabled
  if (typeof source.server_name === 'string' && source.server_name) result.serverName = source.server_name
  if (typeof source.insecure === 'boolean') result.insecure = source.insecure
  if (Array.isArray(source.alpn) && source.alpn.every((item) => typeof item === 'string')) result.alpn = source.alpn as string[]
  const utls = record(source.utls)
  if (typeof utls?.fingerprint === 'string') result.fingerprint = utls.fingerprint
  const certificate = Array.isArray(source.certificate) ? source.certificate.find((item) => typeof item === 'string') : source.certificate
  if (typeof certificate === 'string' && certificate) result.certificate = certificate
  const pin = Array.isArray(source.certificate_public_key_sha256)
    ? source.certificate_public_key_sha256.find((item) => typeof item === 'string')
    : source.certificate_public_key_sha256
  if (typeof pin === 'string' && pin) result.certificateFingerprint = pin
  const reality = record(source.reality)
  if (reality) {
    const publicKey = typeof reality.public_key === 'string' ? reality.public_key : typeof reality.publicKey === 'string' ? reality.publicKey : undefined
    const shortId = typeof reality.short_id === 'string' ? reality.short_id : typeof reality.shortId === 'string' ? reality.shortId : undefined
    const spiderX = typeof reality.spider_x === 'string' ? reality.spider_x : typeof reality.spiderX === 'string' ? reality.spiderX : undefined
    const realityResult: Record<string, JsonValue> = {
      ...(publicKey ? { publicKey } : {}),
      ...(shortId ? { shortId } : {}),
      ...(spiderX ? { spiderX } : {}),
    }
    for (const [key, item] of Object.entries(reality)) {
      if (['enabled', 'public_key', 'publicKey', 'short_id', 'shortId', 'spider_x', 'spiderX'].includes(key)) continue
      const parsed = jsonValueSchema.safeParse(item)
      if (parsed.success) realityResult[key] = parsed.data
    }
    if (reality.enabled === false) realityResult.enabled = false
    if (Object.keys(realityResult).length > 0) result.reality = realityResult
  }
  for (const [key, item] of Object.entries(source)) {
    if (consumed.has(key)) continue
    const parsed = jsonValueSchema.safeParse(item)
    if (parsed.success) result[key] = parsed.data
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeTransport(value: unknown): Record<string, JsonValue> | undefined {
  const source = record(value)
  if (!source) return undefined
  const result: Record<string, JsonValue> = {}
  const consumed = new Set(['type', 'path', 'headers', 'service_name', 'max_early_data', 'early_data_header_name'])
  if (typeof source.type === 'string') result.type = source.type
  if (typeof source.path === 'string') result.path = source.path
  const headers = jsonRecord(source.headers)
  if (headers) result.headers = headers
  if (typeof source.service_name === 'string') result.serviceName = source.service_name
  if (typeof source.max_early_data === 'number' || typeof source.max_early_data === 'string') result.earlyData = source.max_early_data
  if (typeof source.early_data_header_name === 'string') result.earlyDataHeaderName = source.early_data_header_name
  for (const [key, item] of Object.entries(source)) {
    if (consumed.has(key)) continue
    const parsed = jsonValueSchema.safeParse(item)
    if (parsed.success) result[key] = parsed.data
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function extensions(entry: Record<string, unknown>, consumed: Set<string>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (consumed.has(key)) continue
    const parsed = jsonValueSchema.safeParse(value)
    if (parsed.success) result[key] = parsed.data
  }
  return result
}

function parseOutbound(entry: Record<string, unknown>): ParsedNode {
  const type = requiredString(entry.type).toLowerCase()
  let protocol = protocols[type]
  if (!protocol) throw new Error('Unsupported protocol')
  const server = requiredString(entry.server)
  const serverPort = port(entry.server_port)
  const consumed = new Set(['type', 'tag', 'server', 'server_port', 'tls', 'transport'])
  let credentials: Record<string, JsonValue> = {}
  let plugin: Record<string, JsonValue> | undefined
  const normalizedExtensions: Record<string, JsonValue> = {}

  switch (protocol) {
    case 'shadowsocks':
      credentials = { method: requiredString(entry.method), password: requiredString(entry.password) }
      consumed.add('method').add('password').add('plugin').add('plugin_opts')
      if (typeof entry.plugin === 'string' && entry.plugin) {
        plugin = { name: entry.plugin, ...(typeof entry.plugin_opts === 'string' && entry.plugin_opts ? { options: entry.plugin_opts } : {}) }
      }
      if (requiredString(entry.method).startsWith('2022-blake3')) protocol = 'ss2022'
      break
    case 'vmess':
      credentials = {
        uuid: requiredString(entry.uuid),
        alterId: String(entry.alter_id ?? 0),
        security: typeof entry.security === 'string' && entry.security ? entry.security : 'auto',
      }
      if (!UUID.test(String(credentials.uuid))) throw new Error('Invalid UUID')
      consumed.add('uuid').add('alter_id').add('security')
      break
    case 'vless':
      credentials = { uuid: requiredString(entry.uuid), encryption: 'none' }
      if (!UUID.test(String(credentials.uuid))) throw new Error('Invalid UUID')
      if (typeof entry.flow === 'string' && entry.flow) credentials.flow = entry.flow
      consumed.add('uuid').add('flow')
      break
    case 'trojan':
    case 'hysteria':
    case 'hysteria2':
    case 'anytls': {
      const authentication = firstString(entry, 'password', 'auth', 'auth_str', 'auth-str')
      if (protocol !== 'hysteria' || authentication) credentials = { password: requiredString(authentication) }
      for (const key of ['password', 'auth', 'auth_str', 'auth-str']) consumed.add(key)
      break
    }
    case 'naive':
      credentials = { username: requiredString(entry.username), password: requiredString(entry.password) }
      consumed.add('username').add('password')
      break
    case 'tuic':
      credentials = { uuid: requiredString(entry.uuid), password: requiredString(entry.password) }
      if (!UUID.test(String(credentials.uuid))) throw new Error('Invalid UUID')
      consumed.add('uuid').add('password')
      break
    case 'wireguard':
      credentials = { privateKey: requiredString(entry.private_key), publicKey: requiredString(entry.peer_public_key) }
      if (typeof entry.pre_shared_key === 'string') credentials.preSharedKey = entry.pre_shared_key
      consumed.add('private_key').add('peer_public_key').add('pre_shared_key')
      break
    case 'http':
    case 'socks5':
      if (typeof entry.username === 'string') credentials.username = entry.username
      if (typeof entry.password === 'string') credentials.password = entry.password
      consumed.add('username').add('password')
      if (protocol === 'http' && record(entry.tls)?.enabled === true) protocol = 'https'
      break
  }

  const normalizedTransport = normalizeTransport(entry.transport) ?? {}
  if (protocol === 'tuic' && typeof entry.congestion_control === 'string') {
    normalizedTransport.congestionControl = entry.congestion_control
    consumed.add('congestion_control')
  }
  if (protocol === 'tuic' && typeof entry.udp_relay_mode === 'string') {
    normalizedTransport.udpRelayMode = entry.udp_relay_mode
    consumed.add('udp_relay_mode')
  }
  if (protocol === 'hysteria2') {
    if (Array.isArray(entry.server_ports) || typeof entry.server_ports === 'string' || typeof entry.server_ports === 'number') {
      const sourcePorts = Array.isArray(entry.server_ports) ? entry.server_ports : [entry.server_ports]
      const ports = sourcePorts.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
       if (ports.length > 0) normalizedTransport.mport = ports.map((item) => String(item).replaceAll(':', '-')).join(',')
      consumed.add('server_ports')
    }
    if (typeof entry.hop_interval === 'string' || typeof entry.hop_interval === 'number') {
      normalizedTransport.hopInterval = entry.hop_interval
      consumed.add('hop_interval')
    }
    if (typeof entry.up_mbps === 'string' || typeof entry.up_mbps === 'number') {
      normalizedTransport.upMbps = entry.up_mbps
      consumed.add('up_mbps')
    }
    if (typeof entry.down_mbps === 'string' || typeof entry.down_mbps === 'number') {
      normalizedTransport.downMbps = entry.down_mbps
      consumed.add('down_mbps')
    }
    const obfs = record(entry.obfs)
    if (typeof entry.obfs === 'string' && entry.obfs) normalizedTransport.obfs = entry.obfs
    if (typeof obfs?.type === 'string' && obfs.type) normalizedTransport.obfs = obfs.type
    if (typeof obfs?.password === 'string' && obfs.password) normalizedTransport.obfsPassword = obfs.password
    if (typeof entry.obfs_password === 'string' && entry.obfs_password) normalizedTransport.obfsPassword = entry.obfs_password
    if (entry.obfs !== undefined) consumed.add('obfs')
    consumed.add('obfs_password')
  }
  if (protocol === 'hysteria') {
    if (Array.isArray(entry.server_ports) || typeof entry.server_ports === 'string' || typeof entry.server_ports === 'number') {
      const sourcePorts = Array.isArray(entry.server_ports) ? entry.server_ports : [entry.server_ports]
      const ports = sourcePorts.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
      if (ports.length > 0) normalizedTransport.mport = ports.map((item) => String(item).replaceAll(':', '-')).join(',')
      consumed.add('server_ports')
    }
    if (typeof entry.hop_interval === 'string' || typeof entry.hop_interval === 'number') {
      normalizedTransport.hopInterval = entry.hop_interval
      consumed.add('hop_interval')
    }
    addTransportAliases(entry, normalizedTransport, consumed, 'upMbps', 'up_mbps', 'up')
    addTransportAliases(entry, normalizedTransport, consumed, 'downMbps', 'down_mbps', 'down')
    const obfs = record(entry.obfs)
    if (typeof entry.obfs === 'string' && entry.obfs) normalizedTransport.obfs = entry.obfs
    if (typeof obfs?.type === 'string' && obfs.type) normalizedTransport.obfs = obfs.type
    if (typeof obfs?.password === 'string' && obfs.password) normalizedTransport.obfsPassword = obfs.password
    consumed.add('obfs')
    addTransportAliases(entry, normalizedTransport, consumed, 'obfsPassword', 'obfs_password', 'obfs-password')
  }
  if (protocol === 'wireguard') {
    addTransportAliases(entry, normalizedExtensions, consumed, 'localAddress', 'local_address')
    addTransportAliases(entry, normalizedExtensions, consumed, 'mtu', 'mtu')
    addTransportAliases(entry, normalizedExtensions, consumed, 'reserved', 'reserved')
  }

  return {
    protocol,
    displayName: typeof entry.tag === 'string' && entry.tag ? entry.tag : `${protocol} ${server}`,
    server,
    port: serverPort,
    credentials,
    tls: normalizeTls(entry.tls),
    transport: Object.keys(normalizedTransport).length > 0 ? normalizedTransport : undefined,
    plugin,
    extensions: { ...extensions(entry, consumed), ...normalizedExtensions },
    raw: JSON.stringify(entry),
    format: 'sing-box',
  }
}

function safeType(entry: Record<string, unknown>): string {
  return typeof entry.type === 'string' && /^[a-z0-9_-]{1,32}$/iu.test(entry.type) ? entry.type : 'unknown'
}

export function parseSingBox(content: string): ImportResult {
  let parsed: z.infer<typeof rootSchema>
  try {
    parsed = rootSchema.parse(JSON.parse(content))
  } catch {
    throw new Error('Invalid sing-box document')
  }
  const entries = Array.isArray(parsed) ? parsed : parsed.outbounds
  const nodes: ParsedNode[] = []
  const warnings: ImportResult['warnings'] = []
  const records = entries.map(record)
  const byTag = new Map<string, Record<string, unknown>>()
  for (const entry of records) if (typeof entry?.tag === 'string' && entry.tag) byTag.set(entry.tag, entry)
  const chains = new Map<Record<string, unknown>, Record<string, unknown>>()
  const hopEntries = new Set<Record<string, unknown>>()
  for (const entry of records) {
    if (!entry || entry.type !== 'shadowsocks' || typeof entry.detour !== 'string') continue
    const hop = byTag.get(entry.detour)
    if (!hop || hop.type !== 'shadowtls') continue
    chains.set(entry, hop)
    hopEntries.add(hop)
  }

  for (const entry of records) {
    if (!entry) {
      warnings.push({ code: 'INVALID_SINGBOX_OUTBOUND', message: 'Invalid sing-box outbound entry' })
      continue
    }
    if (hopEntries.has(entry)) continue
    const hop = chains.get(entry)
    if (hop) {
      try {
        const leaf = parseOutbound(entry)
        nodes.push({
          ...leaf,
          protocol: typeof entry.method === 'string' && entry.method.startsWith('2022-blake3') ? 'ss2022' : 'shadowsocks',
          server: requiredString(hop.server),
          port: port(hop.server_port),
          tls: normalizeTls(hop.tls),
          extensions: {
            ...leaf.extensions,
            shadowtls: {
              ...(typeof hop.version === 'number' ? { version: hop.version } : {}),
              ...(typeof hop.password === 'string' ? { password: hop.password } : {}),
            },
          },
          raw: JSON.stringify({ leaf: entry, hop }),
        })
      } catch {
        warnings.push({ code: 'INVALID_SINGBOX_OUTBOUND', message: 'Invalid sing-box ShadowTLS chain' })
      }
      continue
    }
    if (entry.type === 'shadowtls') {
      warnings.push({ code: 'UNSUPPORTED_SINGBOX_OUTBOUND', message: `Unsupported sing-box outbound type: ${safeType(entry)}` })
      continue
    }
    try {
      nodes.push(parseOutbound(entry))
    } catch (error) {
      if (error instanceof Error && error.message === 'Unsupported protocol') {
        warnings.push({ code: 'UNSUPPORTED_SINGBOX_OUTBOUND', message: `Unsupported sing-box outbound type: ${safeType(entry)}` })
      } else {
        warnings.push({ code: 'INVALID_SINGBOX_OUTBOUND', message: 'Invalid sing-box outbound entry' })
      }
    }
  }
  return { format: 'sing-box', nodes, warnings }
}
