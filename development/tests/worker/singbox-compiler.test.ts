import { describe, it, expect } from 'vitest'
import { compileSingBoxConfig, TARGET_SINGBOX_VERSION, SINGBOX_SUPPORTED_PROTOCOLS } from '../../../worker/renderers/singbox.js'
import { validateTemplate } from '../../../worker/templates/validation.js'
import type { RenderNode } from '../../../worker/renderers/model.js'

const sampleYaml = `subpanel:
  nodes:
    prefix: "亚太 · "
proxy-groups:
  - name: Proxy
    type: select
    proxies: [Fast, Backup, Balance, DIRECT]
  - name: Fast
    type: url-test
    url: https://www.gstatic.com/generate_204
    tolerance: 50
    proxies: ["$SUBPANEL_NODES"]
  - name: Backup
    type: fallback
    url: https://www.gstatic.com/generate_204
    proxies: ["$SUBPANEL_NODES"]
  - name: Balance
    type: load-balance
    strategy: round-robin
    proxies: ["$SUBPANEL_NODES"]
rules:
  - DOMAIN-SUFFIX,example.org,DIRECT
  - IP-CIDR,192.168.0.0/16,DIRECT
  - MATCH,Proxy
`

function makeNode(overrides: Partial<RenderNode>): RenderNode {
  return {
    id: 'n_' + Math.random().toString(36).slice(2, 8),
    displayName: '节点',
    protocol: 'shadowsocks',
    server: 'server.example.com',
    port: 8388,
    enabled: true,
    credentials: { method: 'aes-128-gcm', password: 'test-password' },
    rawVariants: [],
    tls: {},
    transport: {},
    plugin: {},
    extensions: {},
    ...overrides,
  }
}

describe('sing-box configuration compiler (CORE-07)', () => {
  it('defines target version as 1.14 and lists supported protocols', () => {
    expect(TARGET_SINGBOX_VERSION).toBe('1.14')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('shadowsocks')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('vmess')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('vless')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('trojan')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('hysteria2')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('tuic')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('anytls')
    expect(SINGBOX_SUPPORTED_PROTOCOLS).toContain('naive')
  })

  it('compiles full sing-box config with outbounds, route, dns, and policy groups', () => {
    const template = validateTemplate(sampleYaml).template
    const nodes = [
      makeNode({ displayName: '东京 01', protocol: 'shadowsocks' }),
      makeNode({ displayName: '新加坡 01', protocol: 'shadowsocks' }),
    ]
    const result = compileSingBoxConfig(template, nodes)
    expect(result.outputNodes).toBe(2)
    expect(result.skippedNodes).toBe(0)
    expect(result.config).toHaveProperty('outbounds')
    expect(result.config).toHaveProperty('route')
    expect(result.config).toHaveProperty('dns')

    const outbounds = result.config.outbounds as Array<Record<string, unknown>>
    const tags = outbounds.map(o => o.tag)
    expect(tags).toContain('Proxy')
    expect(tags).toContain('Fast')
    expect(tags).toContain('Backup')
    expect(tags).toContain('Balance')
    expect(tags).toContain('东京 01')
    expect(tags).toContain('新加坡 01')
    expect(tags).toContain('direct')
    expect(tags).toContain('block')

    const route = result.config.route as Record<string, unknown>
    expect(route.final).toBe('Proxy')
    expect(route.auto_detect_interface).toBe(true)

    const dns = result.config.dns as Record<string, unknown>
    expect(dns.strategy).toBe('prefer_ipv4')
    expect(Array.isArray(dns.servers)).toBe(true)
  })

  it('validates generated singbox JSON structure complies with singbox schema', () => {
    const template = validateTemplate(sampleYaml).template
    const nodes = [
      makeNode({ displayName: '东京中继', protocol: 'shadowsocks' }),
      makeNode({ displayName: '新加坡中继', protocol: 'shadowsocks' }),
    ]
    const result = compileSingBoxConfig(template, nodes)
    const parsed = JSON.parse(result.json) as Record<string, unknown>
    expect(parsed).toHaveProperty('outbounds')
    expect(parsed).toHaveProperty('route')
    expect(parsed).toHaveProperty('dns')
    expect(Array.isArray(parsed.outbounds)).toBe(true)
    expect(typeof parsed.route).toBe('object')
    expect(typeof parsed.dns).toBe('object')
  })

  it('diagnoses and skips unsupported protocols without silent drop', () => {
    const template = validateTemplate(sampleYaml).template
    const nodes = [
      makeNode({ displayName: 'Valid SS', protocol: 'shadowsocks' }),
      makeNode({ displayName: 'Unsupported Snell', protocol: 'snell' }),
      makeNode({ displayName: 'Unsupported SSR', protocol: 'ssr' }),
      makeNode({ displayName: 'Unsupported extension', extensions: { shadowtls: {} } }),
    ]
    const result = compileSingBoxConfig(template, nodes)
    expect(result.outputNodes).toBe(1)
    expect(result.skippedNodes).toBe(3)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_PROTOCOL',
          outcome: 'skipped',
          protocol: 'snell',
        }),
        expect.objectContaining({
          code: 'UNSUPPORTED_PROTOCOL',
          outcome: 'skipped',
          protocol: 'ssr',
        }),
        expect.objectContaining({ outcome: 'skipped', fields: ['extensions.shadowtls'] }),
      ]),
    )
  })

  it('diagnoses and skips nodes missing required fields', () => {
    const template = validateTemplate(sampleYaml).template
    const nodes = [
      makeNode({ displayName: 'No password', protocol: 'trojan', credentials: {} }),
      makeNode({ displayName: 'No UUID', protocol: 'vmess', credentials: {} }),
    ]
    const result = compileSingBoxConfig(template, nodes)
    expect(result.outputNodes).toBe(0)
    expect(result.skippedNodes).toBe(2)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_FIELD',
          outcome: 'skipped',
          nodeName: 'No password',
        }),
        expect.objectContaining({
          code: 'UNSUPPORTED_FIELD',
          outcome: 'skipped',
          nodeName: 'No UUID',
        }),
      ]),
    )
  })

  it('throws TemplateValidationError on non-existent outbound references in policy groups', () => {
    const badYaml = `
proxy-groups:
  - name: Proxy
    type: select
    proxies: [NonExistentGroup, DIRECT]
rules:
  - MATCH,Proxy
`
    expect(() => validateTemplate(badYaml)).toThrow(/未知目标 NonExistentGroup/)
  })

  it('compiles rule_set when template defines rule-providers', () => {
    const yamlWithRuleset = `
proxy-groups:
  - name: Proxy
    type: select
    proxies: ["$SUBPANEL_NODES", DIRECT]
rule-providers:
  geoip-cn:
    type: http
    behavior: domain
    format: mrs
    url: https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs
rules:
  - RULE-SET,geoip-cn,DIRECT
  - MATCH,Proxy
`
    const template = validateTemplate(yamlWithRuleset).template
    expect(() => compileSingBoxConfig(template, [])).toThrow(/验证引用的规则集/)
    const ruleSets = [{ tag: 'geoip-cn', type: 'inline', rules: [{ domain: ['example.org'] }] }]
    const result = compileSingBoxConfig(template, [makeNode({ displayName: 'Node 1' })], { ruleSets })
    const route = result.config.route as { rule_set?: Array<Record<string, unknown>> }
    expect(route.rule_set).toBeDefined()
    expect(route.rule_set?.[0]).toMatchObject({
      tag: 'geoip-cn',
      type: 'inline',
      rules: [{ domain: ['example.org'] }],
    })
  })
})
