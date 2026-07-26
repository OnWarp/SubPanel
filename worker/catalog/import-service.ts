import {
  type CatalogSnapshot,
  type ImportFormat,
  type Source,
  type SourceId,
  type SourceWarning,
} from './schema.js'
import { MAX_NODES, readCatalog, writeCatalog } from './repository.js'
import { fetchRemoteText, RemoteFetchError, validateRemoteHeaders, validateRemoteUrl } from './remote.js'
import {
  decryptText,
  encryptText,
  getOrCreateCryptoMaterial,
  readCryptoMaterial,
} from '../platform/crypto.js'
import { detectImport } from '../import/detect.js'
import { fingerprintNode } from '../import/fingerprint.js'
import type { ImportResult, ParsedNode } from '../import/model.js'
import { recompileAfterCatalogChange } from '../delivery/compiler.js'

export type CreateSourceInput =
  | { type: 'manual' | 'file'; name: string; content: string; enabled?: boolean }
  | {
    type: 'remote'
    name: string
    url: string
    headers?: Record<string, string>
    refreshIntervalMinutes: number
    enabled?: boolean
  }

export type ImportServiceOptions = {
  now?: string
  fetcher?: typeof fetch
}

export type SourceSummary = {
  id: SourceId
  name: string
  type: Source['type']
  enabled: boolean
  refreshIntervalMinutes?: number
  detectedFormat?: ImportFormat
  warnings: SourceWarning[]
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastErrorCode?: string
  remoteHost?: string
  createdAt: string
  updatedAt: string
}

export type SourceOperationResult = {
  success: boolean
  source: SourceSummary
  warning?: string
}

export type UpdateSourceInput = {
  name?: string
  enabled?: boolean
  content?: string
  url?: string
  headers?: Record<string, string>
  refreshIntervalMinutes?: number
}

type ImportErrorCode =
  | 'CATALOG_SOURCE_INVALID'
  | 'CATALOG_SOURCE_NOT_FOUND'
  | 'CATALOG_SOURCE_TYPE_INVALID'
  | 'CATALOG_NODE_LIMIT'
  | 'IMPORT_ZERO_NODES'
  | 'UNSUPPORTED_IMPORT_FORMAT'
  | 'IMPORT_FAILED'

export class CatalogImportError extends Error {
  readonly code: ImportErrorCode

  constructor(code: ImportErrorCode) {
    super(code)
    this.name = 'CatalogImportError'
    this.code = code
  }
}

function fail(code: ImportErrorCode): never {
  throw new CatalogImportError(code)
}

export const CATALOG_RECOMPILE_WARNING = 'Catalog 已保存，但订阅缓存编译失败，将在后续变更时重试'

export async function recompileDelivery(kv: KVNamespace): Promise<string | undefined> {
  try {
    await recompileAfterCatalogChange(kv)
    return undefined
  } catch {
    // Catalog remains the source of truth; a later mutation can retry derived artifacts.
    return CATALOG_RECOMPILE_WARNING
  }
}

function safeImportResult(content: string): ImportResult {
  let result: ImportResult
  try {
    result = detectImport(content)
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSUPPORTED_IMPORT_FORMAT') fail('UNSUPPORTED_IMPORT_FORMAT')
    fail('IMPORT_FAILED')
  }
  if (result.nodes.length === 0) fail('IMPORT_ZERO_NODES')
  return result
}

function safeErrorCode(error: unknown): string {
  if (error instanceof RemoteFetchError || error instanceof CatalogImportError) return error.code
  if (error instanceof Error && error.message === 'UNSUPPORTED_IMPORT_FORMAT') return 'UNSUPPORTED_IMPORT_FORMAT'
  return 'IMPORT_FAILED'
}

function sourceById(snapshot: CatalogSnapshot, sourceId: string): Source {
  const source = snapshot.sources.find(({ id }) => id === sourceId)
  if (!source) fail('CATALOG_SOURCE_NOT_FOUND')
  return source
}

function maskRemoteHost(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/gu, '')
    if (host.includes(':') || /^\d+(?:\.\d+){3}$/u.test(host)) return '***'
    const labels = host.split('.')
    labels[0] = labels[0] ? `${labels[0][0]}***` : '***'
    return labels.join('.')
  } catch {
    return undefined
  }
}

export function summarizeSource(source: Source, remoteUrl?: string): SourceSummary {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    enabled: source.enabled,
    refreshIntervalMinutes: source.refreshIntervalMinutes,
    detectedFormat: source.detectedFormat,
    warnings: source.warnings,
    lastAttemptAt: source.lastAttemptAt,
    lastSuccessAt: source.lastSuccessAt,
    lastErrorCode: source.lastErrorCode,
    remoteHost: maskRemoteHost(remoteUrl),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

export async function summarizeSources(kv: KVNamespace, sources: Source[]): Promise<SourceSummary[]> {
  const remoteSources = sources.filter((source) => source.type === 'remote' && source.encryptedUrl)
  let material: Awaited<ReturnType<typeof readCryptoMaterial>> | null = null
  if (remoteSources.length > 0) {
    try {
      material = await readCryptoMaterial(kv)
    } catch (error) {
      if (!(error instanceof Error && (error.message === 'Crypto material is missing' || error.message === 'Crypto material is corrupt'))) throw error
    }
  }
  return Promise.all(sources.map(async (source) => {
    if (!material || source.type !== 'remote' || !source.encryptedUrl) return summarizeSource(source)
    try {
      return summarizeSource(source, await decryptText(source.encryptedUrl, material.encryptionKey))
    } catch {
      return summarizeSource(source)
    }
  }))
}

async function applyImport(
  snapshot: CatalogSnapshot,
  sourceId: SourceId,
  result: ImportResult,
  now: string,
): Promise<CatalogSnapshot> {
  const next = structuredClone(snapshot)
  const fingerprinted = await Promise.all(result.nodes.map(async (node) => ({ node, fingerprint: await fingerprintNode(node) })))
  const variantsByFingerprint = new Map<string, ParsedNode[]>()
  for (const item of fingerprinted) {
    const variants = variantsByFingerprint.get(item.fingerprint) ?? []
    if (!variants.some(({ format, raw }) => format === item.node.format && raw === item.node.raw)) variants.push(item.node)
    variantsByFingerprint.set(item.fingerprint, variants)
  }

  const seen = new Set(variantsByFingerprint.keys())
  const byFingerprint = new Map(next.nodes.map((node) => [node.fingerprint, node]))
  let maxOrder = next.nodes.reduce((maximum, node) => Math.max(maximum, node.order), 0)
  for (const [fingerprint, parsedVariants] of variantsByFingerprint) {
    const parsed = parsedVariants[0]
    const rawVariants = parsedVariants.map((variant) => ({
      sourceId,
      format: variant.format,
      raw: variant.raw,
      extensions: variant.extensions,
    }))
    const existing = byFingerprint.get(fingerprint)
    if (existing) {
      if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId)
      existing.rawVariants = [
        ...existing.rawVariants.filter((variant) => variant.sourceId !== sourceId),
        ...rawVariants,
      ]
      existing.updatedAt = now
      continue
    }

    maxOrder += 1
    const node = {
      id: `node_${next.nextNodeId}` as const,
      protocol: parsed.protocol,
      displayName: parsed.displayName,
      server: parsed.server,
      port: parsed.port,
      credentials: parsed.credentials,
      tls: parsed.tls,
      transport: parsed.transport,
      plugin: parsed.plugin,
      extensions: parsed.extensions,
      fingerprint,
      sourceIds: [sourceId],
      rawVariants,
      enabled: true,
      retained: false,
      order: maxOrder,
      createdAt: now,
      updatedAt: now,
    }
    next.nextNodeId += 1
    next.nodes.push(node)
    byFingerprint.set(fingerprint, node)
  }

  const deletedIds = new Set<string>()
  next.nodes = next.nodes.filter((node) => {
    if (seen.has(node.fingerprint) || !node.sourceIds.includes(sourceId)) return true
    node.sourceIds = node.sourceIds.filter((id) => id !== sourceId)
    node.rawVariants = node.rawVariants.filter((variant) => variant.sourceId !== sourceId)
    node.updatedAt = now
    if (node.sourceIds.length > 0 || node.retained) return true
    deletedIds.add(node.id)
    return false
  })
  if (deletedIds.size > 0) {
    for (const group of next.groups) {
      group.includedNodeIds = group.includedNodeIds.filter((id) => !deletedIds.has(id))
      group.excludedNodeIds = group.excludedNodeIds.filter((id) => !deletedIds.has(id))
      group.nodeOrder = group.nodeOrder.filter((id) => !deletedIds.has(id))
      group.updatedAt = now
    }
  }
  if (next.nodes.length > MAX_NODES) fail('CATALOG_NODE_LIMIT')
  return next
}

function replaceSource(snapshot: CatalogSnapshot, source: Source): CatalogSnapshot {
  return {
    ...snapshot,
    sources: snapshot.sources.map((current) => current.id === source.id ? source : current),
  }
}

function newSourceId(snapshot: CatalogSnapshot): SourceId {
  return `src_${snapshot.nextSourceId}` as SourceId
}

function normalizedName(name: string): string {
  const result = name.trim()
  if (!result || result.length > 128) fail('CATALOG_SOURCE_INVALID')
  return result
}

export async function createSource(
  kv: KVNamespace,
  input: CreateSourceInput,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = await readCatalog(kv)
  const id = newSourceId(snapshot)
  const name = normalizedName(input.name)

  if (input.type !== 'remote') {
    const parsed = safeImportResult(input.content)
    const material = await getOrCreateCryptoMaterial(kv)
    const source: Source = {
      id,
      name,
      type: input.type,
      enabled: input.enabled ?? true,
      encryptedContent: await encryptText(input.content, material.encryptionKey),
      detectedFormat: parsed.format,
      warnings: parsed.warnings,
      lastAttemptAt: now,
      lastSuccessAt: now,
      createdAt: now,
      updatedAt: now,
    }
    const withSource = { ...snapshot, nextSourceId: snapshot.nextSourceId + 1, sources: [...snapshot.sources, source] }
    const saved = await writeCatalog(kv, await applyImport(withSource, id, parsed, now), now)
    const warning = await recompileDelivery(kv)
    return { success: true, source: summarizeSource(sourceById(saved, id)), ...(warning ? { warning } : {}) }
  }

  if (!Number.isInteger(input.refreshIntervalMinutes) || input.refreshIntervalMinutes <= 0 || input.refreshIntervalMinutes % 15 !== 0) {
    fail('CATALOG_SOURCE_INVALID')
  }
  const safeUrl = validateRemoteUrl(input.url).href
  const safeHeaders = validateRemoteHeaders(input.headers ?? {})
  const material = await getOrCreateCryptoMaterial(kv)
  let source: Source = {
    id,
    name,
    type: 'remote',
    enabled: input.enabled ?? true,
    encryptedUrl: await encryptText(safeUrl, material.encryptionKey),
    encryptedHeaders: await encryptText(JSON.stringify(safeHeaders), material.encryptionKey),
    refreshIntervalMinutes: input.refreshIntervalMinutes,
    warnings: [],
    lastAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }
  let next: CatalogSnapshot = { ...snapshot, nextSourceId: snapshot.nextSourceId + 1, sources: [...snapshot.sources, source] }
  let success = false
  try {
    const content = await fetchRemoteText({ url: safeUrl, headers: safeHeaders }, options.fetcher)
    const parsed = safeImportResult(content)
    source = {
      ...source,
      encryptedContent: await encryptText(content, material.encryptionKey),
      detectedFormat: parsed.format,
      warnings: parsed.warnings,
      lastSuccessAt: now,
      lastErrorCode: undefined,
    }
    next = await applyImport(replaceSource(next, source), id, parsed, now)
    success = true
  } catch (error) {
    source = { ...source, lastErrorCode: safeErrorCode(error) }
    next = replaceSource(next, source)
  }
  const saved = await writeCatalog(kv, next, now)
  const warning = await recompileDelivery(kv)
  return { success, source: summarizeSource(sourceById(saved, id), safeUrl), ...(warning ? { warning } : {}) }
}

export async function replaceSourceContent(
  kv: KVNamespace,
  sourceId: string,
  content: string,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = await readCatalog(kv)
  const current = sourceById(snapshot, sourceId)
  if (current.type === 'remote') fail('CATALOG_SOURCE_TYPE_INVALID')
  const material = await readCryptoMaterial(kv)
  const parsed = safeImportResult(content)
  const source: Source = {
    ...current,
    encryptedContent: await encryptText(content, material.encryptionKey),
    detectedFormat: parsed.format,
    warnings: parsed.warnings,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastErrorCode: undefined,
    updatedAt: now,
  }
  const saved = await writeCatalog(kv, await applyImport(replaceSource(snapshot, source), current.id, parsed, now), now)
  const warning = await recompileDelivery(kv)
  return { success: true, source: summarizeSource(sourceById(saved, current.id)), ...(warning ? { warning } : {}) }
}

export async function updateSource(
  kv: KVNamespace,
  sourceId: string,
  input: UpdateSourceInput,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = await readCatalog(kv)
  const current = sourceById(snapshot, sourceId)
  const name = input.name === undefined ? current.name : normalizedName(input.name)
  let source: Source = { ...current, name, enabled: input.enabled ?? current.enabled, updatedAt: now }
  let next = replaceSource(snapshot, source)

  if (current.type === 'remote') {
    if (input.content !== undefined) fail('CATALOG_SOURCE_TYPE_INVALID')
    if (input.refreshIntervalMinutes !== undefined && (!Number.isInteger(input.refreshIntervalMinutes) || input.refreshIntervalMinutes <= 0 || input.refreshIntervalMinutes % 15 !== 0)) {
      fail('CATALOG_SOURCE_INVALID')
    }
    const material = input.url !== undefined || input.headers !== undefined
      ? await readCryptoMaterial(kv)
      : null
    if (input.url !== undefined) {
      const url = validateRemoteUrl(input.url).href
      source = { ...source, encryptedUrl: await encryptText(url, material!.encryptionKey) }
    }
    if (input.headers !== undefined) {
      const safeValues = validateRemoteHeaders(input.headers)
      source = { ...source, encryptedHeaders: await encryptText(JSON.stringify(safeValues), material!.encryptionKey) }
    }
    if (input.refreshIntervalMinutes !== undefined) source = { ...source, refreshIntervalMinutes: input.refreshIntervalMinutes }
    next = replaceSource(snapshot, source)
    const saved = await writeCatalog(kv, next, now)
    const warning = await recompileDelivery(kv)
    let remoteUrl: string | undefined
    try {
      const encrypted = source.encryptedUrl
      if (encrypted && material) remoteUrl = await decryptText(encrypted, material.encryptionKey)
    } catch {
      remoteUrl = undefined
    }
    return { success: true, source: summarizeSource(sourceById(saved, current.id), remoteUrl), ...(warning ? { warning } : {}) }
  }

  if (input.url !== undefined || input.headers !== undefined || input.refreshIntervalMinutes !== undefined) {
    fail('CATALOG_SOURCE_TYPE_INVALID')
  }
  if (input.content !== undefined) {
    const material = await readCryptoMaterial(kv)
    const parsed = safeImportResult(input.content)
    source = {
      ...source,
      encryptedContent: await encryptText(input.content, material.encryptionKey),
      detectedFormat: parsed.format,
      warnings: parsed.warnings,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorCode: undefined,
    }
    next = await applyImport(replaceSource(snapshot, source), current.id, parsed, now)
  }
  const saved = await writeCatalog(kv, next, now)
  const warning = await recompileDelivery(kv)
  return { success: true, source: summarizeSource(sourceById(saved, current.id)), ...(warning ? { warning } : {}) }
}

function parsedHeaders(value: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    fail('IMPORT_FAILED')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('IMPORT_FAILED')
  const result: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== 'string') fail('IMPORT_FAILED')
    result[name] = headerValue
  }
  return validateRemoteHeaders(result)
}

export async function refreshSource(
  kv: KVNamespace,
  sourceId: string,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = await readCatalog(kv)
  const current = sourceById(snapshot, sourceId)
  if (current.type !== 'remote' || !current.encryptedUrl || !current.encryptedHeaders) fail('CATALOG_SOURCE_TYPE_INVALID')

  let remoteUrl: string | undefined
  try {
    const material = await readCryptoMaterial(kv)
    remoteUrl = await decryptText(current.encryptedUrl, material.encryptionKey)
    const headers = parsedHeaders(await decryptText(current.encryptedHeaders, material.encryptionKey))
    const content = await fetchRemoteText({ url: remoteUrl, headers }, options.fetcher)
    const parsed = safeImportResult(content)
    const source: Source = {
      ...current,
      encryptedContent: await encryptText(content, material.encryptionKey),
      detectedFormat: parsed.format,
      warnings: parsed.warnings,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorCode: undefined,
      updatedAt: now,
    }
    const saved = await writeCatalog(kv, await applyImport(replaceSource(snapshot, source), current.id, parsed, now), now)
    const warning = await recompileDelivery(kv)
    return { success: true, source: summarizeSource(sourceById(saved, current.id), remoteUrl), ...(warning ? { warning } : {}) }
  } catch (error) {
    const source: Source = {
      ...current,
      lastAttemptAt: now,
      lastErrorCode: safeErrorCode(error),
      updatedAt: now,
    }
    const saved = await writeCatalog(kv, replaceSource(snapshot, source), now)
    const warning = await recompileDelivery(kv)
    return { success: false, source: summarizeSource(sourceById(saved, current.id), remoteUrl), ...(warning ? { warning } : {}) }
  }
}

export async function deleteSource(
  kv: KVNamespace,
  sourceId: string,
  options: ImportServiceOptions = {},
): Promise<string | undefined> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = structuredClone(await readCatalog(kv))
  const source = sourceById(snapshot, sourceId)
  snapshot.sources = snapshot.sources.filter(({ id }) => id !== source.id)
  const deletedIds = new Set<string>()
  snapshot.nodes = snapshot.nodes.filter((node) => {
    if (!node.sourceIds.includes(source.id)) return true
    node.sourceIds = node.sourceIds.filter((id) => id !== source.id)
    node.rawVariants = node.rawVariants.filter((variant) => variant.sourceId !== source.id)
    node.updatedAt = now
    if (node.sourceIds.length > 0 || node.retained) return true
    deletedIds.add(node.id)
    return false
  })
  for (const group of snapshot.groups) {
    group.sourceIds = group.sourceIds.filter((id) => id !== source.id)
    group.includedNodeIds = group.includedNodeIds.filter((id) => !deletedIds.has(id))
    group.excludedNodeIds = group.excludedNodeIds.filter((id) => !deletedIds.has(id))
    group.nodeOrder = group.nodeOrder.filter((id) => !deletedIds.has(id))
    group.updatedAt = now
  }
  await writeCatalog(kv, snapshot, now)
  return recompileDelivery(kv)
}
