import { parseDocument } from 'yaml'
import { containsRecognizedUri, decodeSubscriptionBase64 } from './base64.js'
import { isLoonContent, parseLoon } from './loon.js'
import { isMihomoProxyEntry, parseMihomo } from './mihomo.js'
import type { ImportResult } from './model.js'
import { isQuantumultXContent, parseQuantumultX } from './quantumultx.js'
import { parseSingBox } from './singbox.js'
import { parseSip008 } from './sip008.js'
import { isSurgeContent, parseSurge } from './surge.js'
import { parseUriList } from './uri.js'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function detectSingle(trimmed: string): ImportResult {
  try {
    const json: unknown = JSON.parse(trimmed)
    const root = record(json)
    if (root?.version === 1 && Array.isArray(root.servers)) return parseSip008(trimmed)
    if (isMihomoProxyEntry(json) || (Array.isArray(json) && json.some(isMihomoProxyEntry))) return parseMihomo(trimmed)
    if (Array.isArray(json) || Array.isArray(root?.outbounds)) return parseSingBox(trimmed)
  } catch {
    // Continue with non-JSON containers.
  }

  try {
    const document = parseDocument(trimmed, { merge: false })
    if (document.errors.length === 0) {
      const value: unknown = document.toJS({ maxAliasCount: 20 })
      const root = record(value)
      if (Array.isArray(root?.proxies) || Array.isArray(root?.payload) || isMihomoProxyEntry(value) || (Array.isArray(value) && value.some(isMihomoProxyEntry))) return parseMihomo(trimmed)
    }
  } catch {
    // Continue with line-oriented containers.
  }

  if (isQuantumultXContent(trimmed)) return parseQuantumultX(trimmed)
  if (isSurgeContent(trimmed)) return parseSurge(trimmed)
  if (isLoonContent(trimmed)) return parseLoon(trimmed)
  if (containsRecognizedUri(trimmed)) return parseUriList(trimmed)
  const decoded = decodeSubscriptionBase64(trimmed)
  if (decoded) return parseUriList(decoded)
  throw new Error('UNSUPPORTED_IMPORT_FORMAT')
}

export function detectImport(content: string): ImportResult {
  const trimmed = content.trimEnd()
  if (!trimmed.trim()) throw new Error('UNSUPPORTED_IMPORT_FORMAT')

  const blocks = trimmed.split(/^\s*[-=*]{5,}\s*$/gmu).map((block) => block.trim()).filter(Boolean)
  if (blocks.length > 1) {
    const nodes: ImportResult['nodes'] = []
    const warnings: ImportResult['warnings'] = []
    const seen = new Set<string>()
    for (const block of blocks) {
      let result: ImportResult
      try {
        result = detectSingle(block)
      } catch {
        warnings.push({ code: 'UNSUPPORTED_IMPORT_BLOCK', message: 'Unable to detect one mixed import block' })
        continue
      }
      warnings.push(...result.warnings)
      for (const node of result.nodes) {
        const key = `${node.protocol}\u0000${node.server}\u0000${node.port}\u0000${node.displayName}`
        if (seen.has(key)) continue
        seen.add(key)
        nodes.push(node)
      }
    }
    if (nodes.length > 0) return { format: 'mixed', nodes, warnings }
  }
  return detectSingle(trimmed)
}
