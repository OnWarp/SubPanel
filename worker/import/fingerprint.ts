import { hashToken } from '../platform/crypto.js'
import type { JsonValue, Protocol } from '../catalog/schema.js'
import type { ParsedNode } from './model.js'

type FingerprintInput = {
  protocol: Protocol
  server: string
  port: number
  credentials: Record<string, JsonValue>
  tls?: Record<string, JsonValue>
  transport?: Record<string, JsonValue>
  plugin?: Record<string, JsonValue>
  extensions?: Record<string, JsonValue>
  [key: string]: unknown
}

const endpointKeys = new Set(['server', 'host', 'sni', 'servername', 'server_name', 'tls-name', 'address', 'peer', 'endpoint'])

function canonicalize(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return key && endpointKeys.has(key.toLowerCase()) ? value.toLowerCase() : value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, item]) => [entryKey, canonicalize(item, entryKey)]),
    )
  }
  return value
}

export function canonicalNodeJson(node: FingerprintInput | ParsedNode): string {
  const identity = {
    protocol: node.protocol,
    server: node.server,
    port: node.port,
    credentials: node.credentials,
    tls: node.tls,
    transport: node.transport,
    plugin: node.plugin,
    extensions: node.extensions,
  }
  return JSON.stringify(canonicalize(identity))
}

export async function fingerprintNode(node: FingerprintInput | ParsedNode): Promise<string> {
  return hashToken(canonicalNodeJson(node))
}
