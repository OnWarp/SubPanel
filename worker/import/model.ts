import type { ImportFormat, JsonValue, Protocol } from '../catalog/schema.js'

export type ImportWarning = {
  code: string
  message: string
  line?: number
}

export type ParsedNode = {
  protocol: Protocol
  displayName: string
  server: string
  port: number
  credentials: Record<string, JsonValue>
  tls?: Record<string, JsonValue>
  transport?: Record<string, JsonValue>
  plugin?: Record<string, JsonValue>
  extensions: Record<string, JsonValue>
  raw: string
  format: ImportFormat
}

export type ImportResult = {
  format: ImportFormat
  nodes: ParsedNode[]
  warnings: ImportWarning[]
}
