import { parseDocument, stringify } from 'yaml'
import { jsonValueSchema, type JsonValue, type Protocol } from '../catalog/schema.js'
import type { ImportResult, ParsedNode } from './model.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const protocols: Record<string, Protocol> = {
  ss: 'shadowsocks',
  ssr: 'ssr',
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  hysteria2: 'hysteria2',
  hysteria: 'hysteria',
  tuic: 'tuic',
  wireguard: 'wireguard',
  anytls: 'anytls',
  naive: 'naive',
  http: 'http',
  socks5: 'socks5',
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function isMihomoProxyEntry(value: unknown): boolean {
  const entry = record(value)
  const hasAuth = Boolean(entry && (
    typeof entry.password === 'string' ||
    typeof entry.auth === 'string' ||
    typeof entry['auth-str'] === 'string' ||
    typeof entry.auth_str === 'string' ||
    typeof entry.uuid === 'string' ||
    typeof entry.cipher === 'string' ||
    typeof entry['private-key'] === 'string' ||
    entry.type === 'hysteria'
  ))
  return Boolean(entry && typeof entry.name === 'string' && typeof entry.type === 'string' && typeof entry.server === 'string' && (typeof entry.port === 'string' || typeof entry.port === 'number') && (hasAuth || entry.type === 'http' || entry.type === 'socks5'))
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing string')
  return value
}

function firstString(entry: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string
  return undefined
}

function booleanAlias(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 0 || (typeof value === 'string' && ['0', 'false'].includes(value.trim().toLowerCase()))) return false
  if (value === 1 || (typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase()))) return true
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
  const value = keys.map((key) => entry[key]).find((candidate) => typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean' || candidate === null || Array.isArray(candidate) || (candidate !== null && typeof candidate === 'object'))
  if (value !== undefined) {
    const parsed = jsonValueSchema.safeParse(value)
    if (parsed.success) transportValue[target] = parsed.data
  }
}

function port(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid port')
  return result
}

function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  const parsed = record(value)
  if (!parsed) return undefined
  const result = jsonValueSchema.safeParse(parsed)
  return result.success ? result.data as Record<string, JsonValue> : undefined
}

function reality(value: unknown): Record<string, JsonValue> | undefined {
  const source = record(value)
  if (!source) return undefined
  const publicKey = typeof source['public-key'] === 'string' ? source['public-key'] : typeof source.publicKey === 'string' ? source.publicKey : undefined
  const shortId = typeof source['short-id'] === 'string' ? source['short-id'] : typeof source.shortId === 'string' ? source.shortId : undefined
  const spiderX = typeof source['spider-x'] === 'string' ? source['spider-x'] : typeof source.spiderX === 'string' ? source.spiderX : undefined
  const result: Record<string, JsonValue> = {}
  if (publicKey) result.publicKey = publicKey
  if (shortId) result.shortId = shortId
  if (spiderX) result.spiderX = spiderX
  for (const [key, item] of Object.entries(source)) {
    if (['public-key', 'publicKey', 'short-id', 'shortId', 'spider-x', 'spiderX'].includes(key)) continue
    const parsed = jsonValueSchema.safeParse(item)
    if (parsed.success) result[key] = parsed.data
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function tls(entry: Record<string, unknown>, implied: boolean): Record<string, JsonValue> | undefined {
  const certificate = typeof entry['ca-str'] === 'string' ? entry['ca-str'] : typeof entry.certificate === 'string' ? entry.certificate : typeof entry.cert === 'string' ? entry.cert : undefined
  const certificateFingerprint = typeof entry.fingerprint === 'string' ? entry.fingerprint : typeof entry.pinSHA256 === 'string' ? entry.pinSHA256 : undefined
  const realityOptions = reality(entry['reality-opts'])
  const enabled = entry.tls === true || implied || Boolean(certificate || certificateFingerprint || realityOptions)
  const serverName = typeof entry.servername === 'string' ? entry.servername : typeof entry.sni === 'string' ? entry.sni : undefined
  const insecure = booleanAlias(entry['skip-cert-verify']) ?? booleanAlias(entry.allowInsecure)
  const alpn = Array.isArray(entry.alpn) && entry.alpn.every((value) => typeof value === 'string') ? entry.alpn as string[] : undefined
  const fingerprint = typeof entry['client-fingerprint'] === 'string' ? entry['client-fingerprint'] : undefined
  if (!enabled && !serverName && insecure === undefined && !alpn && !fingerprint && !certificate && !certificateFingerprint && !realityOptions) return undefined
  return {
    enabled,
    ...(serverName ? { serverName } : {}),
    ...(insecure === undefined ? {} : { insecure }),
    ...(alpn ? { alpn } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(certificate ? { certificate } : {}),
    ...(certificateFingerprint ? { certificateFingerprint } : {}),
    ...(realityOptions ? { reality: realityOptions } : {}),
  }
}

function transport(entry: Record<string, unknown>): Record<string, JsonValue> | undefined {
  const type = typeof entry.network === 'string' ? entry.network : undefined
  const ws = record(entry['ws-opts'])
  const grpc = record(entry['grpc-opts'])
  if (!type && !ws && !grpc) return undefined
  const result: Record<string, JsonValue> = {}
  if (type) result.type = type
  if (typeof ws?.path === 'string') result.path = ws.path
  const headers = jsonRecord(ws?.headers)
  if (headers) result.headers = headers
  if (typeof grpc?.['grpc-service-name'] === 'string') result.serviceName = grpc['grpc-service-name']
  if (typeof ws?.['max-early-data'] === 'number' || typeof ws?.['max-early-data'] === 'string') result.earlyData = ws['max-early-data'] as JsonValue
  if (typeof ws?.['early-data-header-name'] === 'string') result.earlyDataHeaderName = ws['early-data-header-name']
  if (ws) {
    const extras = Object.fromEntries(Object.entries(ws).filter(([key]) => !['path', 'headers', 'max-early-data', 'early-data-header-name'].includes(key)))
    const parsed = jsonRecord(extras)
    if (parsed && Object.keys(parsed).length > 0) result['ws-opts'] = parsed
  }
  if (grpc) {
    const extras = Object.fromEntries(Object.entries(grpc).filter(([key]) => key !== 'grpc-service-name'))
    const parsed = jsonRecord(extras)
    if (parsed && Object.keys(parsed).length > 0) result['grpc-opts'] = parsed
  }
  return result
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

function parseProxy(entry: Record<string, unknown>): ParsedNode {
  const name = requiredString(entry.name)
  const type = requiredString(entry.type).toLowerCase()
  let protocol = protocols[type]
  if (!protocol) throw new Error('Unsupported protocol')
  const server = requiredString(entry.server)
  const serverPort = port(entry.port)
  const consumed = new Set(['name', 'type', 'server', 'port', 'tls', 'servername', 'sni', 'skip-cert-verify', 'allowInsecure', 'alpn', 'client-fingerprint', 'fingerprint', 'pinSHA256', 'ca-str', 'certificate', 'cert', 'reality-opts', 'network', 'ws-opts', 'grpc-opts'])
  let credentials: Record<string, JsonValue> = {}
  let plugin: Record<string, JsonValue> | undefined

  switch (protocol) {
    case 'shadowsocks':
      credentials = { method: requiredString(entry.cipher), password: requiredString(entry.password) }
      consumed.add('cipher').add('password').add('plugin').add('plugin-opts')
      if (typeof entry.plugin === 'string' && entry.plugin) {
        plugin = { name: entry.plugin, ...(jsonRecord(entry['plugin-opts']) ? { options: jsonRecord(entry['plugin-opts'])! } : {}) }
      }
      if (requiredString(entry.cipher).startsWith('2022-blake3')) protocol = 'ss2022'
      break
    case 'vmess':
      credentials = {
        uuid: requiredString(entry.uuid),
        alterId: String(entry.alterId ?? entry['alter-id'] ?? 0),
        security: typeof entry.cipher === 'string' && entry.cipher ? entry.cipher : 'auto',
      }
      if (!UUID.test(String(credentials.uuid))) throw new Error('Invalid UUID')
      consumed.add('uuid').add('alterId').add('alter-id').add('cipher')
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
      const authentication = firstString(entry, 'password', 'auth', 'auth-str', 'auth_str')
      if (protocol !== 'hysteria' || authentication) credentials = { password: requiredString(authentication) }
      for (const key of ['password', 'auth', 'auth-str', 'auth_str']) consumed.add(key)
      break
    }
    case 'naive':
      credentials = { username: requiredString(entry.username), password: requiredString(entry.password) }
      consumed.add('username').add('password')
      break
    case 'ssr':
      credentials = {
        method: requiredString(entry.cipher),
        password: requiredString(entry.password),
        protocol: requiredString(entry.protocol),
        obfs: requiredString(entry.obfs),
      }
      // SSR parameters are valid Mihomo fields and must remain available to
      // the Loon/URI renderers instead of being silently consumed here.
      consumed.add('cipher').add('password').add('protocol').add('obfs')
      break
    case 'tuic':
      credentials = { uuid: requiredString(entry.uuid), password: requiredString(entry.password) }
      if (!UUID.test(String(credentials.uuid))) throw new Error('Invalid UUID')
      consumed.add('uuid').add('password')
      break
    case 'wireguard':
      credentials = { privateKey: requiredString(entry['private-key']), publicKey: requiredString(entry['public-key']) }
      if (typeof entry['pre-shared-key'] === 'string') credentials.preSharedKey = entry['pre-shared-key']
      consumed.add('private-key').add('public-key').add('pre-shared-key')
      break
    case 'http':
    case 'socks5':
      if (typeof entry.username === 'string') credentials.username = entry.username
      if (typeof entry.password === 'string') credentials.password = entry.password
      consumed.add('username').add('password')
      if (protocol === 'http' && entry.tls === true) protocol = 'https'
      break
  }

  const normalizedTransport = transport(entry) ?? {}
  if (['hysteria', 'hysteria2'].includes(protocol)) {
    addTransportAliases(entry, normalizedTransport, consumed, 'mport', 'ports', 'mport')
    addTransportAliases(entry, normalizedTransport, consumed, 'upMbps', 'up', 'up-mbps', 'up_mbps')
    addTransportAliases(entry, normalizedTransport, consumed, 'downMbps', 'down', 'down-mbps', 'down_mbps')
    addTransportAliases(entry, normalizedTransport, consumed, 'hopInterval', 'hop-interval', 'hop_interval')
    addTransportAliases(entry, normalizedTransport, consumed, 'obfs', 'obfs')
    addTransportAliases(entry, normalizedTransport, consumed, 'obfsPassword', 'obfs-password', 'obfs_password')
  }
  if (protocol === 'tuic') {
    addTransportAliases(entry, normalizedTransport, consumed, 'congestionControl', 'congestion-controller', 'congestion_control')
    addTransportAliases(entry, normalizedTransport, consumed, 'udpRelayMode', 'udp-relay-mode', 'udp_relay_mode')
  }

  return {
    protocol,
    displayName: name,
    server,
    port: serverPort,
    credentials,
    tls: tls(entry, ['trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'https'].includes(protocol)),
    transport: Object.keys(normalizedTransport).length > 0 ? normalizedTransport : undefined,
    plugin,
    extensions: extensions(entry, consumed),
    raw: stringify(entry).trim(),
    format: 'mihomo',
  }
}

export function parseMihomo(content: string): ImportResult {
  try {
    const document = parseDocument(content, { merge: false })
    if (document.errors.length > 0) throw new Error('Invalid YAML')
    const value: unknown = document.toJS({ maxAliasCount: 20 })
    const root = record(value)
    const entries = Array.isArray(value)
      ? value
      : root && Array.isArray(root.proxies)
        ? root.proxies
        : root && Array.isArray(root.payload)
          ? root.payload
          : isMihomoProxyEntry(root) ? [root] : null
    if (!entries) throw new Error('Invalid root')

    const nodes: ParsedNode[] = []
    const warnings: ImportResult['warnings'] = []
    for (const value of entries) {
      const entry = record(value)
      if (!entry) {
        warnings.push({ code: 'INVALID_MIHOMO_NODE', message: 'Invalid Mihomo proxy entry' })
        continue
      }
      try {
        nodes.push(parseProxy(entry))
      } catch (error) {
        const type = typeof entry.type === 'string' && /^[a-z0-9-]{1,32}$/iu.test(entry.type) ? entry.type : 'unknown'
        warnings.push({
          code: error instanceof Error && error.message === 'Unsupported protocol' ? 'UNSUPPORTED_MIHOMO_PROXY' : 'INVALID_MIHOMO_NODE',
          message: error instanceof Error && error.message === 'Unsupported protocol' ? `Unsupported Mihomo proxy type: ${type}` : 'Invalid Mihomo proxy entry',
        })
      }
    }
    return { format: 'mihomo', nodes, warnings }
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid root') throw new Error('Invalid Mihomo document')
    if (error instanceof Error && error.message === 'Invalid YAML') throw new Error('Invalid Mihomo document')
    throw new Error('Invalid Mihomo document')
  }
}
