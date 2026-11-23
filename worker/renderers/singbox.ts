import type { Template } from '../templates/validation.js'
import { TemplateValidationError } from '../templates/validation.js'
import type { RenderDiagnostic, RenderNode } from './model.js'

export const TARGET_SINGBOX_VERSION = '1.14'

export const SINGBOX_SUPPORTED_PROTOCOLS = [
  'shadowsocks',
  'ss2022',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'anytls',
  'naive',
  'http',
  'https',
  'socks5',
] as const

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function integer(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function duration(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+(?:[smh]|ms)$/u.test(value.trim())) return value.trim()
  const seconds = integer(value)
  return seconds !== undefined && seconds > 0 ? `${seconds}s` : undefined
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean).filter((item) => item !== undefined)
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, clean(v)])
      .filter(([, v]) => v !== undefined)
    return Object.fromEntries(entries)
  }
  return value
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

export function singboxOutbound(node: RenderNode, customTag?: string): Record<string, unknown> {
  const c = node.credentials
  const transport = record(node.transport)
  const plugin = record(node.plugin)
  const result: Record<string, unknown> = {
    type: node.protocol === 'socks5' ? 'socks' : node.protocol === 'ss2022' ? 'shadowsocks' : node.protocol === 'https' ? 'http' : node.protocol,
    tag: customTag ?? node.displayName,
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

const RESERVED_SINGBOX_TAGS = new Set(['direct', 'block', 'dns-out', 'default'])

export type SingBoxCompileResult = {
  config: Record<string, unknown>
  json: string
  diagnostics: RenderDiagnostic[]
  outputNodes: number
  skippedNodes: number
}

function checkRequiredNodeFields(node: RenderNode): string[] {
  const c = node.credentials
  const required: string[] = []
  const requireFields = (...names: string[]) => {
    for (const name of names) {
      if (text(c[name]) === undefined) required.push(`credentials.${name}`)
    }
  }
  if (node.protocol === 'shadowsocks' || node.protocol === 'ss2022') requireFields('method', 'password')
  else if (node.protocol === 'vmess' || node.protocol === 'vless') requireFields('uuid')
  else if (node.protocol === 'trojan' || node.protocol === 'hysteria2' || node.protocol === 'anytls') requireFields('password')
  else if (node.protocol === 'tuic') requireFields('uuid', 'password')
  else if (node.protocol === 'naive') requireFields('username', 'password')
  return required
}

export function compileSingBoxConfig(
  template: Template | undefined,
  nodes: RenderNode[],
  options?: { targetVersion?: string },
): SingBoxCompileResult {
  const targetVersion = options?.targetVersion ?? TARGET_SINGBOX_VERSION
  const supportedProtocols = new Set<string>(SINGBOX_SUPPORTED_PROTOCOLS)

  const enabledNodes = nodes.filter((node) => node.enabled)
  const validNodes: RenderNode[] = []
  const diagnostics: RenderDiagnostic[] = []

  for (const node of enabledNodes) {
    if (!supportedProtocols.has(node.protocol)) {
      diagnostics.push({
        nodeId: node.id,
        nodeName: node.displayName,
        protocol: node.protocol,
        code: 'UNSUPPORTED_PROTOCOL',
        outcome: 'skipped',
        message: `sing-box ${targetVersion} 不支持 ${node.protocol} 协议节点`,
      })
      continue
    }

    const missing = checkRequiredNodeFields(node)
    if (missing.length > 0) {
      diagnostics.push({
        nodeId: node.id,
        nodeName: node.displayName,
        protocol: node.protocol,
        code: 'UNSUPPORTED_FIELD',
        outcome: 'skipped',
        fields: missing,
        message: `sing-box 缺少必需字段：${missing.join(', ')}`,
      })
      continue
    }

    // Check extensions
    const extKeys = Object.keys(node.extensions).filter((k) => k !== 'sourceScheme')
    if (extKeys.length > 0) {
      const allowed = node.protocol === 'naive' ? new Set(['quic']) : new Set<string>()
      const unsupported = extKeys.filter((k) => !allowed.has(k)).map((k) => `extensions.${k}`)
      if (unsupported.length > 0) {
        diagnostics.push({
          nodeId: node.id,
          nodeName: node.displayName,
          protocol: node.protocol,
          code: 'UNSUPPORTED_FIELD',
          outcome: 'included',
          fields: unsupported,
          message: `节点包含 sing-box 未使用的扩展字段：${unsupported.join(', ')}`,
        })
      }
    }

    validNodes.push(node)
  }

  const outputNodes = validNodes.length
  const skippedNodes = enabledNodes.length - outputNodes

  // If no template is provided, generate base configuration
  const groupNames = template ? template['proxy-groups'].map((g) => g.name) : ['Proxy']
  const reserved = new Set([...RESERVED_SINGBOX_TAGS, ...groupNames])

  // Disambiguate node tags
  const namesByNode = new Map<RenderNode, string>()
  const usedTags = new Set(reserved)
  for (const node of [...validNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const base = node.displayName.replace(/\p{Cc}/gu, ' ').trim() || 'Node'
    let tag = base
    for (let suffix = 2; usedTags.has(tag); suffix++) {
      tag = `${base} (${suffix})`
    }
    usedTags.add(tag)
    namesByNode.set(node, tag)
  }

  const nodeOutbounds = validNodes.map((node) => singboxOutbound(node, namesByNode.get(node)))
  const nodeTags = nodeOutbounds.map((ob) => ob.tag as string)

  // Map of available outbounds: node tags + built-in tags + group names
  const availableTags = new Set<string>([...nodeTags, 'direct', 'block', ...groupNames])

  // Build policy group outbounds
  const policyOutbounds: Record<string, unknown>[] = []
  if (template) {
    for (const group of template['proxy-groups']) {
      const members: string[] = []
      for (const proxy of group.proxies) {
        if (proxy === '$SUBPANEL_NODES') {
          members.push(...nodeTags)
        } else if (proxy === 'DIRECT') {
          members.push('direct')
        } else if (proxy === 'REJECT' || proxy === 'REJECT-DROP') {
          members.push('block')
        } else {
          // Strictly verify outbound reference exists
          if (!availableTags.has(proxy)) {
            throw new TemplateValidationError([
              {
                code: 'INVALID_GROUP_REFERENCE',
                path: `proxy-groups.${group.name}`,
                severity: 'error',
                message: `策略组 "${group.name}" 引用的出站 "${proxy}" 不存在`,
              },
            ])
          }
          members.push(proxy)
        }
      }

      const outbounds = members.length > 0 ? members : ['direct']
      if (group.type === 'select') {
        policyOutbounds.push({
          type: 'selector',
          tag: group.name,
          outbounds,
          default: outbounds[0],
        })
      } else if (group.type === 'url-test' || group.type === 'fallback' || group.type === 'load-balance') {
        policyOutbounds.push({
          type: 'urltest',
          tag: group.name,
          outbounds,
          url: group.url || 'https://cp.cloudflare.com/generate_204',
          interval: group.interval ? `${group.interval}s` : '10m',
          tolerance: group.type === 'fallback' ? 0 : group.tolerance ?? 50,
        })
      }
    }
  } else {
    policyOutbounds.push({
      type: 'selector',
      tag: 'Proxy',
      outbounds: nodeTags.length > 0 ? nodeTags : ['direct'],
      default: nodeTags[0] ?? 'direct',
    })
  }

  // Built-in outbounds
  const outbounds: Record<string, unknown>[] = [
    ...policyOutbounds,
    ...nodeOutbounds,
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' },
  ]

  // Primary proxy group tag for detours
  const primaryGroupTag = policyOutbounds[0]?.tag as string | undefined ?? 'direct'

  // Map target for rules
  const mapTarget = (target: string, ruleDesc: string): string => {
    let mapped = target.trim()
    if (mapped === 'DIRECT') mapped = 'direct'
    else if (mapped === 'REJECT' || mapped === 'REJECT-DROP') mapped = 'block'
    if (!availableTags.has(mapped)) {
      throw new TemplateValidationError([
        {
          code: 'INVALID_RULE_TARGET',
          path: 'rules',
          severity: 'error',
          message: `规则 "${ruleDesc}" 的目标出站 "${target}" 不存在`,
        },
      ])
    }
    return mapped
  }

  // Build route.rules & route.final
  const routeRules: Record<string, unknown>[] = [
    { protocol: 'dns', action: 'hijack-dns' },
  ]
  let finalTag = primaryGroupTag

  if (template?.rules) {
    for (const line of template.rules) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const parts = trimmed.split(',').map((p) => p.trim())
      const type = parts[0]?.toUpperCase()

      if (type === 'MATCH') {
        const target = parts[1] ?? 'Proxy'
        finalTag = mapTarget(target, trimmed)
        continue
      }

      if (parts.length >= 3) {
        const payload = parts[1]
        const target = mapTarget(parts[2], trimmed)

        if (type === 'DOMAIN-SUFFIX') {
          routeRules.push({ domain_suffix: [payload], outbound: target })
        } else if (type === 'DOMAIN-KEYWORD') {
          routeRules.push({ domain_keyword: [payload], outbound: target })
        } else if (type === 'DOMAIN') {
          routeRules.push({ domain: [payload], outbound: target })
        } else if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
          routeRules.push({ ip_cidr: [payload], outbound: target })
        } else if (type === 'GEOIP') {
          routeRules.push({ geoip: [payload.toLowerCase()], outbound: target })
        } else if (type === 'RULE-SET') {
          routeRules.push({ rule_set: [payload], outbound: target })
        } else if (type === 'SRC-IP-CIDR') {
          routeRules.push({ source_ip_cidr: [payload], outbound: target })
        } else if (type === 'DST-PORT') {
          const port = Number(payload)
          if (Number.isFinite(port)) routeRules.push({ port: [port], outbound: target })
        } else if (type === 'SRC-PORT') {
          const port = Number(payload)
          if (Number.isFinite(port)) routeRules.push({ source_port: [port], outbound: target })
        } else if (type === 'PROCESS-NAME') {
          routeRules.push({ process_name: [payload], outbound: target })
        }
      }
    }
  } else {
    routeRules.push({
      ip_cidr: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
      outbound: 'direct',
    })
  }

  // Build rule_set
  const ruleSets: Record<string, unknown>[] = []
  if (template?.['rule-providers']) {
    for (const [name, provider] of Object.entries(template['rule-providers'])) {
      const isBinary = provider.format === 'mrs' || provider.url.endsWith('.srs')
      ruleSets.push({
        type: 'remote',
        tag: name,
        format: isBinary ? 'binary' : 'source',
        url: provider.url,
        download_detour: primaryGroupTag,
      })
    }
  }

  // Build DNS
  const dnsServers: Record<string, unknown>[] = [
    {
      tag: 'remote-dns',
      type: 'https',
      server: '1.1.1.1',
      path: '/dns-query',
      detour: primaryGroupTag,
    },
    {
      tag: 'local-dns',
      type: 'udp',
      server: '223.5.5.5',
      detour: 'direct',
    },
  ]

  // Optional custom DNS nameserver from subpanel.client.dns
  const customNameserver = template?.subpanel?.client?.dns?.nameserver?.[0]
  if (customNameserver) {
    if (customNameserver.startsWith('https://')) {
      try {
        const u = new URL(customNameserver)
        dnsServers[0] = {
          tag: 'remote-dns',
          type: 'https',
          server: u.hostname,
          path: u.pathname || '/dns-query',
          detour: primaryGroupTag,
        }
      } catch {
        // keep default
      }
    } else if (customNameserver.includes('.') || customNameserver.includes(':')) {
      dnsServers[0] = {
        tag: 'remote-dns',
        type: 'udp',
        server: customNameserver,
        detour: primaryGroupTag,
      }
    }
  }

  const dns: Record<string, unknown> = {
    servers: dnsServers,
    rules: [],
    strategy: 'prefer_ipv4',
  }

  const route: Record<string, unknown> = {
    auto_detect_interface: true,
    default_domain_resolver: 'remote-dns',
    final: finalTag,
    rules: routeRules,
  }
  if (ruleSets.length > 0) {
    route.rule_set = ruleSets
  }

  const config: Record<string, unknown> = {
    dns,
    route,
    outbounds,
  }

  const json = JSON.stringify(config, null, 2) + '\n'

  return {
    config,
    json,
    diagnostics,
    outputNodes,
    skippedNodes,
  }
}

export function renderSingBox(nodes: RenderNode[], template?: Template): { body: string; diagnostics: RenderDiagnostic[]; outputNodes: number; skippedNodes: number } {
  const result = compileSingBoxConfig(template, nodes)
  return {
    body: result.json,
    diagnostics: result.diagnostics,
    outputNodes: result.outputNodes,
    skippedNodes: result.skippedNodes,
  }
}
