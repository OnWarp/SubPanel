import type { JsonValue, Protocol } from '../catalog/schema.js'
import type { RenderNode } from './model.js'

const encoder = new TextEncoder()

function base64Utf8(value: string): string {
  let binary = ''
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64UrlUtf8(value: string): string {
  return base64Utf8(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function text(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function firstText(...values: (JsonValue | undefined)[]): string | undefined {
  for (const value of values) {
    const result = text(value)
    if (result !== undefined && result !== '') return result
  }
  return undefined
}

function bool(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function record(value: unknown): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function host(value: string): string {
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
}

function fragment(name: string): string {
  return name ? `#${encodeURIComponent(name)}` : ''
}

function setText(params: URLSearchParams, key: string, value: JsonValue | undefined): void {
  const result = text(value)
  if (result !== undefined && result !== '') params.set(key, result)
}

function addTls(params: URLSearchParams, tls: Record<string, JsonValue> | undefined): void {
  const value = record(tls)
  const reality = record(value.reality)
  const security = firstText(value.security) ?? (bool(value.enabled) ? 'tls' : undefined)
  setText(params, 'security', security)
  setText(params, 'sni', value.serverName)
  if (bool(value.insecure) !== undefined) params.set('insecure', String(bool(value.insecure)))
  else if (bool(value.allowInsecure) !== undefined) params.set('insecure', String(bool(value.allowInsecure)))
  if (Array.isArray(value.alpn)) params.set('alpn', value.alpn.filter((item): item is string => typeof item === 'string').join(','))
  setText(params, 'fp', value.fingerprint)
  setText(params, 'cert', firstText(value.certificate, value.ca, value['ca-str']))
  setText(params, 'pinSHA256', firstText(value.certificateFingerprint, value.pinSHA256, value.pinSha256))
  setText(params, 'pbk', firstText(reality.publicKey, reality.public_key, reality.pbk))
  setText(params, 'sid', firstText(reality.shortId, reality.short_id, reality.sid))
  setText(params, 'spx', firstText(reality.spiderX, reality.spider_x, reality.spx))
}

function addTransport(params: URLSearchParams, transport: Record<string, JsonValue> | undefined): void {
  const value = record(transport)
  const headers = record(value.headers)
  setText(params, 'type', value.type)
  setText(params, 'path', value.path)
  setText(params, 'host', headers.Host ?? headers.host)
  setText(params, 'serviceName', value.serviceName)
  setText(params, 'mode', value.mode)
  setText(params, 'headerType', value.headerType)
  setText(params, 'congestion_control', value.congestionControl)
  setText(params, 'udp_relay_mode', value.udpRelayMode)
  setText(params, 'obfs', value.obfs)
  setText(params, 'obfs-password', value.obfsPassword)
  setText(params, 'mport', value.mport ?? value.ports)
  setText(params, 'upmbps', value.upMbps ?? value.up)
  setText(params, 'downmbps', value.downMbps ?? value.down)
  setText(params, 'hop_interval', value.hopInterval)
  setText(params, 'ed', value.earlyData ?? value.maxEarlyData)
  setText(params, 'eh', value.earlyDataHeaderName)
}

function addPlugin(params: URLSearchParams, plugin: Record<string, JsonValue> | undefined): void {
  const value = record(plugin)
  const name = text(value.name)
  if (!name) return
  const options = record(value.options)
  const parts = [name]
  if (typeof value.options === 'string' && value.options) parts.push(value.options)
  for (const [key, option] of Object.entries(options)) {
    if (typeof option === 'boolean') parts.push(option ? key : `${key}=false`)
    else if (typeof option === 'string' || typeof option === 'number') parts.push(`${key}=${option}`)
    else parts.push(`${key}=${JSON.stringify(option)}`)
  }
  params.set('plugin', parts.join(';'))
}

function addExtensions(params: URLSearchParams, node: RenderNode): void {
  for (const [key, value] of Object.entries(node.extensions)) {
    if (key === 'sourceScheme') continue
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key)) continue
    const serializedKey = key.startsWith('x-') ? key : `x-${key}`
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') params.set(serializedKey, String(value))
    else if (Array.isArray(value)) params.set(serializedKey, value.map(String).join(','))
  }
}

const protocolSchemes: Record<Protocol, readonly string[]> = {
  shadowsocks: ['ss'],
  ss2022: ['ss'],
  ssr: ['ssr'],
  vmess: ['vmess', 'v2rayn'],
  vless: ['vless', 'v2rayn'],
  trojan: ['trojan', 'trojan-go'],
  hysteria: ['hysteria', 'hy'],
  hysteria2: ['hysteria2', 'hy2'],
  tuic: ['tuic'],
  wireguard: ['wireguard'],
  anytls: ['anytls'],
  naive: ['naive', 'naive+https'],
  snell: ['snell'],
  shadowtls: ['shadowtls', 'shadow-tls'],
  http: ['http'],
  https: ['https'],
  socks5: ['socks', 'socks5'],
}

function rawScheme(raw: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(raw)
  return match?.[1].toLowerCase()
}

function rawMatchesProtocol(raw: string, protocol: Protocol): boolean {
  const scheme = rawScheme(raw)
  if (!scheme) return false
  if (scheme !== 'v2rayn') return protocolSchemes[protocol].includes(scheme)
  const wrapped = /^v2rayn:\/\/([^/?#]+)/iu.exec(raw)?.[1]?.toLowerCase()
  return wrapped !== undefined && protocolSchemes[protocol].includes(wrapped)
}

/** Return an original URI variant only when it still describes this protocol. */
export function rawShareUri(node: RenderNode): string | null {
  return node.rawVariants
    .map((variant) => variant.raw.trim())
    .find((raw) => rawMatchesProtocol(raw, node.protocol)) ?? null
}

function ssrShareUri(node: RenderNode): string | null {
  const credentials = node.credentials
  const server = node.server
  const port = String(node.port)
  const protocol = text(credentials.protocol)
  const method = text(credentials.method)
  const obfs = text(credentials.obfs)
  const password = text(credentials.password)
  if (!server || !protocol || !method || !obfs || password === undefined) return null
  const main = `${host(server)}:${port}:${protocol}:${method}:${obfs}:${base64UrlUtf8(password)}`
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(node.extensions)) {
    const outputKey = key === 'obfs-param' ? 'obfsparam' : key === 'protocol-param' ? 'protoparam' : key
    if (!/^(?:obfsparam|protoparam|remarks|group)$/u.test(outputKey)) continue
    const scalar = text(value)
    if (scalar !== undefined) query.set(outputKey, base64UrlUtf8(scalar))
  }
  const suffix = query.toString()
  return `ssr://${base64UrlUtf8(`${main}${suffix ? `/?${suffix}` : ''}`)}`
}

function vlessLike(node: RenderNode, scheme: string): string | null {
  const credentials = node.credentials
  const tls = record(node.tls)
  const transport = record(node.transport)
  const uuid = text(credentials.uuid)
  if (!uuid) return null
  const params = new URLSearchParams()
  if (scheme === 'vless') setText(params, 'encryption', credentials.encryption ?? 'none')
  setText(params, 'flow', credentials.flow ?? node.extensions.flow)
  addTls(params, tls)
  addTransport(params, transport)
  addExtensions(params, node)
  return `${scheme}://${encodeURIComponent(uuid)}@${host(node.server)}:${node.port}?${params.toString()}${fragment(node.displayName)}`
}

export function serializeShareUri(node: RenderNode): string | null {
  const server = host(node.server)
  const credentials = node.credentials
  const tls = record(node.tls)
  const transport = record(node.transport)
  const protocol = node.protocol

  if (protocol === 'ssr') return ssrShareUri(node) ?? rawShareUri(node)
  if (protocol === 'wireguard' || protocol === 'snell' || protocol === 'shadowtls') return rawShareUri(node)

  if (protocol === 'vless') return vlessLike(node, 'vless')

  if (protocol === 'shadowsocks' || protocol === 'ss2022') {
    const method = text(credentials.method)
    const password = text(credentials.password)
    if (!method || !password) return null
    const params = new URLSearchParams()
    addPlugin(params, node.plugin)
    addExtensions(params, node)
    const query = params.toString()
    return `ss://${base64Utf8(`${method}:${password}`)}@${server}:${node.port}${query ? `/?${query}` : ''}${fragment(node.displayName)}`
  }

  if (protocol === 'vmess') {
    const uuid = text(credentials.uuid)
    if (!uuid) return null
    const reality = record(tls.reality)
    const value: Record<string, string | boolean> = {
      v: '2', ps: node.displayName, add: node.server, port: String(node.port), id: uuid,
      aid: text(credentials.alterId) ?? '0', scy: text(credentials.security) ?? 'auto',
      net: text(transport.type) ?? 'tcp', type: text(transport.headerType) ?? 'none',
      host: text(record(transport.headers).Host) ?? '', path: text(transport.path) ?? '',
      tls: bool(tls.enabled) ? 'tls' : '', sni: text(tls.serverName) ?? '',
      alpn: Array.isArray(tls.alpn) ? tls.alpn.filter((item): item is string => typeof item === 'string').join(',') : '',
      fp: text(tls.fingerprint) ?? '', flow: text(credentials.flow) ?? '',
      pbk: firstText(reality.publicKey, reality.public_key, reality.pbk) ?? '', sid: firstText(reality.shortId, reality.short_id, reality.sid) ?? '',
      spx: firstText(reality.spiderX, reality.spider_x, reality.spx) ?? '', cert: firstText(tls.certificate, tls.ca, tls['ca-str']) ?? '',
      ed: text(transport.earlyData ?? transport.maxEarlyData) ?? '', eh: text(transport.earlyDataHeaderName) ?? '',
    }
    const insecure = bool(tls.insecure) ?? bool(tls.allowInsecure)
    if (insecure !== undefined) value.allowInsecure = insecure
    const pin = firstText(tls.certificateFingerprint, tls.pinSHA256, tls.pinSha256)
    if (pin) value.pinSHA256 = pin
    addExtensionsToObject(value, node)
    return `vmess://${base64Utf8(JSON.stringify(value))}`
  }

  if (protocol === 'hysteria' || protocol === 'hysteria2' || protocol === 'anytls' || protocol === 'naive' || protocol === 'trojan') {
    const password = text(credentials.password)
    if (!password && protocol !== 'hysteria') return null
    const sourceScheme = text(node.extensions.sourceScheme)?.toLowerCase()
    const scheme = protocol === 'naive' ? 'naive+https' : sourceScheme === 'trojan-go' ? 'trojan-go' : protocol
    const params = new URLSearchParams()
    addTls(params, tls)
    addTransport(params, transport)
    addExtensions(params, node)
    const username = protocol === 'naive' ? text(credentials.username) : undefined
    if (protocol === 'naive' && (!username || !password)) return null
    const authority = protocol === 'naive'
      ? `${encodeURIComponent(username!)}:${encodeURIComponent(password!)}`
      : password ? encodeURIComponent(password) : ''
    return `${scheme}://${authority}@${server}:${node.port}?${params.toString()}${fragment(node.displayName)}`
  }

  if (protocol === 'tuic') {
    const uuid = text(credentials.uuid)
    const password = text(credentials.password)
    if (!uuid || password === undefined) return null
    const params = new URLSearchParams()
    addTls(params, tls)
    addTransport(params, transport)
    addExtensions(params, node)
    return `tuic://${encodeURIComponent(uuid)}:${encodeURIComponent(password)}@${server}:${node.port}?${params.toString()}${fragment(node.displayName)}`
  }

  if (protocol === 'http' || protocol === 'https' || protocol === 'socks5') {
    const username = text(credentials.username)
    const password = text(credentials.password)
    const authority = username === undefined ? '' : `${encodeURIComponent(username)}${password === undefined ? '' : `:${encodeURIComponent(password)}`}@`
    const params = new URLSearchParams()
    addTls(params, tls)
    addTransport(params, transport)
    addExtensions(params, node)
    const scheme = protocol === 'socks5' ? 'socks5' : protocol
    return `${scheme}://${authority}${server}:${node.port}${params.toString() ? `?${params.toString()}` : ''}${fragment(node.displayName)}`
  }

  return null
}

function addExtensionsToObject(target: Record<string, string | boolean>, node: RenderNode): void {
  for (const [key, value] of Object.entries(node.extensions)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') target[key.startsWith('x-') ? key : `x-${key}`] = String(value)
  }
}
