import type { ImportFormat, JsonValue, Protocol } from '../catalog/schema.js'
import { decodeBase64Utf8 } from './base64.js'
import type { ImportResult, ParsedNode } from './model.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const schemeProtocols: Record<string, Protocol> = {
  vless: 'vless',
  trojan: 'trojan',
  hysteria: 'hysteria',
  hy: 'hysteria',
  hysteria2: 'hysteria2',
  hy2: 'hysteria2',
  tuic: 'tuic',
  'trojan-go': 'trojan',
  naive: 'naive',
  'naive+https': 'naive',
  ssr: 'ssr',
  anytls: 'anytls',
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
}

const format: ImportFormat = 'uri-list'

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('Invalid percent encoding')
  }
}

function parsePort(value: string, fallback?: number): number {
  const port = value === '' && fallback ? fallback : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
  return port
}

function hostname(url: URL): string {
  const value = url.hostname.replace(/^\[|\]$/gu, '')
  if (!value) throw new Error('Missing host')
  return value
}

function displayName(url: URL, fallback: string): string {
  return url.hash ? decodeComponent(url.hash.slice(1)) || fallback : fallback
}

function take(params: URLSearchParams, ...names: string[]): string | undefined {
  for (const name of names) {
    if (!params.has(name)) continue
    const value = params.get(name) ?? ''
    params.delete(name)
    return value
  }
  return undefined
}

function takeBoolean(params: URLSearchParams, ...names: string[]): boolean | undefined {
  const value = take(params, ...names)
  if (value === undefined) return undefined
  if (['1', 'true'].includes(value.toLowerCase())) return true
  if (['0', 'false'].includes(value.toLowerCase())) return false
  throw new Error('Invalid boolean')
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function decodeShadowrocketAuthority(token: string): { uuid: string; server: string; port: number } | null {
  const decoded = decodeBase64Utf8(token)
  if (!decoded || !decoded.includes('@')) return null
  const match = /^(?:[^@]*:)?([^@]+)@(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(decoded)
  if (!match) return null
  const port = Number(match[4])
  const server = match[2] ?? match[3]
  if (!server || !match[1] || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { uuid: match[1], server, port }
}

function remainingQuery(params: URLSearchParams): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    result[key] = values.length === 1 ? values[0] : values
  }
  return result
}

function tlsFromQuery(params: URLSearchParams, implied = false): Record<string, JsonValue> | undefined {
  const security = take(params, 'security')
  const tlsFlag = takeBoolean(params, 'tls')
  const serverName = take(params, 'sni', 'peer')
  const insecure = takeBoolean(params, 'insecure', 'allowInsecure')
  const alpn = take(params, 'alpn')
  const fingerprint = take(params, 'fp', 'fingerprint')
  const certificate = take(params, 'cert', 'certificate', 'ca', 'ca-str', 'tls_certificate', 'tls-certificate')
  const certificateFingerprint = take(params, 'pinSHA256', 'pinSha256', 'certificateFingerprint', 'certificate_public_key_sha256')
  const publicKey = take(params, 'pbk', 'publicKey', 'public_key')
  const shortId = take(params, 'sid', 'shortId', 'short_id')
  const spiderX = take(params, 'spx', 'spiderX', 'spider_x')
  if (!implied && tlsFlag === undefined && !security && serverName === undefined && insecure === undefined && alpn === undefined && fingerprint === undefined && certificate === undefined && certificateFingerprint === undefined && publicKey === undefined && shortId === undefined && spiderX === undefined) {
    return undefined
  }

  const tls: Record<string, JsonValue> = { enabled: implied || tlsFlag === true || (security !== undefined && security !== 'none') }
  if (security && security !== 'tls') tls.security = security
  if (serverName) tls.serverName = serverName
  if (insecure !== undefined) tls.insecure = insecure
  if (alpn) tls.alpn = alpn.split(',').map((value) => value.trim()).filter(Boolean)
  if (fingerprint) tls.fingerprint = fingerprint
  if (certificate) tls.certificate = certificate
  if (certificateFingerprint) tls.certificateFingerprint = certificateFingerprint
  if (publicKey || shortId || spiderX || security === 'reality') {
    tls.reality = {
      ...(publicKey ? { publicKey } : {}),
      ...(shortId ? { shortId } : {}),
      ...(spiderX ? { spiderX } : {}),
    }
  }
  return tls
}

function transportFromQuery(params: URLSearchParams): Record<string, JsonValue> | undefined {
  const type = take(params, 'type', 'network')
  const path = take(params, 'path')
  const host = take(params, 'host')
  const serviceName = take(params, 'serviceName', 'service_name')
  const mode = take(params, 'mode')
  const headerType = take(params, 'headerType')
  const congestionControl = take(params, 'congestion_control', 'congestionControl')
  const udpRelayMode = take(params, 'udp_relay_mode', 'udpRelayMode')
  const obfs = take(params, 'obfs')
  const obfsParam = take(params, 'obfsParam', 'obfs-param')
  const obfsPassword = take(params, 'obfs-password', 'obfsPassword')
  const mport = take(params, 'mport', 'ports')
  const upMbps = take(params, 'upmbps', 'up')
  const downMbps = take(params, 'downmbps', 'down')
  const hopInterval = take(params, 'hop_interval', 'hopInterval', 'keepalive')
  const earlyData = take(params, 'ed', 'earlyData')
  const earlyDataHeaderName = take(params, 'eh', 'earlyDataHeaderName', 'early-data-header-name')
  if (!type && path === undefined && host === undefined && serviceName === undefined && mode === undefined && headerType === undefined && congestionControl === undefined && udpRelayMode === undefined && obfs === undefined && obfsParam === undefined && obfsPassword === undefined && mport === undefined && upMbps === undefined && downMbps === undefined && hopInterval === undefined && earlyData === undefined && earlyDataHeaderName === undefined) {
    return undefined
  }

  const transport: Record<string, JsonValue> = {}
  const normalizedObfs = obfs?.toLowerCase()
  if (type) transport.type = type
  else if (normalizedObfs === 'websocket') transport.type = 'ws'
  if (path) transport.path = path
  if (host) transport.headers = { Host: host }
  if (obfsParam) {
    if (obfsParam.startsWith('/')) transport.path = transport.path ?? obfsParam
    else transport.headers = { ...(recordValue(transport.headers)), Host: obfsParam }
  }
  if (serviceName) transport.serviceName = serviceName
  if (mode) transport.mode = mode
  if (headerType && headerType !== 'none') transport.headerType = headerType
  if (congestionControl) transport.congestionControl = congestionControl
  if (udpRelayMode) transport.udpRelayMode = udpRelayMode
  if (obfs && obfs !== 'none') transport.obfs = obfs
  if (obfsPassword) transport.obfsPassword = obfsPassword
  if (mport) transport.mport = mport
  if (upMbps) transport.upMbps = upMbps
  if (downMbps) transport.downMbps = downMbps
  if (hopInterval) transport.hopInterval = hopInterval
  if (earlyData) transport.earlyData = earlyData
  if (earlyDataHeaderName) transport.earlyDataHeaderName = earlyDataHeaderName
  return transport
}

function parsePlugin(value: string | undefined): Record<string, JsonValue> | undefined {
  if (!value) return undefined
  const [name, ...parts] = value.split(';')
  if (!name) return undefined
  const options: Record<string, JsonValue> = {}
  for (const part of parts) {
    const separator = part.indexOf('=')
    if (separator === -1) options[part] = true
    else options[part.slice(0, separator)] = part.slice(separator + 1)
  }
  return Object.keys(options).length === 0 ? { name } : { name, options }
}

function parseShadowsocks(raw: string): ParsedNode {
  const hashIndex = raw.indexOf('#')
  const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex + 1)
  const withoutFragment = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
  const queryIndex = withoutFragment.indexOf('?')
  const query = queryIndex === -1 ? '' : withoutFragment.slice(queryIndex + 1)
  let authority = (queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex)).slice('ss://'.length).replace(/\/$/u, '')

  let userInfo: string
  const at = authority.lastIndexOf('@')
  if (at === -1) {
    const decoded = decodeBase64Utf8(authority)
    if (!decoded) throw new Error('Invalid SIP002 payload')
    const decodedAt = decoded.lastIndexOf('@')
    if (decodedAt === -1) throw new Error('Invalid SIP002 payload')
    userInfo = decoded.slice(0, decodedAt)
    authority = decoded.slice(decodedAt + 1)
  } else {
    userInfo = decodeComponent(authority.slice(0, at))
    authority = authority.slice(at + 1)
    if (!userInfo.includes(':')) userInfo = decodeBase64Utf8(userInfo) ?? ''
  }

  const separator = userInfo.indexOf(':')
  if (separator < 1 || separator === userInfo.length - 1) throw new Error('Missing Shadowsocks credentials')
  const method = userInfo.slice(0, separator)
  const password = userInfo.slice(separator + 1)
  const endpoint = new URL(`ss://placeholder@${authority}`)
  const server = hostname(endpoint)
  const port = parsePort(endpoint.port)
  const params = new URLSearchParams(query)
  const plugin = parsePlugin(take(params, 'plugin'))

  return {
    protocol: method.startsWith('2022-blake3') ? 'ss2022' : 'shadowsocks',
    displayName: fragment ? decodeComponent(fragment) || `shadowsocks ${server}` : `shadowsocks ${server}`,
    server,
    port,
    credentials: { method, password },
    plugin,
    extensions: remainingQuery(params),
    raw,
    format,
  }
}

function parseSsr(raw: string): ParsedNode {
  const payload = decodeBase64Utf8(raw.slice('ssr://'.length))
  if (!payload) throw new Error('Invalid SSR payload')
  const [main, queryText = ''] = payload.split('/?', 2)
  const parts = main.split(':')
  if (parts.length < 6) throw new Error('Invalid SSR payload')
  const serverPart = parts.slice(0, -5).join(':').replace(/^\[|\]$/gu, '')
  const [portPart, protocolPart, methodPart, obfsPart, passwordPart] = parts.slice(-5)
  const server = decodeComponent(serverPart)
  const port = parsePort(portPart)
  const password = decodeBase64Utf8(passwordPart) ?? decodeComponent(passwordPart)
  if (!server || !password) throw new Error('Invalid SSR credentials')

  const query = new URLSearchParams(queryText.replace(/&amp;/gu, '&'))
  const extensions: Record<string, JsonValue> = {}
  for (const key of ['obfsparam', 'protoparam', 'remarks', 'group']) {
    const value = query.get(key)
    if (value !== null) extensions[key] = decodeBase64Utf8(value) ?? decodeComponent(value)
  }
  for (const [key, value] of query.entries()) if (!(key in extensions)) extensions[key] = value
  return {
    protocol: 'ssr',
    displayName: typeof extensions.remarks === 'string' && extensions.remarks ? extensions.remarks : `ssr ${server}`,
    server,
    port,
    credentials: { protocol: protocolPart, method: methodPart, obfs: obfsPart, password },
    extensions,
    raw,
    format: 'uri-list',
  }
}

const v2raynProtocol: Record<string, Protocol> = {
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  hysteria: 'hysteria',
  hysteria2: 'hysteria2',
  hy2: 'hysteria2',
  tuic: 'tuic',
  anytls: 'anytls',
  naive: 'naive',
  ss: 'shadowsocks',
  shadowsocks: 'shadowsocks',
  ss2022: 'ss2022',
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseV2rayn(raw: string): ParsedNode {
  const match = /^v2rayn:\/\/([^/]+)\/(.+)$/iu.exec(raw)
  if (!match) throw new Error('Invalid v2rayN payload')
  const kind = match[1].toLowerCase()
  let protocol = v2raynProtocol[kind]
  if (!protocol) throw new Error('Unsupported v2rayN protocol')
  const source = objectValue(JSON.parse(decodeBase64Utf8(match[2].trim()) ?? ''))
  const server = scalar(source.Address ?? source.address ?? source.Add ?? source.add)
  const port = scalar(source.Port ?? source.port)
  if (!server || !port) throw new Error('Missing v2rayN endpoint')
  const numberPort = parsePort(port)
  const name = scalar(source.Remarks ?? source.remarks ?? source.Name ?? source.name) || `${protocol} ${server}`
  const uuid = scalar(source.Id ?? source.id ?? source.UUID ?? source.uuid ?? source.Uuid ?? (protocol === 'tuic' ? source.Username ?? source.username : undefined))
  const password = scalar(source.Password ?? source.password ?? source.Auth ?? source.auth ?? source.AuthStr ?? source.auth_str ?? source['auth-str'])
  const username = scalar(source.Username ?? source.username)
  const credentials: Record<string, JsonValue> = {}
  if (uuid) credentials.uuid = uuid
  if (password) credentials.password = password
  if (username) credentials.username = username
  const method = scalar(source.Method ?? source.method ?? source.Cipher ?? source.cipher)
  if (protocol === 'shadowsocks' || protocol === 'ss2022') {
    if (!method || !password) throw new Error('Missing Shadowsocks credentials')
    credentials.method = method
    if (method.startsWith('2022-blake3')) protocol = 'ss2022'
  }
  const pluginName = scalar(source.Plugin ?? source.plugin)
  const pluginOptions = scalar(source.PluginOptions ?? source.pluginOptions ?? source.plugin_opts)
  const plugin = pluginName
    ? parsePlugin(pluginOptions ? `${pluginName};${pluginOptions}` : pluginName)
    : undefined
  if (protocol === 'naive' && (!username || !password)) throw new Error('Missing NaiveProxy credentials')
  if (protocol === 'anytls' && !password) throw new Error('Missing AnyTLS password')
  if ((protocol === 'vmess' || protocol === 'vless') && (!uuid || !UUID.test(uuid))) throw new Error('Invalid UUID')
  if (protocol === 'tuic' && (!uuid || !UUID.test(uuid) || !password)) throw new Error('Missing TUIC credentials')
  if ((protocol === 'trojan' || protocol === 'hysteria2') && !password) throw new Error('Missing password')
  if (protocol === 'vmess') {
    credentials.alterId = scalar(source.AlterId ?? source.aid ?? source.Aid) ?? '0'
    credentials.security = scalar(source.Security ?? source.scy) ?? 'auto'
  }
  if (protocol === 'vless') credentials.encryption = scalar(source.Encryption ?? source.encryption) ?? 'none'

  const streamSecurity = (scalar(source.StreamSecurity ?? source.streamSecurity ?? source.Security ?? source.security) ?? '').toLowerCase()
  const sni = scalar(source.Sni ?? source.sni ?? source.ServerName ?? source.serverName)
  const cert = scalar(source.Cert ?? source.cert ?? source.Certificate ?? source.certificate)
  const fingerprint = scalar(source.Fingerprint ?? source.fp ?? source.Fp)
  const publicKey = scalar(source.PublicKey ?? source.publicKey ?? source.pbk)
  const shortId = scalar(source.ShortId ?? source.shortId ?? source.sid)
  const spiderX = scalar(source.SpiderX ?? source.spiderX ?? source.spx)
  const insecureValue = scalar(source.AllowInsecure ?? source.allowInsecure ?? source.Insecure ?? source.insecure)
  const insecure = insecureValue === undefined ? undefined : ['1', 'true'].includes(insecureValue.toLowerCase())
  const tls: Record<string, JsonValue> = {}
  if (streamSecurity || sni || cert || fingerprint || insecure !== undefined || publicKey || shortId || spiderX || ['trojan', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'anytls', 'naive', 'https'].includes(kind)) {
    tls.enabled = true
    if (streamSecurity) tls.security = streamSecurity
    if (sni) tls.serverName = sni
    if (cert) tls.certificate = cert
    if (fingerprint) tls.fingerprint = fingerprint
    if (insecure !== undefined) tls.insecure = insecure
    if (publicKey || shortId || spiderX || streamSecurity === 'reality') {
      tls.reality = { ...(publicKey ? { publicKey } : {}), ...(shortId ? { shortId } : {}), ...(spiderX ? { spiderX } : {}) }
    }
  }

  const extra = objectValue(source.ProtoExtraObj ?? source.protoExtraObj ?? source.Extra ?? source.extra)
  const network = (scalar(source.Network ?? source.network ?? source.Net ?? source.net) ?? 'tcp').toLowerCase()
  const path = scalar(source.Path ?? source.path)
  const hostHeader = scalar(source.Host ?? source.host ?? extra.Host ?? extra.host)
  const serviceName = scalar(source.ServiceName ?? source.serviceName ?? extra.ServiceName ?? extra.serviceName)
  const transport: Record<string, JsonValue> = { type: network === 'raw' ? 'tcp' : network }
  if (path) transport.path = path
  if (hostHeader) transport.headers = { Host: hostHeader }
  if (serviceName) transport.serviceName = serviceName
  if (protocol === 'tuic') {
    const congestion = scalar(extra.CongestionControl ?? extra.congestionControl ?? source.CongestionControl ?? source.congestionControl)
    if (congestion) transport.congestionControl = congestion
  }
  if (protocol === 'hysteria2') {
    for (const [target, keys] of Object.entries({
      mport: ['Ports', 'ports', 'Mport', 'mport'],
      upMbps: ['UpMbps', 'upMbps', 'up'],
      downMbps: ['DownMbps', 'downMbps', 'down'],
      hopInterval: ['HopInterval', 'hopInterval'],
      obfs: ['Obfs', 'obfs'],
      obfsPassword: ['ObfsPassword', 'obfsPassword'],
    })) {
      const value = scalar(keys.map((key) => extra[key] ?? source[key]).find((candidate) => candidate !== undefined))
      if (value) transport[target] = value
    }
  }

  const known = new Set([
    'Address', 'address', 'Add', 'add', 'Port', 'port', 'Remarks', 'remarks', 'Name', 'name', 'Id', 'id', 'UUID', 'uuid', 'Uuid',
    'Password', 'password', 'Username', 'username', 'AlterId', 'aid', 'Aid', 'Security', 'security', 'scy', 'Encryption', 'encryption',
    'StreamSecurity', 'streamSecurity', 'Sni', 'sni', 'ServerName', 'serverName', 'Cert', 'cert', 'Certificate', 'certificate',
    'Fingerprint', 'fp', 'Fp', 'PublicKey', 'publicKey', 'pbk', 'ShortId', 'shortId', 'sid', 'SpiderX', 'spiderX', 'spx',
    'AllowInsecure', 'allowInsecure', 'Insecure', 'insecure', 'Flow', 'flow', 'Network', 'network', 'Net', 'net', 'Path', 'path', 'Host', 'host',
    'ServiceName', 'serviceName', 'ProtoExtraObj', 'protoExtraObj', 'Extra', 'extra', 'CongestionControl', 'congestionControl',
    'Auth', 'auth', 'AuthStr', 'auth_str', 'auth-str', 'Method', 'method', 'Cipher', 'cipher',
    'Plugin', 'plugin', 'PluginOptions', 'pluginOptions', 'plugin_opts',
  ])
  const extensions: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(source)) if (!known.has(key) && value !== undefined) extensions[key] = value as JsonValue
  const knownExtra = new Set([
    'Host', 'host', 'ServiceName', 'serviceName', 'CongestionControl', 'congestionControl',
    'Ports', 'ports', 'Mport', 'mport', 'UpMbps', 'upMbps', 'up', 'DownMbps', 'downMbps', 'down',
    'HopInterval', 'hopInterval', 'Obfs', 'obfs', 'ObfsPassword', 'obfsPassword',
  ])
  const extraFields = Object.fromEntries(Object.entries(extra).filter(([key]) => !knownExtra.has(key)))
  if (Object.keys(extraFields).length > 0) extensions.ProtoExtraObj = extraFields as Record<string, JsonValue>
  if (scalar(source.Flow ?? source.flow)) credentials.flow = scalar(source.Flow ?? source.flow)!
  return {
    protocol,
    displayName: name,
    server,
    port: numberPort,
    credentials,
    tls: Object.keys(tls).length > 0 ? tls : undefined,
    transport: Object.keys(transport).length > 0 ? transport : undefined,
    plugin,
    extensions,
    raw,
    format: 'v2rayn',
  }
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}`)
  return value
}

function parseVmess(raw: string): ParsedNode {
  const decoded = decodeBase64Utf8(raw.slice('vmess://'.length))
  if (!decoded) throw new Error('Invalid VMess payload')
  const value: unknown = JSON.parse(decoded)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid VMess payload')
  const source = value as Record<string, unknown>
  const server = stringField(source.add, 'address')
  const uuid = stringField(source.id, 'UUID')
  if (!UUID.test(uuid)) throw new Error('Invalid UUID')
  const port = parsePort(String(source.port ?? ''))
  const display = typeof source.ps === 'string' && source.ps ? source.ps : `vmess ${server}`
  const credentials: Record<string, JsonValue> = {
    uuid,
    alterId: String(source.aid ?? '0'),
    security: typeof source.scy === 'string' && source.scy ? source.scy : 'auto',
  }

  const tls: Record<string, JsonValue> = {}
  if (source.tls === 'tls') tls.enabled = true
  if (typeof source.sni === 'string' && source.sni) tls.serverName = source.sni
  if (typeof source.alpn === 'string' && source.alpn) tls.alpn = source.alpn.split(',').map((item) => item.trim()).filter(Boolean)
  if (typeof source.fp === 'string' && source.fp) tls.fingerprint = source.fp
  if (typeof source.cert === 'string' && source.cert) tls.certificate = source.cert
  if (typeof source.pinSHA256 === 'string' && source.pinSHA256) tls.certificateFingerprint = source.pinSHA256
  if (typeof source.allowInsecure === 'boolean') tls.insecure = source.allowInsecure
  const reality = {
    ...(typeof source.pbk === 'string' && source.pbk ? { publicKey: source.pbk } : {}),
    ...(typeof source.sid === 'string' && source.sid ? { shortId: source.sid } : {}),
    ...(typeof source.spx === 'string' && source.spx ? { spiderX: source.spx } : {}),
  }
  if (Object.keys(reality).length > 0) tls.reality = reality

  const transport: Record<string, JsonValue> = {}
  if (typeof source.net === 'string' && source.net) transport.type = source.net
  if (typeof source.path === 'string' && source.path) transport.path = source.path
  if (typeof source.host === 'string' && source.host) transport.headers = { Host: source.host }
  if (typeof source.type === 'string' && source.type && source.type !== 'none') transport.headerType = source.type
  if (typeof source.ed === 'string' || typeof source.ed === 'number') transport.earlyData = String(source.ed)
  if (typeof source.eh === 'string' && source.eh) transport.earlyDataHeaderName = source.eh

  if (typeof source.flow === 'string' && source.flow) credentials.flow = source.flow

  const known = new Set(['v', 'ps', 'add', 'port', 'id', 'aid', 'scy', 'net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp', 'flow', 'pbk', 'sid', 'spx', 'cert', 'pinSHA256', 'allowInsecure', 'ed', 'eh'])
  const extensions = Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key))) as Record<string, JsonValue>
  return {
    protocol: 'vmess',
    displayName: display,
    server,
    port,
    credentials,
    tls: Object.keys(tls).length > 0 ? tls : undefined,
    transport: Object.keys(transport).length > 0 ? transport : undefined,
    extensions,
    raw,
    format,
  }
}

function parseStandard(raw: string, scheme: string): ParsedNode {
  const protocol = schemeProtocols[scheme]
  if (!protocol) throw new Error('Unsupported scheme')
  const url = new URL(raw)
  let server = hostname(url)
  const defaultPort = protocol === 'https' || ['naive', 'naive+https', 'trojan', 'trojan-go', 'hysteria', 'hy', 'hysteria2', 'hy2', 'tuic', 'anytls'].includes(scheme)
    ? 443
    : protocol === 'http' ? 80 : undefined
  let port = url.port ? parsePort(url.port, defaultPort) : defaultPort ?? 0
  let username = decodeComponent(url.username)
  const password = decodeComponent(url.password)
  const params = new URLSearchParams(url.search)
  if (protocol === 'vless' && (!UUID.test(username) || !url.port)) {
    const rawAuthority = /^\w+:\/\/([^/?#]+)/u.exec(raw)?.[1]
    for (const token of [rawAuthority, url.hostname, url.username].filter((value): value is string => Boolean(value))) {
      const decoded = decodeShadowrocketAuthority(token)
      if (!decoded) continue
      server = decoded.server
      port = decoded.port
      username = decoded.uuid
      break
    }
  }
  if (!port) throw new Error('Invalid port')
  const remark = take(params, 'remarks', 'remark')
  let credentials: Record<string, string> = {}
  let tls: Record<string, JsonValue> | undefined
  let transport: Record<string, JsonValue> | undefined

  switch (protocol) {
    case 'vless': {
      if (!UUID.test(username)) throw new Error('Invalid UUID')
      credentials = { uuid: username, encryption: take(params, 'encryption') || 'none' }
      const flow = take(params, 'flow')
      if (flow) credentials.flow = flow
      tls = tlsFromQuery(params)
      transport = transportFromQuery(params)
      break
    }
    case 'trojan': {
      if (!username) throw new Error('Missing password')
      credentials = { password: username }
      tls = tlsFromQuery(params, true)
      transport = transportFromQuery(params)
      break
    }
    case 'naive': {
      if (!username || !password) throw new Error('Missing NaiveProxy credentials')
      credentials = { username, password }
      tls = tlsFromQuery(params, true)
      transport = transportFromQuery(params)
      break
    }
    case 'hysteria2': {
      const authentication = username || take(params, 'auth')
      if (!authentication) throw new Error('Missing password')
      credentials = { password: authentication }
      tls = tlsFromQuery(params, true)
      transport = transportFromQuery(params)
      break
    }
    case 'hysteria': {
      const authentication = username || take(params, 'auth')
      if (authentication) credentials = { password: authentication }
      tls = tlsFromQuery(params, true)
      transport = transportFromQuery(params)
      break
    }
    case 'tuic': {
      if (!UUID.test(username) || !password) throw new Error('Missing TUIC credentials')
      credentials = { uuid: username, password }
      tls = tlsFromQuery(params, true)
      transport = transportFromQuery(params)
      break
    }
    case 'anytls': {
      if (!username) throw new Error('Missing password')
      credentials = { password: username }
      tls = tlsFromQuery(params, true)
      transport = transportFromQuery(params)
      break
    }
    case 'http':
    case 'https':
    case 'socks5': {
      credentials = {}
      if (username) credentials.username = username
      if (password) credentials.password = password
      tls = tlsFromQuery(params, protocol === 'https')
      transport = transportFromQuery(params)
      break
    }
  }

  const extensions = remainingQuery(params)
  if (scheme === 'trojan-go') extensions.sourceScheme = scheme
  return {
    protocol,
    displayName: remark || displayName(url, `${protocol} ${server}`),
    server,
    port,
    credentials,
    tls,
    transport,
    extensions,
    raw,
    format,
  }
}

export function parseShareUri(raw: string): ParsedNode {
  const match = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(raw.trim())
  if (!match) throw new Error('Missing URI scheme')
  const scheme = match[1].toLowerCase()
  if (scheme === 'v2rayn') return parseV2rayn(raw.trim())
  if (scheme === 'ss') return parseShadowsocks(raw.trim())
  if (scheme === 'ssr') return parseSsr(raw.trim())
  if (scheme === 'vmess') return parseVmess(raw.trim())
  return parseStandard(raw.trim(), scheme)
}

function coalesceUriLines(lines: string[]): string[] {
  const output: string[] = []
  for (const line of lines) {
    const previous = output[output.length - 1]
    const fragment = /^[A-Za-z0-9+/=_-]{8,}$/u.test(line) && !line.includes('://')
    if (previous && fragment && /^(?:v2rayn|vmess):\/\//iu.test(previous)) {
      output[output.length - 1] = previous + line
    } else {
      output.push(line)
    }
  }
  return output
}

export function parseUriList(content: string): ImportResult {
  const nodes: ParsedNode[] = []
  const warnings: ImportResult['warnings'] = []
  const lines = coalesceUriLines(content.split(/\r?\n/u).map((line) => line.replace(/^\uFEFF/u, '').trim()).filter(Boolean))
  for (const [index, line] of lines.entries()) {
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(line)?.[1].toLowerCase() ?? 'unknown'
    try {
      nodes.push(parseShareUri(line))
    } catch {
      warnings.push({ code: 'INVALID_URI', message: `Unable to parse ${scheme} URI`, line: index + 1 })
    }
  }
  return { format, nodes, warnings }
}
