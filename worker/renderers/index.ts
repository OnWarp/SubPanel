import { stringify as stringifyYaml } from 'yaml'
import type { JsonValue, Protocol } from '../catalog/schema.js'
import type { RenderClient, RenderDiagnostic, RenderNode, RenderResult } from './model.js'
import { CLIENT_IDS } from './model.js'
import { rawShareUri, serializeShareUri } from './uri.js'

export { CLIENT_IDS, rawShareUri, serializeShareUri }
export type { RenderClient, RenderDiagnostic, RenderNode, RenderResult }

const protocolNames: Record<Protocol, string> = {
  shadowsocks: 'ss', ss2022: 'ss', ssr: 'ssr', vmess: 'vmess', vless: 'vless', trojan: 'trojan',
  hysteria: 'hysteria', hysteria2: 'hysteria2', tuic: 'tuic', wireguard: 'wireguard', anytls: 'anytls',
  naive: 'naive', snell: 'snell', shadowtls: 'shadow-tls', http: 'http', https: 'http', socks5: 'socks5',
}

const unsupportedMessage = '该客户端不支持此协议'
const unsupportedFieldMessage = '节点包含该客户端无法安全表达的字段'
const invalidNodeMessage = '节点缺少该客户端要求的必要字段'

function record(value: unknown): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function text(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function bool(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function booleanAlias(value: JsonValue | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 0 || (typeof value === 'string' && ['0', 'false'].includes(value.trim().toLowerCase()))) return false
  if (value === 1 || (typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase()))) return true
  return undefined
}

function integer(value: JsonValue | undefined): number | undefined {
  const result = Number(value)
  return Number.isInteger(result) && result >= 0 ? result : undefined
}

function duration(value: JsonValue | undefined): string | undefined {
  const result = text(value)
  return result && /^\d+(?:\.\d+)?$/u.test(result) ? `${result}s` : result
}

function loonToken(value: string): string {
  if (!/[\s,"]/.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function loonQuoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function surgeOption(name: string, value: string): string {
  return `${name}=${loonToken(value)}`
}

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).map(([key, item]) => [key, clean(item)]))
  }
  return value
}

function namedNodes(nodes: RenderNode[]): RenderNode[] {
  const counts = new Map<string, number>()
  return nodes.map((node) => {
    const count = (counts.get(node.displayName) ?? 0) + 1
    counts.set(node.displayName, count)
    return count === 1 ? node : { ...node, displayName: `${node.displayName} (${count})` }
  })
}

function normalizeTlsAliases(node: RenderNode): RenderNode {
  const alias = booleanAlias(node.extensions.allowInsecure)
  if (alias === undefined) return node
  const tls = record(node.tls)
  const insecure = booleanAlias(tls.insecure) ?? booleanAlias(tls.allowInsecure)
  if (insecure !== undefined && insecure !== alias) return node
  const { allowInsecure: _alias, ...extensions } = node.extensions
  return { ...node, tls: { ...tls, insecure: alias }, extensions }
}

function diagnostic(node: RenderNode, code: RenderDiagnostic['code'], fields: string[] = [], outcome?: RenderDiagnostic['outcome']): RenderDiagnostic {
  const result: RenderDiagnostic = {
    nodeId: node.id,
    nodeName: node.displayName,
    protocol: node.protocol,
    code,
    outcome: outcome ?? (code === 'UNSUPPORTED_FIELD' ? 'included' : 'skipped'),
    message: code === 'UNSUPPORTED_FIELD' ? unsupportedFieldMessage : code === 'INVALID_NODE' ? invalidNodeMessage : unsupportedMessage,
  }
  if (fields.length > 0) result.fields = fields
  return result
}

function requiredNodeFields(client: RenderClient, node: RenderNode): string[] {
  const credentials = node.credentials
  const transport = record(node.transport)
  const required: string[] = []
  const has = (key: string) => {
    const value = text(credentials[key])
    return value !== undefined && value !== ''
  }
  const requireFields = (...keys: string[]) => {
    for (const key of keys) if (!has(key)) required.push(`credentials.${key}`)
  }
  if (node.protocol === 'shadowsocks' || node.protocol === 'ss2022') requireFields('method', 'password')
  else if (node.protocol === 'ssr') requireFields('method', 'password', 'protocol', 'obfs')
  else if (node.protocol === 'vmess' || node.protocol === 'vless') requireFields('uuid')
  else if (node.protocol === 'trojan' || node.protocol === 'hysteria2' || node.protocol === 'anytls') requireFields('password')
  else if (node.protocol === 'tuic') {
    if (client === 'surge') requireFields('token')
    else requireFields('uuid', 'password')
  }
  else if (node.protocol === 'wireguard') requireFields('privateKey', 'publicKey')
  else if (node.protocol === 'naive') requireFields('username', 'password')
  else if (node.protocol === 'snell') requireFields('psk', 'version')
  if (client === 'mihomo' && node.protocol === 'hysteria') {
    if (text(transport.upMbps ?? transport.up) === undefined) required.push('transport.upMbps')
    if (text(transport.downMbps ?? transport.down) === undefined) required.push('transport.downMbps')
  }
  if (client === 'mihomo' && node.protocol === 'wireguard') {
    const localAddress = node.extensions.localAddress ?? node.extensions.ip ?? node.extensions.ipv6
    if (localAddress === undefined || (Array.isArray(localAddress) && localAddress.length === 0)) required.push('extensions.localAddress')
  }
  return required
}

const structuredSupport: Record<RenderClient, readonly Protocol[]> = {
  mihomo: ['shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'wireguard', 'anytls', 'http', 'https', 'socks5'],
  // sing-box 1.13 removed the legacy WireGuard outbound; do not emit an
  // endpoint shape that the target client rejects.
  singbox: ['shadowsocks', 'ss2022', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https', 'socks5'],
  surge: ['shadowsocks', 'vmess', 'trojan', 'snell', 'tuic', 'hysteria2', 'anytls', 'http', 'https', 'socks5'],
  loon: ['shadowsocks', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'wireguard', 'http', 'https'],
  quantumultx: ['shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https', 'socks5'],
  v2rayn: ['shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https', 'socks5'],
  nekobox: ['shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https', 'socks5'],
  shadowrocket: ['shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https', 'socks5'],
  generic: ['shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https', 'socks5'],
}

function mihomoReality(value: JsonValue | undefined): Record<string, unknown> | undefined {
  const reality = record(value)
  const result = {
    'public-key': text(reality.publicKey ?? reality.public_key ?? reality.pbk),
    'short-id': text(reality.shortId ?? reality.short_id ?? reality.sid),
  }
  return Object.values(result).some((item) => item !== undefined) ? result : undefined
}

function mihomoProxy(node: RenderNode): Record<string, unknown> {
  const tls = record(node.tls)
  const transport = record(node.transport)
  const plugin = record(node.plugin)
  const c = node.credentials
  const result: Record<string, unknown> = {
    name: node.displayName,
    type: protocolNames[node.protocol],
    server: node.server,
    port: node.port,
  }
  if (node.protocol === 'shadowsocks' || node.protocol === 'ss2022') {
    result.cipher = c.method
    result.password = c.password
    if (typeof plugin.name === 'string') result.plugin = plugin.name
    if (plugin.options !== undefined) result['plugin-opts'] = plugin.options
  } else if (node.protocol === 'ssr') {
    result.cipher = c.method
    result.password = c.password
    result.protocol = c.protocol
    result.obfs = c.obfs
    result['protocol-param'] = node.extensions['protocol-param'] ?? node.extensions.protoparam
    result['obfs-param'] = node.extensions['obfs-param'] ?? node.extensions.obfsparam
  } else if (node.protocol === 'vmess') {
    result.uuid = c.uuid
    result['alter-id'] = Number(c.alterId ?? 0)
    result.cipher = c.security ?? 'auto'
  } else if (node.protocol === 'vless') {
    result.uuid = c.uuid
    result.encryption = c.encryption ?? 'none'
    result.flow = c.flow
  } else if (node.protocol === 'tuic') {
    result.uuid = c.uuid
    result.password = c.password
    result['congestion-controller'] = transport.congestionControl ?? 'bbr'
    result['udp-relay-mode'] = transport.udpRelayMode
  } else if (node.protocol === 'wireguard') {
    const local = node.extensions.localAddress ?? node.extensions.ip
    const addresses = Array.isArray(local) ? local.filter((item): item is string => typeof item === 'string') : []
    result['private-key'] = c.privateKey
    result['public-key'] = c.publicKey
    result['pre-shared-key'] = c.preSharedKey
    result.ip = typeof node.extensions.ip === 'string' ? node.extensions.ip : typeof local === 'string' && !local.includes(':') ? local : addresses.find((item) => !item.includes(':'))
    result.ipv6 = text(node.extensions.ipv6) ?? (typeof local === 'string' && local.includes(':') ? local : addresses.find((item) => item.includes(':')))
    result.mtu = node.extensions.mtu
    result.reserved = node.extensions.reserved
    result['allowed-ips'] = node.extensions.allowedIPs ?? node.extensions['allowed-ips'] ?? ['0.0.0.0/0', '::/0']
  } else if (node.protocol === 'naive') {
    result.username = c.username
    result.password = c.password
  } else if (node.protocol === 'http' || node.protocol === 'https' || node.protocol === 'socks5') {
    result.username = c.username
    result.password = c.password
    if (node.protocol === 'https') result.tls = true
  } else if (node.protocol === 'hysteria') {
    result['auth-str'] = c.password
  } else {
    result.password = c.password
  }
  const v2ray = ['vmess', 'vless', 'trojan'].includes(node.protocol)
  const tlsCapable = v2ray || ['hysteria', 'hysteria2', 'tuic', 'anytls', 'http', 'https', 'socks5'].includes(node.protocol)
  if ((['vmess', 'vless', 'http', 'socks5'].includes(node.protocol) && bool(tls.enabled)) || node.protocol === 'https') result.tls = true
  const serverName = text(tls.serverName)
  if (serverName && ['vmess', 'vless'].includes(node.protocol)) result.servername = serverName
  else if (serverName && ['trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'http', 'https'].includes(node.protocol)) result.sni = serverName
  if (tlsCapable) {
    if (bool(tls.insecure) !== undefined) result['skip-cert-verify'] = tls.insecure
    else if (bool(tls.allowInsecure) !== undefined) result['skip-cert-verify'] = tls.allowInsecure
    result.fingerprint = text(tls.certificateSha256 ?? tls.certificateFingerprint ?? tls.pinSHA256 ?? tls.pinSha256)
  }
  if (v2ray || ['hysteria', 'hysteria2', 'tuic', 'anytls'].includes(node.protocol)) {
    if (Array.isArray(tls.alpn)) result.alpn = tls.alpn
  }
  if (v2ray || ['shadowsocks', 'ss2022', 'anytls'].includes(node.protocol)) result['client-fingerprint'] = text(tls.fingerprint)
  if (v2ray) result['reality-opts'] = mihomoReality(tls.reality)

  if (v2ray && text(transport.type)) {
    const type = text(transport.type)!
    result.network = type
    if (type === 'ws' || type === 'websocket') {
      result['ws-opts'] = clean({
        path: text(transport.path),
        headers: transport.headers,
        'max-early-data': transport.earlyData ?? transport.maxEarlyData,
        'early-data-header-name': transport.earlyDataHeaderName,
      })
    } else if (type === 'grpc' && text(transport.serviceName)) {
      result['grpc-opts'] = { 'grpc-service-name': transport.serviceName }
    }
  }
  if (node.protocol === 'hysteria' || node.protocol === 'hysteria2') {
    result.ports = transport.mport ?? transport.ports
    result['hop-interval'] = transport.hopInterval
    result.up = transport.upMbps ?? transport.up
    result.down = transport.downMbps ?? transport.down
    result.obfs = transport.obfs
    if (node.protocol === 'hysteria2') result['obfs-password'] = transport.obfsPassword
  }
  return clean(result) as Record<string, unknown>
}

function singboxTls(node: RenderNode): Record<string, unknown> | undefined {
  const tls = record(node.tls)
  const reality = record(tls.reality)
  const certificate = text(tls.certificate)
  const pin = text(tls.certificateFingerprint ?? tls.pinSHA256)
  const enabled = bool(tls.enabled) || ['trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'https'].includes(node.protocol)
  if (!enabled && !certificate && !pin && Object.keys(reality).length === 0) return undefined
  return clean({
    enabled: true,
    server_name: text(tls.serverName),
    insecure: bool(tls.insecure) ?? bool(tls.allowInsecure),
    alpn: Array.isArray(tls.alpn) ? tls.alpn : undefined,
    utls: text(tls.fingerprint) ? { enabled: true, fingerprint: tls.fingerprint } : undefined,
    certificate,
    certificate_public_key_sha256: pin ? [pin] : undefined,
    reality: Object.keys(reality).length > 0 ? {
      enabled: true,
      public_key: text(reality.publicKey ?? reality.public_key ?? reality.pbk),
      short_id: text(reality.shortId ?? reality.short_id ?? reality.sid),
    } : undefined,
  }) as Record<string, unknown>
}

function singboxTransport(node: RenderNode): Record<string, unknown> | undefined {
  const transport = record(node.transport)
  const rawType = text(transport.type)?.toLowerCase()
  if (!rawType || rawType === 'tcp' || rawType === 'raw') return undefined
  const type = rawType === 'websocket' ? 'ws' : rawType
  if (type === 'ws') return clean({
    type,
    path: text(transport.path),
    headers: transport.headers,
    max_early_data: transport.earlyData ?? transport.maxEarlyData,
    early_data_header_name: text(transport.earlyDataHeaderName),
  }) as Record<string, unknown>
  if (type === 'grpc') return clean({ type, service_name: text(transport.serviceName) }) as Record<string, unknown>
  if (type === 'http' || type === 'httpupgrade') return clean({ type, path: text(transport.path), headers: transport.headers }) as Record<string, unknown>
  if (type === 'quic') return { type }
  return undefined
}

function singboxOutbound(node: RenderNode): Record<string, unknown> {
  const c = node.credentials
  const transport = record(node.transport)
  const plugin = record(node.plugin)
  const result: Record<string, unknown> = {
    type: node.protocol === 'socks5' ? 'socks' : node.protocol === 'ss2022' ? 'shadowsocks' : node.protocol === 'https' ? 'http' : node.protocol,
    tag: node.displayName,
    server: node.server,
    server_port: node.port,
  }
  if (node.protocol === 'shadowsocks' || node.protocol === 'ss2022') {
    result.method = c.method
    result.password = c.password
    if (text(plugin.name)) result.plugin = text(plugin.name)
    if (typeof plugin.options === 'string') result.plugin_opts = plugin.options
    else if (plugin.options !== undefined) {
      const options = record(plugin.options)
      result.plugin_opts = Object.entries(options).map(([key, value]) => `${key}=${text(value) ?? JSON.stringify(value)}`).join(';')
    }
  } else if (node.protocol === 'vmess') {
    result.uuid = c.uuid
    result.alter_id = Number(c.alterId ?? 0)
    result.security = c.security ?? 'auto'
  } else if (node.protocol === 'vless') {
    result.uuid = c.uuid
    result.flow = c.flow
  } else if (node.protocol === 'tuic') {
    result.uuid = c.uuid
    result.password = c.password
    result.congestion_control = transport.congestionControl ?? 'bbr'
    result.udp_relay_mode = transport.udpRelayMode
  } else if (node.protocol === 'naive') {
    result.username = c.username
    result.password = c.password
    result.quic = node.extensions.quic
  } else if (node.protocol === 'http' || node.protocol === 'https' || node.protocol === 'socks5') {
    result.username = c.username
    result.password = c.password
  } else if (node.protocol === 'wireguard') {
    result.private_key = c.privateKey
    result.peer_public_key = c.publicKey
    result.pre_shared_key = c.preSharedKey
    const localAddress = node.extensions.localAddress ?? node.extensions.ip
    result.local_address = Array.isArray(localAddress) ? localAddress : localAddress !== undefined ? [localAddress] : undefined
    result.mtu = node.extensions.mtu
    result.reserved = node.extensions.reserved
  } else if (node.protocol === 'hysteria') {
    result.auth_str = c.password
  } else {
    result.password = c.password
  }
  if (['vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https'].includes(node.protocol)) result.tls = singboxTls(node)
  if (['vmess', 'vless', 'trojan'].includes(node.protocol)) result.transport = singboxTransport(node)
  if (node.protocol === 'hysteria2') {
    const ports = text(transport.mport ?? transport.ports)
    result.server_ports = ports ? ports.split(/[\s,]+/u).filter(Boolean).map((item) => item.replace('-', ':')) : undefined
    result.hop_interval = duration(transport.hopInterval)
    result.up_mbps = integer(transport.upMbps ?? transport.up)
    result.down_mbps = integer(transport.downMbps ?? transport.down)
    const obfs = text(transport.obfs)
    if (obfs) result.obfs = { type: obfs, password: text(transport.obfsPassword) }
  }
  if (node.protocol === 'hysteria') {
    result.up_mbps = integer(transport.upMbps ?? transport.up)
    result.down_mbps = integer(transport.downMbps ?? transport.down)
    const ports = text(transport.mport ?? transport.ports)
    result.server_ports = ports ? ports.split(/[\s,]+/u).filter(Boolean).map((item) => item.replace('-', ':')) : undefined
    result.hop_interval = duration(transport.hopInterval)
    const obfs = text(transport.obfs)
    if (obfs) result.obfs = obfs
  }
  return clean(result) as Record<string, unknown>
}

function surgeLine(node: RenderNode): string | null {
  const c = node.credentials
  const tls = record(node.tls)
  const transport = record(node.transport)
  const plugin = record(node.plugin)
  const extensions = node.extensions
  const name = node.displayName.replaceAll(',', ' ')
  const outputProtocol = node.protocol === 'https'
    ? 'https'
    : node.protocol === 'socks5' && bool(tls.enabled)
      ? 'socks5-tls'
      : protocolNames[node.protocol]
  const fields: string[] = [outputProtocol, node.server, String(node.port)]
  if (node.protocol === 'shadowsocks') {
    fields.push(surgeOption('encrypt-method', text(c.method) ?? ''), surgeOption('password', text(c.password) ?? ''))
  } else if (node.protocol === 'snell') {
    if (!text(c.psk) || !text(c.version)) return null
    fields.push(surgeOption('psk', text(c.psk)!), surgeOption('version', text(c.version)!))
    if (bool(extensions.reuse) !== undefined) fields.push(`reuse=${bool(extensions.reuse)}`)
  } else if (node.protocol === 'vmess') {
    if (!text(c.uuid)) return null
    fields.push(surgeOption('username', text(c.uuid)!))
  } else if (node.protocol === 'trojan') fields.push(surgeOption('password', text(c.password) ?? ''))
  else if (node.protocol === 'tuic') {
    const token = text(c.token ?? c.password)
    if (!token) return null
    fields.push(surgeOption('token', token))
  } else if (node.protocol === 'hysteria2') {
    if (!text(c.password)) return null
    fields.push(surgeOption('password', text(c.password)!))
    if (text(transport.downMbps ?? transport.down)) fields.push(surgeOption('download-bandwidth', text(transport.downMbps ?? transport.down)!))
    if (text(transport.mport ?? transport.ports)) fields.push(surgeOption('port-hopping', text(transport.mport ?? transport.ports)!.replaceAll(',', ';')))
    if (text(transport.hopInterval)) fields.push(surgeOption('port-hopping-interval', text(transport.hopInterval)!))
    if (text(transport.obfs) === 'salamander' && text(transport.obfsPassword)) fields.push(surgeOption('salamander-password', text(transport.obfsPassword)!))
    if (text(transport.obfs) === 'gecko' && text(transport.obfsPassword)) fields.push(surgeOption('gecko-password', text(transport.obfsPassword)!))
  } else if (node.protocol === 'anytls') {
    if (!text(c.password)) return null
    fields.push(surgeOption('password', text(c.password)!))
    if (bool(extensions.reuse) !== undefined) fields.push(`reuse=${bool(extensions.reuse)}`)
  }
  else if (node.protocol === 'http' || node.protocol === 'https' || node.protocol === 'socks5') {
    if (text(c.username) || text(c.password)) fields.push(loonToken(text(c.username) ?? ''), loonToken(text(c.password) ?? ''))
  } else return null
  if ((node.protocol === 'shadowsocks' || node.protocol === 'snell') && text(plugin.name)) {
    fields.push(surgeOption('obfs', text(plugin.name)!))
    const options = record(plugin.options)
    if (text(options.host)) fields.push(surgeOption('obfs-host', text(options.host)!))
    if (text(options.uri)) fields.push(surgeOption('obfs-uri', text(options.uri)!))
  }
  if (['vmess', 'trojan'].includes(node.protocol) && text(transport.type) === 'ws') {
    fields.push('ws=true')
    if (text(transport.path)) fields.push(surgeOption('ws-path', text(transport.path)!))
    const wsHeaders = Object.entries(record(transport.headers)).map(([key, value]) => `${key}:${text(value) ?? ''}`).join(';')
    if (wsHeaders) fields.push(surgeOption('ws-headers', wsHeaders))
  }
  if (bool(tls.enabled) && ['vmess', 'http'].includes(node.protocol)) fields.push('tls=true')
  const supportsTls = ['vmess', 'trojan', 'tuic', 'hysteria2', 'anytls', 'http', 'https'].includes(node.protocol) || (node.protocol === 'socks5' && bool(tls.enabled))
  if (supportsTls && text(tls.serverName)) fields.push(surgeOption('sni', text(tls.serverName)!))
  const surgeInsecure = bool(tls.insecure) ?? bool(tls.allowInsecure)
  if (supportsTls && surgeInsecure !== undefined) fields.push(`skip-cert-verify=${surgeInsecure}`)
  if (supportsTls && text(tls.certificateFingerprint ?? tls.pinSHA256)) fields.push(surgeOption('server-cert-fingerprint-sha256', text(tls.certificateFingerprint ?? tls.pinSHA256)!))
  if (supportsTls && Array.isArray(tls.alpn) && tls.alpn.length > 0) fields.push(`alpn=${loonQuoted(tls.alpn.join(','))}`)
  return `${name} = ${fields.join(', ')}`
}

function loonLine(node: RenderNode): string | null {
  const c = node.credentials
  const tls = record(node.tls)
  const transport = record(node.transport)
  const plugin = record(node.plugin)
  const extensions = node.extensions
  const protocol = node.protocol === 'shadowsocks' || node.protocol === 'ss2022' ? 'Shadowsocks' : node.protocol === 'ssr' ? 'ShadowsocksR' : node.protocol === 'hysteria2' ? 'Hysteria2' : node.protocol.toUpperCase() === 'VMESS' ? 'VMess' : node.protocol.toUpperCase() === 'VLESS' ? 'VLESS' : node.protocol
  const name = node.displayName.replaceAll(',', ' ').replaceAll('=', '-')
  if (node.protocol === 'wireguard') {
    const privateKey = text(c.privateKey)
    const publicKey = text(c.publicKey)
    if (!privateKey || !publicKey) return null
    const fields = ['wireguard']
    const localAddress = Array.isArray(extensions.localAddress)
      ? extensions.localAddress.filter((item): item is string => typeof item === 'string').join(',')
      : text(extensions.localAddress ?? extensions.ip)
    if (localAddress) fields.push(`interface-ip=${loonToken(localAddress)}`)
    if (text(extensions.ipv6)) fields.push(`interface-ipV6=${loonToken(text(extensions.ipv6)!)}`)
    fields.push(`private-key=${loonQuoted(privateKey)}`)
    if (text(extensions.mtu)) fields.push(`mtu=${loonToken(text(extensions.mtu)!)}`)
    if (text(extensions.dns)) fields.push(`dns=${loonToken(text(extensions.dns)!)}`)
    if (text(extensions.dnsV6)) fields.push(`dnsV6=${loonToken(text(extensions.dnsV6)!)}`)
    if (text(extensions.keepalive)) fields.push(`keepalive=${loonToken(text(extensions.keepalive)!)}`)
    const storedPeers = text(extensions.peers)
    const endpoint = node.server.includes(':') ? `[${node.server}]:${node.port}` : `${node.server}:${node.port}`
    const peerFields = [`public-key=${loonQuoted(publicKey)}`]
    if (text(c.preSharedKey)) peerFields.push(`preshared-key=${loonQuoted(text(c.preSharedKey)!)}`)
    if (Array.isArray(extensions.reserved)) peerFields.push(`reserved=[${extensions.reserved.map(String).join(',')}]`)
    const allowedIps = extensions.allowedIPs ?? extensions['allowed-ips']
    if (Array.isArray(allowedIps)) peerFields.push(`allowed-ips=${loonQuoted(allowedIps.map(String).join(','))}`)
    else if (text(allowedIps)) peerFields.push(`allowed-ips=${loonQuoted(text(allowedIps)!)}`)
    peerFields.push(`endpoint=${endpoint}`)
    const peers = storedPeers
      ? (storedPeers.startsWith('[') ? storedPeers : `[${storedPeers}]`)
      : `[{${peerFields.join(',')}}]`
    fields.push(`peers=${peers}`)
    return `${name} = ${fields.join(',')}`
  }
  const fields = [protocol, node.server, String(node.port)]
  if (node.protocol === 'shadowsocks' || node.protocol === 'ss2022' || node.protocol === 'ssr') fields.push(loonToken(text(c.method) ?? ''), loonQuoted(text(c.password) ?? ''))
  else if (node.protocol === 'vmess') {
    const uuid = text(c.uuid)
    if (!uuid) return null
    fields.push(loonToken(text(c.security) ?? 'auto'), loonQuoted(uuid))
  } else if (node.protocol === 'vless') {
    const uuid = text(c.uuid)
    if (!uuid) return null
    fields.push(loonQuoted(uuid))
  }
  else if (node.protocol === 'tuic') fields.push(text(c.uuid) ?? '', text(c.password) ?? '')
  else if (node.protocol === 'http' || node.protocol === 'https' || node.protocol === 'socks5') {
    const username = text(c.username)
    const password = text(c.password)
    if (username) fields.push(loonQuoted(username))
    if (password) fields.push(loonQuoted(password))
  } else fields.push(loonQuoted(text(c.password) ?? ''))
  if (node.protocol === 'vmess' && text(c.alterId) !== undefined) fields.push(`alterId=${loonToken(text(c.alterId)!)}`)
  if (node.protocol === 'ssr') {
    if (!text(c.protocol) || !text(c.obfs)) return null
    fields.push(`protocol=${loonToken(text(c.protocol)!)}`)
    if (text(extensions['protocol-param'])) fields.push(`protocol-param=${loonToken(text(extensions['protocol-param'])!)}`)
    fields.push(`obfs=${loonToken(text(c.obfs)!)}`)
    if (text(extensions['obfs-param'])) fields.push(`obfs-param=${loonToken(text(extensions['obfs-param'])!)}`)
  }
  const supportsTransport = ['vmess', 'vless', 'trojan'].includes(node.protocol)
  if (supportsTransport && text(transport.type)) fields.push(`transport=${loonToken(text(transport.type)!)}`)
  if (supportsTransport && text(transport.path)) fields.push(`path=${loonToken(text(transport.path)!)}`)
  if (supportsTransport && text(record(transport.headers).Host)) fields.push(`host=${loonToken(text(record(transport.headers).Host)!)}`)
  if (node.protocol === 'vmess' || node.protocol === 'vless') {
    if (bool(tls.enabled) !== undefined) fields.push(`over-tls=${bool(tls.enabled)}`)
  }
  const supportsTls = ['vmess', 'vless', 'trojan', 'hysteria2', 'https'].includes(node.protocol)
  if (supportsTls && text(tls.serverName)) fields.push(`tls-name=${loonToken(text(tls.serverName)!)}`)
  const insecure = bool(tls.insecure) ?? bool(tls.allowInsecure)
  if (supportsTls && insecure !== undefined) fields.push(`skip-cert-verify=${insecure}`)
  if (node.protocol === 'trojan' && Array.isArray(tls.alpn) && tls.alpn.length > 0) fields.push(`alpn=${loonToken(tls.alpn.join('|'))}`)
  if ((node.protocol === 'shadowsocks' || node.protocol === 'ss2022') && text(plugin.name)) {
    fields.push(`obfs-name=${loonToken(text(plugin.name)!)}`)
    const options = record(plugin.options)
    if (text(options.host)) fields.push(`obfs-host=${loonToken(text(options.host)!)}`)
    if (text(options.uri)) fields.push(`obfs-uri=${loonToken(text(options.uri)!)}`)
  }
  for (const key of ['fast-open', 'udp'] as const) {
    const value = extensions[key]
    if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') fields.push(`${key}=${loonToken(String(value))}`)
  }
  return `${name} = ${fields.join(',')}`
}

function renderStructured(client: RenderClient, nodes: RenderNode[]): string {
  if (client === 'mihomo') {
    const proxies = nodes.map(mihomoProxy)
    const names = proxies.map((node) => node.name as string)
    return stringifyYaml({ proxies, 'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: names.length ? names : ['DIRECT'] }] })
  }
  if (client === 'singbox') {
    const outbounds = nodes.map(singboxOutbound)
    const names = outbounds.map((node) => node.tag as string)
    outbounds.push({ type: 'selector', tag: 'Proxy', outbounds: names.length ? names : ['direct'] }, { type: 'direct', tag: 'direct' })
    return JSON.stringify({ outbounds }, null, 2) + '\n'
  }
  if (client === 'surge') {
    const lines = nodes.map(surgeLine).filter((line): line is string => line !== null)
    const names = lines.map((line) => line.split(' = ', 1)[0])
    return `[Proxy]\n${lines.join('\n')}\n\n[Proxy Group]\nProxy = select, ${names.join(', ') || 'DIRECT'}\n`
  }
  if (client === 'quantumultx') {
    const lines = nodes.map(serializeShareUri).filter((line): line is string => line !== null)
    return lines.join('\n') + (lines.length > 0 ? '\n' : '')
  }
  const lines = nodes.map(loonLine).filter((line): line is string => line !== null)
  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

function contentMetadata(client: RenderClient): Pick<RenderResult, 'contentType' | 'fileName'> {
  if (client === 'mihomo') return { contentType: 'text/yaml; charset=utf-8', fileName: 'mihomo.yaml' }
  if (client === 'singbox') return { contentType: 'application/json; charset=utf-8', fileName: 'sing-box.json' }
  if (client === 'surge') return { contentType: 'text/plain; charset=utf-8', fileName: 'surge.conf' }
  if (client === 'loon') return { contentType: 'text/plain; charset=utf-8', fileName: 'loon.conf' }
  if (client === 'quantumultx') return { contentType: 'text/plain; charset=utf-8', fileName: 'quantumultx.conf' }
  return { contentType: 'text/plain; charset=utf-8', fileName: `${client}.txt` }
}

function uriForClient(client: RenderClient, node: RenderNode): string | null {
  const standard = serializeShareUri(node)
  const raw = rawShareUri(node)
  const tls = record(node.tls)
  const certSensitive = Boolean(tls.certificate || tls.certificateFingerprint || tls.reality)
  if (raw && (node.protocol === 'ssr' || node.protocol === 'wireguard' || node.protocol === 'snell' || node.protocol === 'shadowtls' || text(node.extensions.sourceScheme)?.toLowerCase() === 'trojan-go' || (client === 'v2rayn' && certSensitive))) return raw
  return standard ?? raw
}

function unsupportedExtensionFields(client: RenderClient, node: RenderNode): string[] {
  const keys = Object.keys(node.extensions).filter((key) => key !== 'sourceScheme')
  if (client === 'surge') return keys.filter((key) => key !== 'reuse' || !['snell', 'anytls'].includes(node.protocol)).map((key) => `extensions.${key}`)
  if (client === 'mihomo') {
    const supported = node.protocol === 'wireguard'
      ? new Set(['ip', 'localAddress', 'ipv6', 'mtu', 'reserved', 'allowedIPs', 'allowed-ips'])
      : node.protocol === 'ssr'
        ? new Set(['protocol-param', 'protoparam', 'obfs-param', 'obfsparam'])
        : new Set<string>()
    return keys.filter((key) => !supported.has(key)).map((key) => `extensions.${key}`)
  }
  if (client === 'singbox') {
    const supported = node.protocol === 'naive' ? new Set(['quic']) : new Set<string>()
    return keys.filter((key) => !supported.has(key)).map((key) => `extensions.${key}`)
  }
  if (client !== 'loon') return keys.map((key) => `extensions.${key}`)
  const supported = new Set(['fast-open', 'udp'])
  if (node.protocol === 'ssr') {
    supported.add('protocol-param')
    supported.add('obfs-param')
  }
  if (node.protocol === 'wireguard') {
    for (const key of ['localAddress', 'ip', 'ipv6', 'mtu', 'dns', 'dnsV6', 'keepalive', 'peers', 'reserved', 'allowedIPs', 'allowed-ips']) supported.add(key)
  }
  return keys.filter((key) => !supported.has(key)).map((key) => `extensions.${key}`)
}

function unsupportedObjectFields(value: Record<string, JsonValue>, prefix: string, supported: readonly string[]): string[] {
  const allowed = new Set(supported)
  return Object.keys(value).filter((key) => value[key] !== undefined && !allowed.has(key)).map((key) => `${prefix}.${key}`)
}

function unsupportedNodeFields(client: RenderClient, node: RenderNode): string[] {
  const fields = unsupportedExtensionFields(client, node)
  const tls = record(node.tls)
  const transport = record(node.transport)
  const plugin = record(node.plugin)
  const pluginOptions = record(plugin.options)
  const commonTls = ['enabled', 'serverName', 'insecure', 'allowInsecure', 'alpn', 'fingerprint', 'certificate', 'ca', 'ca-str', 'certificateFingerprint', 'pinSHA256', 'pinSha256', 'reality']
  const reality = record(tls.reality)
  const hysteriaTransport = ['mport', 'ports', 'upMbps', 'up', 'downMbps', 'down', 'obfs', 'obfsPassword', 'hopInterval']

  if (client === 'mihomo') {
    const v2ray = ['vmess', 'vless', 'trojan'].includes(node.protocol)
    let supportedTls: string[] = []
    if (['shadowsocks', 'ss2022'].includes(node.protocol)) supportedTls = ['fingerprint']
    else if (v2ray || node.protocol === 'anytls') supportedTls = [...commonTls]
    else if (['hysteria', 'hysteria2', 'tuic'].includes(node.protocol)) supportedTls = commonTls.filter((key) => !['fingerprint', 'reality'].includes(key))
    else if (['http', 'https'].includes(node.protocol)) supportedTls = commonTls.filter((key) => !['alpn', 'fingerprint', 'reality'].includes(key))
    else if (node.protocol === 'socks5') supportedTls = commonTls.filter((key) => !['serverName', 'alpn', 'fingerprint', 'reality'].includes(key))
    supportedTls = supportedTls.filter((key) => !['certificate', 'ca', 'ca-str'].includes(key))
    supportedTls.push('certificateSha256')
    if (v2ray && text(tls.security)?.toLowerCase() === 'reality' && Object.keys(reality).length > 0) supportedTls.push('security')
    fields.push(...unsupportedObjectFields(tls, 'tls', supportedTls))
    fields.push(...unsupportedObjectFields(reality, 'tls.reality', v2ray ? ['publicKey', 'public_key', 'shortId', 'short_id', 'pbk', 'sid'] : []))
    let supportedTransport: string[] = []
    const transportType = text(transport.type)?.toLowerCase()
    if (v2ray) {
      supportedTransport = ['type']
      if (transportType === 'ws' || transportType === 'websocket') supportedTransport.push('path', 'headers', 'earlyData', 'maxEarlyData', 'earlyDataHeaderName')
      else if (transportType === 'grpc') supportedTransport.push('serviceName')
    }
    if (node.protocol === 'hysteria') supportedTransport.push(...hysteriaTransport.filter((key) => key !== 'obfsPassword'))
    if (node.protocol === 'hysteria2') supportedTransport.push(...hysteriaTransport)
    if (node.protocol === 'tuic') supportedTransport.push('congestionControl', 'udpRelayMode')
    fields.push(...unsupportedObjectFields(transport, 'transport', supportedTransport))
    if (Object.keys(plugin).length > 0 && !['shadowsocks', 'ss2022'].includes(node.protocol)) fields.push('plugin')
    else fields.push(...unsupportedObjectFields(plugin, 'plugin', ['name', 'options']))
  } else if (client === 'singbox') {
    const tlsCapable = ['vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'http', 'https'].includes(node.protocol)
    const supportedTls = tlsCapable ? [...commonTls] : []
    if (tlsCapable && text(tls.security)?.toLowerCase() === 'reality' && Object.keys(reality).length > 0) supportedTls.push('security')
    fields.push(...unsupportedObjectFields(tls, 'tls', supportedTls))
    fields.push(...unsupportedObjectFields(reality, 'tls.reality', tlsCapable ? ['publicKey', 'public_key', 'shortId', 'short_id', 'pbk', 'sid'] : []))
    let supportedTransport: string[] = []
    const transportType = text(transport.type)?.toLowerCase()
    if (['vmess', 'vless', 'trojan'].includes(node.protocol)) {
      if (['tcp', 'raw'].includes(transportType ?? '')) supportedTransport = ['type']
      else if (transportType === 'ws' || transportType === 'websocket') supportedTransport = ['type', 'path', 'headers', 'earlyData', 'maxEarlyData', 'earlyDataHeaderName']
      else if (transportType === 'grpc') supportedTransport = ['type', 'serviceName']
      else if (transportType === 'http' || transportType === 'httpupgrade') supportedTransport = ['type', 'path', 'headers']
      else if (transportType === 'quic') supportedTransport = ['type']
    }
    if (node.protocol === 'naive' && ['tcp', 'http2'].includes(transportType ?? '')) supportedTransport = ['type']
    if (node.protocol === 'hysteria') supportedTransport.push(...hysteriaTransport.filter((key) => key !== 'obfsPassword'))
    if (node.protocol === 'hysteria2') supportedTransport.push(...hysteriaTransport)
    if (node.protocol === 'tuic') supportedTransport.push('congestionControl', 'udpRelayMode')
    fields.push(...unsupportedObjectFields(transport, 'transport', supportedTransport))
    if (Object.keys(plugin).length > 0 && !['shadowsocks', 'ss2022'].includes(node.protocol)) fields.push('plugin')
    else fields.push(...unsupportedObjectFields(plugin, 'plugin', ['name', 'options']))
  } else if (client === 'surge') {
    const supportsTls = ['vmess', 'trojan', 'tuic', 'hysteria2', 'anytls', 'http', 'https'].includes(node.protocol) || (node.protocol === 'socks5' && bool(tls.enabled))
    fields.push(...unsupportedObjectFields(tls, 'tls', supportsTls ? ['enabled', 'serverName', 'insecure', 'allowInsecure', 'alpn', 'certificateFingerprint', 'pinSHA256'] : []))
    fields.push(...unsupportedObjectFields(reality, 'tls.reality', []))
    const supportedTransport = node.protocol === 'hysteria2'
      ? ['mport', 'ports', 'downMbps', 'down', 'hopInterval', 'obfs', 'obfsPassword']
      : ['vmess', 'trojan'].includes(node.protocol) && text(transport.type) === 'ws'
        ? ['type', 'path', 'headers']
        : []
    fields.push(...unsupportedObjectFields(transport, 'transport', supportedTransport))
    if (Object.keys(plugin).length > 0 && !['shadowsocks', 'snell'].includes(node.protocol)) fields.push('plugin')
    else {
      fields.push(...unsupportedObjectFields(plugin, 'plugin', ['name', 'options']))
      fields.push(...unsupportedObjectFields(pluginOptions, 'plugin.options', ['host', 'uri']))
    }
  } else if (client === 'loon') {
    let supportedTls: string[] = []
    if (['vmess', 'vless', 'trojan', 'hysteria2', 'https'].includes(node.protocol)) supportedTls = ['enabled', 'serverName', 'insecure', 'allowInsecure']
    if (node.protocol === 'trojan') supportedTls.push('alpn')
    fields.push(...unsupportedObjectFields(tls, 'tls', supportedTls))
    fields.push(...unsupportedObjectFields(reality, 'tls.reality', []))
    const supportedTransport = ['vmess', 'vless', 'trojan'].includes(node.protocol) ? ['type', 'path', 'headers'] : []
    fields.push(...unsupportedObjectFields(transport, 'transport', supportedTransport))
    if (supportedTransport.length > 0) fields.push(...unsupportedObjectFields(record(transport.headers), 'transport.headers', ['Host', 'host']))
    if (Object.keys(plugin).length > 0 && !['shadowsocks', 'ss2022'].includes(node.protocol)) fields.push('plugin')
    else {
      fields.push(...unsupportedObjectFields(plugin, 'plugin', ['name', 'options']))
      fields.push(...unsupportedObjectFields(pluginOptions, 'plugin.options', ['host', 'uri']))
    }
  } else if (['quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'].includes(client)) {
    fields.push(...unsupportedObjectFields(tls, 'tls', [
      'enabled', 'security', 'serverName', 'insecure', 'allowInsecure', 'alpn', 'fingerprint',
      'certificate', 'ca', 'ca-str', 'certificateFingerprint', 'pinSHA256', 'pinSha256', 'reality',
    ]))
    fields.push(...unsupportedObjectFields(reality, 'tls.reality', ['publicKey', 'public_key', 'shortId', 'short_id', 'spiderX', 'spider_x', 'pbk', 'sid', 'spx']))
    fields.push(...unsupportedObjectFields(transport, 'transport', [
      'type', 'path', 'headers', 'serviceName', 'mode', 'headerType', 'congestionControl', 'udpRelayMode',
      'obfs', 'obfsPassword', 'mport', 'ports', 'upMbps', 'up', 'downMbps', 'down', 'hopInterval',
      'earlyData', 'maxEarlyData', 'earlyDataHeaderName',
    ]))
    fields.push(...unsupportedObjectFields(record(transport.headers), 'transport.headers', ['Host', 'host']))
    if (Object.keys(plugin).length > 0 && !['shadowsocks', 'ss2022'].includes(node.protocol)) fields.push('plugin')
    else fields.push(...unsupportedObjectFields(plugin, 'plugin', ['name', 'options']))
  }

  return [...new Set(fields)]
}

export function renderClient(client: RenderClient, input: RenderNode[]): RenderResult {
  const diagnostics: RenderDiagnostic[] = []
  const candidates: RenderNode[] = []
  const enabledNodes = namedNodes(input.filter((item) => item.enabled).map(normalizeTlsAliases))
  for (const node of enabledNodes) {
    if (!structuredSupport[client].includes(node.protocol)) {
      diagnostics.push(diagnostic(node, 'UNSUPPORTED_PROTOCOL'))
      continue
    }
    if (node.extensions.shadowtls !== undefined) {
      diagnostics.push(diagnostic(node, 'UNSUPPORTED_FIELD', ['extensions.shadowtls'], 'skipped'))
      continue
    }
    if (client === 'mihomo' && node.protocol === 'anytls' && Object.keys(record(record(node.tls).reality)).length > 0) {
      diagnostics.push(diagnostic(node, 'UNSUPPORTED_FIELD', ['tls.reality'], 'skipped'))
      continue
    }
    const tls = record(node.tls)
    if (client === 'loon' && (text(tls.security)?.toLowerCase() === 'reality' || Object.keys(record(tls.reality)).length > 0)) {
      diagnostics.push(diagnostic(node, 'UNSUPPORTED_FIELD', ['tls.reality'], 'skipped'))
      continue
    }
    const missingFields = requiredNodeFields(client, node)
    if (missingFields.length > 0) {
      diagnostics.push(diagnostic(node, 'INVALID_NODE', missingFields))
      continue
    }
    const unsupportedFields = unsupportedNodeFields(client, node)
    if (unsupportedFields.length > 0) diagnostics.push(diagnostic(node, 'UNSUPPORTED_FIELD', unsupportedFields))
    if (['quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'].includes(client)) {
      if (!uriForClient(client, node)) {
        diagnostics.push(diagnostic(node, 'INVALID_NODE'))
        continue
      }
    }
    if (client === 'surge' && !surgeLine(node)) {
      diagnostics.push(diagnostic(node, 'INVALID_NODE'))
      continue
    }
    if (client === 'loon' && !loonLine(node)) {
      diagnostics.push(diagnostic(node, 'INVALID_NODE'))
      continue
    }
    candidates.push(node)
  }

  let body: string
  if (['v2rayn', 'nekobox', 'shadowrocket', 'generic'].includes(client)) {
    const uris = candidates.map((node) => uriForClient(client, node)).filter((uri): uri is string => uri !== null)
    let binary = ''
    for (const byte of new TextEncoder().encode(uris.join('\n'))) binary += String.fromCharCode(byte)
    body = btoa(binary)
  } else {
    body = renderStructured(client, candidates)
  }
  const metadata = contentMetadata(client)
  return {
    client,
    body,
    ...metadata,
    diagnostics,
    inputNodes: input.length,
    outputNodes: candidates.length,
    skippedNodes: enabledNodes.length - candidates.length,
  }
}

export const renderMihomo = (nodes: RenderNode[]) => renderClient('mihomo', nodes)
export const renderSingBox = (nodes: RenderNode[]) => renderClient('singbox', nodes)
export const renderSurge = (nodes: RenderNode[]) => renderClient('surge', nodes)
export const renderLoon = (nodes: RenderNode[]) => renderClient('loon', nodes)
export const renderQuantumultX = (nodes: RenderNode[]) => renderClient('quantumultx', nodes)
export const renderV2rayN = (nodes: RenderNode[]) => renderClient('v2rayn', nodes)
export const renderNekoBox = (nodes: RenderNode[]) => renderClient('nekobox', nodes)
export const renderShadowrocket = (nodes: RenderNode[]) => renderClient('shadowrocket', nodes)
