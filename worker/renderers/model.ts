import type { Node } from '../catalog/schema.js'
import type { ClientId } from '../delivery/schema.js'

export const CLIENT_IDS = [
  'mihomo',
  'singbox',
  'surge',
  'loon',
  'quantumultx',
  'v2rayn',
  'nekobox',
  'shadowrocket',
  'generic',
] as const satisfies readonly ClientId[]

export type RenderNode = Node
export type RenderClient = (typeof CLIENT_IDS)[number]

export type RenderDiagnostic = {
  nodeId: string
  nodeName?: string
  protocol?: string
  code: 'UNSUPPORTED_PROTOCOL' | 'UNSUPPORTED_FIELD' | 'INVALID_NODE'
  outcome?: 'included' | 'skipped'
  fields?: string[]
  message: string
}

export type RenderResult = {
  client: RenderClient
  body: string
  contentType: string
  fileName: string
  diagnostics: RenderDiagnostic[]
  inputNodes: number
  outputNodes: number
  skippedNodes: number
}
