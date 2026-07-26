import type { SubscriptionDiagnostic } from '../../app/api'

const PROTOCOL_LABELS: Record<string, string> = {
  shadowsocks: 'Shadowsocks',
  ss2022: 'Shadowsocks 2022',
  ssr: 'ShadowsocksR',
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  hysteria: 'Hysteria',
  hysteria2: 'Hysteria 2',
  tuic: 'TUIC',
  wireguard: 'WireGuard',
  anytls: 'AnyTLS',
  naive: 'NaiveProxy',
  snell: 'Snell',
  shadowtls: 'ShadowTLS',
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5',
}

export const DIAGNOSTIC_HELP = '已跳过表示该节点未输出；节点仍会输出表示仅列出的字段未能映射，相关能力可能失效。'

export function diagnosticDescription(item: SubscriptionDiagnostic['diagnostics'][number]): string {
  if (item.code === 'UNSUPPORTED_PROTOCOL') {
    return `已跳过：目标客户端不支持 ${PROTOCOL_LABELS[item.protocol ?? ''] ?? item.protocol ?? '该'} 协议`
  }
  if (item.code === 'INVALID_NODE') return '已跳过：节点缺少该客户端要求的必要字段'
  if (item.code === 'UNSUPPORTED_FIELD') {
    return item.outcome === 'skipped'
      ? '已跳过：节点包含目标客户端无法安全表达的字段'
      : '节点仍会输出，但以下字段未能安全映射'
  }
  return item.message
}
