import { z } from 'zod'
import type { RenderNode } from '../renderers/model.js'

// A bounded regex subset without groups, repetition, alternation or backreferences.
const pattern = z.string().min(1).max(128).refine(value => {
  if (!/^(?:\\[dDsSwW.^$\\]|\[(?:[^\x5b\]\\]|\\[dDsSwW])+\]|[^\\\x5b\](){}+*?|])+$/.test(value)) return false
  try { new RegExp(value, 'u'); return true } catch { return false }
}, '正则支持字符、字符类和锚点')

export const nodeLayer = z.object({
  prefix: z.string().max(64).optional(),
  suffix: z.string().max(64).optional(),
  rename: z.array(z.object({ pattern, replacement: z.string().max(128) }).strict()).max(8).optional(),
  exclude: z.array(pattern).max(8).optional(),
  sort: z.enum(['original', 'name']).optional(),
  deduplicate: z.enum(['none', 'name']).optional(),
}).strict()

export const mihomoClientLayer = z.object({
  dns: z.object({ enable: z.boolean(), nameserver: z.array(z.string().min(1).max(256)).min(1).max(16).optional() }).strict(),
  tun: z.object({ enable: z.boolean(), stack: z.enum(['system', 'gvisor', 'mixed']).optional(), 'auto-route': z.boolean().optional() }).strict(),
  mode: z.literal('rule'),
  port: z.number().int().min(0).max(65535),
  'mixed-port': z.number().int().min(0).max(65535),
  'socks-port': z.number().int().min(0).max(65535),
  sniffer: z.object({ enable: z.boolean() }).strict(),
  'geodata-mode': z.boolean(),
  'geodata-loader': z.enum(['standard', 'memconservative']),
  ipv6: z.boolean(),
  'log-level': z.enum(['silent', 'error', 'warning', 'info', 'debug']),
}).partial().strict()

export function prepareNodeLayer(nodes: RenderNode[], layer?: z.infer<typeof nodeLayer>) {
  if (!layer) return nodes
  const excludes = (layer.exclude ?? []).map(value => new RegExp(value, 'u'))
  const renames = (layer.rename ?? []).map(({ pattern, replacement }) => ({ regex: new RegExp(pattern, 'u'), replacement }))
  const names = new Set<string>()
  const result = nodes.flatMap(node => {
    if (excludes.some(regex => regex.test(node.displayName))) return []
    const renamed = renames.reduce((name, { regex, replacement }) => name.replace(regex, () => replacement), node.displayName)
    const displayName = `${layer.prefix ?? ''}${renamed}${layer.suffix ?? ''}`
    const key = displayName.replace(/\p{Cc}/gu, ' ').trim() || 'Node'
    if (layer.deduplicate === 'name' && names.has(key)) return []
    names.add(key)
    return [{ ...node, displayName }]
  })
  if (layer.sort === 'name') result.sort((left, right) => left.displayName < right.displayName ? -1 : Number(left.displayName > right.displayName))
  return result
}
