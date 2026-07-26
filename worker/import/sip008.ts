import { z } from 'zod'
import { jsonValueSchema, type JsonValue } from '../catalog/schema.js'
import type { ImportResult, ParsedNode } from './model.js'

const serverSchema = z.record(z.string(), z.unknown())
const rootSchema = z.object({ version: z.literal(1), servers: z.array(serverSchema) })

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing string')
  return value
}

function port(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid port')
  return result
}

function pluginOptions(value: unknown): Record<string, JsonValue> | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const result: Record<string, JsonValue> = {}
  for (const part of value.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) result[part] = true
    else result[part.slice(0, separator)] = part.slice(separator + 1)
  }
  return result
}

function parseServer(entry: Record<string, unknown>): ParsedNode {
  const server = requiredString(entry.server)
  const consumed = new Set([
    'id',
    'remarks',
    'server',
    'server_port',
    'password',
    'method',
    'plugin',
    'plugin_opts',
    'bytes_used',
    'bytes_remaining',
  ])
  const extensions: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (consumed.has(key)) continue
    const parsed = jsonValueSchema.safeParse(value)
    if (parsed.success) extensions[key] = parsed.data
  }
  const pluginName = typeof entry.plugin === 'string' && entry.plugin ? entry.plugin : undefined
  const options = pluginOptions(entry.plugin_opts)
  return {
    protocol: 'shadowsocks',
    displayName: typeof entry.remarks === 'string' && entry.remarks ? entry.remarks : `shadowsocks ${server}`,
    server,
    port: port(entry.server_port),
    credentials: { method: requiredString(entry.method), password: requiredString(entry.password) },
    plugin: pluginName ? { name: pluginName, ...(options ? { options } : {}) } : undefined,
    extensions,
    raw: JSON.stringify(entry),
    format: 'sip008',
  }
}

export function parseSip008(content: string): ImportResult {
  let root: z.infer<typeof rootSchema>
  try {
    root = rootSchema.parse(JSON.parse(content))
  } catch {
    throw new Error('Invalid SIP008 document')
  }
  const nodes: ParsedNode[] = []
  const warnings: ImportResult['warnings'] = []
  for (const entry of root.servers) {
    try {
      nodes.push(parseServer(entry))
    } catch {
      warnings.push({ code: 'INVALID_SIP008_SERVER', message: 'Invalid SIP008 server entry' })
    }
  }
  return { format: 'sip008', nodes, warnings }
}
