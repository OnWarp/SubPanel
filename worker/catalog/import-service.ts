import {
  type CatalogSnapshot,
  type EncryptedValue,
  type ImportFormat,
  type formatOverrideSchema,
  type Source,
  type SourceId,
  type NodeId,
  type SourceWarning,
} from './schema.js'
import type { DataEnv } from '../db/module-switch.js'
import { MAX_NODES, readCatalog, writeCatalog } from './repository.js'
import { fetchRemoteTextWithPolicy as fetchRemoteTextWithMetadata } from './egress-policy.js'
import { RemoteFetchError, validateRemoteHeaders, validateRemoteUrl } from './remote.js'
import {
  decryptText,
  encryptText,
  getOrCreateCryptoMaterial,
  readCryptoMaterial,
} from '../platform/crypto.js'
import { importWithFormat } from '../import/detect.js'
import { fingerprintNode } from '../import/fingerprint.js'
import type { ImportResult, ParsedNode } from '../import/model.js'

export type CreateSourceInput =
  | { type: 'manual' | 'file'; name: string; content: string; enabled?: boolean; keepOnFailure?: boolean }
  | {
    type: 'remote'
    name: string
    url: string
    headers?: Record<string, string>
    formatOverride?: FormatOverride
    deferSync?: boolean
    refreshIntervalMinutes: number
    enabled?: boolean
    keepOnFailure?: boolean
  }

type FormatOverride = (typeof formatOverrideSchema.options)[number]

export type ImportServiceOptions = {
  now?: string
  fetcher?: typeof fetch
  previewId?: string
}

export type SourceSummary = {
  id: SourceId
  name: string
  type: Source['type']
  enabled: boolean
  keepOnFailure: boolean
  refreshIntervalMinutes?: number
  detectedFormat?: ImportFormat
  sync?: Source['sync']
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
  keepOnFailure?: boolean
  content?: string
  url?: string
  headers?: Record<string, string>
  refreshIntervalMinutes?: number
  formatOverride?: FormatOverride | null
}

type ImportErrorCode =
  | 'CATALOG_SOURCE_INVALID'
  | 'CATALOG_SOURCE_NOT_FOUND'
  | 'CATALOG_SOURCE_TYPE_INVALID'
  | 'CATALOG_NODE_LIMIT'
  | 'IMPORT_ZERO_NODES'
  | 'UNSUPPORTED_IMPORT_FORMAT'
  | 'IMPORT_FAILED'
  | 'CATALOG_SYNC_BUSY'
  | 'CATALOG_PREVIEW_STALE'

export class CatalogImportError extends Error {
  readonly code: ImportErrorCode
  readonly warnings?: SourceWarning[]
  httpStatus?: number

  constructor(code: ImportErrorCode, warnings?: SourceWarning[]) {
    super(code)
    this.name = 'CatalogImportError'
    this.code = code
    this.warnings = warnings
  }
}

function fail(code: ImportErrorCode): never {
  throw new CatalogImportError(code)
}

function safeImportResult(content: string, format?: ImportFormat): ImportResult {
  let result: ImportResult
  try {
    result = importWithFormat(content, format)
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSUPPORTED_IMPORT_FORMAT') fail('UNSUPPORTED_IMPORT_FORMAT')
    fail('IMPORT_FAILED')
  }
  if (result.nodes.length === 0) throw new CatalogImportError('IMPORT_ZERO_NODES', result.warnings)
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
  const { etag: _etag, ...sync } = source.sync ?? {}
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    enabled: source.enabled,
    keepOnFailure: source.keepOnFailure,
    refreshIntervalMinutes: source.refreshIntervalMinutes,
    detectedFormat: source.detectedFormat,
    sync: source.sync ? sync : undefined,
    warnings: source.warnings,
    lastAttemptAt: source.lastAttemptAt,
    lastSuccessAt: source.lastSuccessAt,
    lastErrorCode: source.lastErrorCode,
    remoteHost: maskRemoteHost(remoteUrl),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

export async function summarizeSources(env: DataEnv, sources: Source[]): Promise<SourceSummary[]> {
  const remoteSources = sources.filter((source) => source.type === 'remote' && source.encryptedUrl)
  let material: Awaited<ReturnType<typeof readCryptoMaterial>> | null = null
  if (remoteSources.length > 0) {
    try {
      material = await readCryptoMaterial(env.DATA)
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

async function groupParsedVariants(nodes: ParsedNode[]) {
  const entries = await Promise.all(nodes.map(async (node) => ({ node, fingerprint: await fingerprintNode(node) })))
  const groups = new Map<string, ParsedNode[]>()
  for (const { node, fingerprint } of entries) {
    const variants = groups.get(fingerprint) ?? []
    if (!variants.some(({ format, raw }) => format === node.format && raw === node.raw)) variants.push(node)
    groups.set(fingerprint, variants)
  }
  return groups
}

async function applyImport(
  snapshot: CatalogSnapshot,
  sourceId: SourceId,
  nodes: ParsedNode[],
  now: string,
  variants?: Map<string, ParsedNode[]>,
): Promise<CatalogSnapshot> {
  const next = structuredClone(snapshot)
  const variantsByFingerprint = variants ?? await groupParsedVariants(nodes)
  const seen = new Set(variantsByFingerprint.keys())
  const byFingerprint = new Map(next.nodes
    .filter((node) => node.sourceIds.includes(sourceId) || node.fingerprint.startsWith(`${sourceId}:`))
    .map((node) => [node.sourceFingerprint ?? node.fingerprint, node]))
  const remote = sourceById(snapshot, sourceId).type === 'remote'
  let maxOrder = next.nodes.reduce((maximum, node) => Math.max(maximum, node.order), 0)
  for (const [fingerprint, parsedVariants] of variantsByFingerprint) {
    const parsed = parsedVariants[0]
    const rawVariants = parsedVariants.map((variant) => ({
      sourceId,
      format: variant.format,
      raw: variant.raw,
      extensions: variant.extensions,
    }))
    let existing = byFingerprint.get(fingerprint)
    let originNodeId: NodeId | undefined
    if (existing && existing.sourceIds.length > 1) {
      originNodeId = existing.id
      existing.sourceIds = existing.sourceIds.filter((id) => id !== sourceId)
      existing.rawVariants = existing.rawVariants.filter((variant) => variant.sourceId !== sourceId)
      existing = undefined
    }
    if (existing) {
      if (!existing.sourceFingerprint && existing.updatedAt !== existing.createdAt) existing.displayNameOverride ??= existing.displayName
      existing.sourceFingerprint = fingerprint
      existing.originNodeId ??= existing.id
      existing.displayName = existing.displayNameOverride ?? parsed.displayName
      if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId)
      existing.lastSeenAt = now
      existing.missingSince = undefined
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
      fingerprint: `${sourceId}:${fingerprint}`,
      sourceFingerprint: fingerprint,
      originNodeId: originNodeId ?? `node_${next.nextNodeId}` as const,
      lastSeenAt: now,
      sourceIds: [sourceId],
      rawVariants,
      enabled: true,
      retained: false,
      order: maxOrder,
      createdAt: now,
      updatedAt: now,
    }
    if (originNodeId) {
      const original = next.nodes.find(({ id }) => id === originNodeId)!
      Object.assign(node, {
        order: original.order,
        enabled: original.enabled,
        retained: original.retained,
        displayName: original.displayNameOverride ?? original.displayName,
        displayNameOverride: original.displayNameOverride,
        tags: original.tags,
        region: original.region,
      })
      for (const group of next.groups) {
        for (const list of [group.includedNodeIds, group.excludedNodeIds, group.nodeOrder]) {
          const position = list.indexOf(originNodeId)
          if (position >= 0) list.splice(position + 1, 0, node.id)
        }
      }
    }
    next.nextNodeId += 1
    next.nodes.push(node)
    byFingerprint.set(fingerprint, node)
  }

  const deletedIds = new Set<string>()
  next.nodes = next.nodes.filter((node) => {
    if (seen.has(node.sourceFingerprint ?? node.fingerprint) || !node.sourceIds.includes(sourceId)) return true
    if (remote && node.sourceIds.length === 1) {
      node.missingSince ??= now
      if (Date.parse(now) - Date.parse(node.missingSince) < 24 * 60 * 60_000) return true
    }
    node.sourceIds = node.sourceIds.filter((id) => id !== sourceId)
    node.missingSince = undefined
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
  env: DataEnv,
  input: CreateSourceInput,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = await readCatalog(env)
  const id = newSourceId(snapshot)
  const name = normalizedName(input.name)

  if (input.type !== 'remote') {
    const parsed = safeImportResult(input.content)
    const material = await getOrCreateCryptoMaterial(env.DATA)
    const source: Source = {
      id,
      name,
      type: input.type,
      enabled: input.enabled ?? true,
      keepOnFailure: input.keepOnFailure ?? true,
      encryptedContent: await encryptText(input.content, material.encryptionKey),
      detectedFormat: parsed.format,
      warnings: parsed.warnings,
      lastAttemptAt: now,
      lastSuccessAt: now,
      createdAt: now,
      updatedAt: now,
    }
    const withSource = { ...snapshot, nextSourceId: snapshot.nextSourceId + 1, sources: [...snapshot.sources, source] }
    const saved = await writeCatalog(env, await applyImport(withSource, id, parsed.nodes, now), now)
    return { success: true, source: summarizeSource(sourceById(saved, id)) }
  }

  if (!Number.isInteger(input.refreshIntervalMinutes) || input.refreshIntervalMinutes <= 0 || input.refreshIntervalMinutes % 15 !== 0) {
    fail('CATALOG_SOURCE_INVALID')
  }
  const safeUrl = validateRemoteUrl(input.url).href
  const safeHeaders = validateRemoteHeaders(input.headers ?? {})
  const material = await getOrCreateCryptoMaterial(env.DATA)
  let source: Source = {
    id,
    name,
    type: 'remote',
    enabled: input.enabled ?? true,
    keepOnFailure: input.keepOnFailure ?? true,
    sync: input.formatOverride ? { formatOverride: input.formatOverride } : undefined,
    encryptedUrl: await encryptText(safeUrl, material.encryptionKey),
    encryptedHeaders: await encryptText(JSON.stringify(safeHeaders), material.encryptionKey),
    refreshIntervalMinutes: input.refreshIntervalMinutes,
    warnings: [],
    lastAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }
  let next: CatalogSnapshot = { ...snapshot, nextSourceId: snapshot.nextSourceId + 1, sources: [...snapshot.sources, source] }
  if (input.deferSync) {
    delete source.lastAttemptAt
    const saved = await writeCatalog(env, next, now)
    return { success: true, source: summarizeSource(sourceById(saved, id), safeUrl) }
  }
  let success = false
  const started = Date.now()
  try {
    const result = await boundedSourceSync(env, id, async (signal, checkCancelled) => {
      const response = await fetchRemoteTextWithMetadata({ url: safeUrl, headers: safeHeaders }, options.fetcher, undefined, signal)
      await checkCancelled()
      return response
    })
    if (result.notModified) fail('IMPORT_FAILED')
    const { text: content } = result
    const parsed = safeImportResult(content, input.formatOverride)
    source = {
      ...source,
      encryptedContent: await encryptText(content, material.encryptionKey),
      detectedFormat: parsed.format,
      warnings: parsed.warnings,
      lastSuccessAt: now,
      lastErrorCode: undefined,
      sync: { ...source.sync, consecutiveFailures: 0, httpStatus: result.status,
        durationMs: Date.now() - started },
    }
    next = await applyImport(replaceSource(next, source), id, parsed.nodes, now)
    success = true
  } catch (error) {
    if (error instanceof CatalogImportError && error.code === 'CATALOG_SYNC_BUSY') throw error
    source = { ...source, lastErrorCode: safeErrorCode(error), sync: {
      ...source.sync, firstFailureAt: now, consecutiveFailures: 1, durationMs: Date.now() - started,
      httpStatus: (error instanceof RemoteFetchError || error instanceof CatalogImportError) ? error.httpStatus : undefined,
    } }
    next = replaceSource(next, source)
  }
  const saved = await writeCatalog(env, next, now)
  await recordRun(env, id, now, success ? 'success' : 'failed', {
    ...source.sync, format: source.detectedFormat, errorCode: source.lastErrorCode,
    added: next.nodes.filter((node) => node.sourceIds.includes(id)).length,
  })
  return { success, source: summarizeSource(sourceById(saved, id), safeUrl) }
}

export async function replaceSourceContent(
  env: DataEnv,
  sourceId: string,
  content: string,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = await readCatalog(env)
  const current = sourceById(snapshot, sourceId)
  if (current.type === 'remote') fail('CATALOG_SOURCE_TYPE_INVALID')
  const material = await readCryptoMaterial(env.DATA)
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
  const saved = await writeCatalog(env, await applyImport(replaceSource(snapshot, source), current.id, parsed.nodes, now), now)
  return { success: true, source: summarizeSource(sourceById(saved, current.id)) }
}

export async function updateSource(
  env: DataEnv,
  sourceId: string,
  input: UpdateSourceInput,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = await readCatalog(env)
  const current = sourceById(snapshot, sourceId)
  const name = input.name === undefined ? current.name : normalizedName(input.name)
  let source: Source = {
    ...current,
    name,
    enabled: input.enabled ?? current.enabled,
    keepOnFailure: input.keepOnFailure ?? current.keepOnFailure,
    updatedAt: now,
  }
  let next = replaceSource(snapshot, source)

  if (current.type === 'remote') {
    if (input.content !== undefined) fail('CATALOG_SOURCE_TYPE_INVALID')
    if (input.formatOverride !== undefined) source.sync = { ...source.sync, formatOverride: input.formatOverride ?? undefined }
    if (source.sync && (input.url || input.headers || input.formatOverride !== undefined || (!current.enabled && input.enabled === true))) {
      source.sync = { formatOverride: source.sync.formatOverride }
    }
    if (input.refreshIntervalMinutes !== undefined && (!Number.isInteger(input.refreshIntervalMinutes) || input.refreshIntervalMinutes <= 0 || input.refreshIntervalMinutes % 15 !== 0)) {
      fail('CATALOG_SOURCE_INVALID')
    }
    const material = input.url !== undefined || input.headers !== undefined
      ? await readCryptoMaterial(env.DATA)
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
    const saved = await writeCatalog(env, next, now)
    let remoteUrl: string | undefined
    try {
      const encrypted = source.encryptedUrl
      if (encrypted && material) remoteUrl = await decryptText(encrypted, material.encryptionKey)
    } catch {
      remoteUrl = undefined
    }
    return { success: true, source: summarizeSource(sourceById(saved, current.id), remoteUrl) }
  }

  if (input.url !== undefined || input.headers !== undefined || input.refreshIntervalMinutes !== undefined) {
    fail('CATALOG_SOURCE_TYPE_INVALID')
  }
  if (input.content !== undefined) {
    const material = await readCryptoMaterial(env.DATA)
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
    next = await applyImport(replaceSource(snapshot, source), current.id, parsed.nodes, now)
  }
  const saved = await writeCatalog(env, next, now)
  return { success: true, source: summarizeSource(sourceById(saved, current.id)) }
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

const activeSyncs = new Map<string, AbortController>()
type SyncDiff = { added: number; updated: number; missing: number; duplicates: number; skipped: number; parseFailed: number }
type PreparedSync = {
  revision: number
  sourceId: SourceId
  content: EncryptedValue
  diff: SyncDiff
  format: ImportFormat
  httpStatus: number
  startedAt: string
  durationMs: number
}

async function boundedSourceSync<T>(
  env: DataEnv,
  id: string,
  operation: (signal: AbortSignal, checkCancelled: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const operationId = crypto.randomUUID()
  const now = Date.now()
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM catalog_sync_leases WHERE expires_at <= ?').bind(now),
    env.DB.prepare(`INSERT OR IGNORE INTO catalog_sync_leases (slot, source_id, operation_id, expires_at)
      SELECT slot, ?, ?, ? FROM (SELECT 1 AS slot UNION ALL SELECT 2)
      WHERE slot NOT IN (SELECT slot FROM catalog_sync_leases)
      ORDER BY slot LIMIT 1`).bind(id, operationId, now + 120_000),
  ])
  if (!inserted.meta.changes) fail('CATALOG_SYNC_BUSY')
  const controller = new AbortController()
  activeSyncs.set(id, controller)
  const checkCancelled = async () => {
    const lease = await env.DB.prepare(
      'SELECT cancelled FROM catalog_sync_leases WHERE operation_id = ?',
    ).bind(operationId).first<{ cancelled: number }>()
    if (controller.signal.aborted || lease?.cancelled !== 0) throw new RemoteFetchError('REMOTE_CANCELLED')
  }
  try {
    return await operation(controller.signal, checkCancelled)
  } finally {
    if (activeSyncs.get(id) === controller) activeSyncs.delete(id)
    await env.DB.prepare('DELETE FROM catalog_sync_leases WHERE operation_id = ?').bind(operationId).run()
  }
}

export async function cancelSourceSync(env: DataEnv, id: string, previewId?: string): Promise<boolean> {
  if (previewId) {
    return boundedSourceSync(env, id, async () => {
      const pending = await env.DATA.get<PreparedSync>(previewKey(previewId), 'json')
      if (!pending || pending.sourceId !== id) return false
      await env.DATA.delete(previewKey(previewId))
      await recordRun(env, id, pending.startedAt, 'cancelled', { errorCode: 'REMOTE_CANCELLED', durationMs: pending.durationMs })
      return true
    })
  }
  const result = await env.DB.prepare('UPDATE catalog_sync_leases SET cancelled = 1 WHERE source_id = ? AND expires_at > ?')
    .bind(id, Date.now()).run()
  activeSyncs.get(id)?.abort()
  return Boolean(result.meta.changes)
}

const previewKey = (id: string) => `catalog:sync-preview:${id}`

export async function previewImportDiff(
  parsed: ImportResult,
  snapshot: CatalogSnapshot,
  sourceId?: SourceId,
  now = new Date().toISOString(),
  variants?: Map<string, ParsedNode[]>,
): Promise<SyncDiff> {
  const groups = variants ?? await groupParsedVariants(parsed.nodes)
  const existing = new Map(snapshot.nodes.filter((node) => sourceId && node.sourceIds.includes(sourceId))
    .map((node) => [node.sourceFingerprint ?? node.fingerprint, node]))
  const diff: SyncDiff = { added: 0, updated: 0, missing: 0, duplicates: parsed.nodes.length - groups.size, skipped: 0, parseFailed: 0 }
  for (const [fingerprint, imported] of groups) {
    const previous = existing.get(fingerprint)
    const raw = previous?.rawVariants.filter((variant) => variant.sourceId === sourceId)
    if (!previous) diff.added++
    else if (previous.missingSince || previous.sourceIds.length > 1 || (!previous.displayNameOverride && previous.displayName !== imported[0].displayName)
      || raw?.length !== imported.length || raw.some((variant, index) => variant.raw !== imported[index].raw || variant.format !== imported[index].format)) diff.updated++
    else diff.skipped++
  }
  diff.missing = [...existing.keys()].filter((key) => !groups.has(key)).length
  for (const warning of parsed.warnings) {
    if (/INVALID|FAILED|ERROR|MALFORMED|UNSUPPORTED_IMPORT_BLOCK/u.test(warning.code)) diff.parseFailed++
    else diff.skipped++
  }
  // Run the same reconciliation as commit to catch limits before issuing the preview.
  if (sourceId) await applyImport(snapshot, sourceId, parsed.nodes, now, groups)
  else if (snapshot.nodes.length + groups.size > MAX_NODES) fail('CATALOG_NODE_LIMIT')
  return diff
}

async function prepareSync(env: DataEnv, snapshot: CatalogSnapshot, source: Source, signal: AbortSignal, options: ImportServiceOptions) {
  const started = Date.now()
  const material = await readCryptoMaterial(env.DATA)
  const url = await decryptText(source.encryptedUrl!, material.encryptionKey)
  const headers = parsedHeaders(await decryptText(source.encryptedHeaders!, material.encryptionKey))
  const result = await fetchRemoteTextWithMetadata({ url, headers }, options.fetcher, undefined, signal)
  if (result.notModified) fail('IMPORT_FAILED')
  let parsed: ImportResult
  let diff: SyncDiff
  try {
    parsed = safeImportResult(result.text, source.sync?.formatOverride)
    diff = await previewImportDiff(parsed, snapshot, source.id, options.now ?? new Date(started).toISOString())
  } catch (error) {
    if (error instanceof CatalogImportError) error.httpStatus = result.status
    throw error
  }
  const prepared: PreparedSync = {
    revision: snapshot.revision,
    sourceId: source.id,
    content: await encryptText(result.text, material.encryptionKey),
    diff,
    format: parsed.format,
    httpStatus: result.status,
    startedAt: options.now ?? new Date(started).toISOString(),
    durationMs: Date.now() - started,
  }
  if (signal.aborted) throw new RemoteFetchError('REMOTE_CANCELLED')
  return { prepared, parsed, url }
}

function failureMetadata(source: Source, error: unknown, now: string, started: number): NonNullable<Source['sync']> {
  return {
    ...source.sync,
    consecutiveFailures: (source.sync?.consecutiveFailures ?? 0) + 1,
    firstFailureAt: source.sync?.firstFailureAt ?? now,
    durationMs: Math.max(0, Date.now() - started),
    httpStatus: (error instanceof RemoteFetchError || error instanceof CatalogImportError) ? error.httpStatus : undefined,
  }
}

async function recordRun(env: DataEnv, sourceId: string, startedAt: string, status: string, details: object) {
  await env.DB.prepare(
    'INSERT INTO catalog_sync_runs (id, source_id, started_at, finished_at, status, details) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(crypto.randomUUID(), sourceId, startedAt, new Date().toISOString(), status, JSON.stringify(details)).run()
  await env.DB.prepare(`DELETE FROM catalog_sync_runs WHERE source_id = ? AND id NOT IN
    (SELECT id FROM catalog_sync_runs WHERE source_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 20)`)
    .bind(sourceId, sourceId).run()
}

export async function previewSourceSync(env: DataEnv, sourceId: string, options: ImportServiceOptions = {}) {
  return boundedSourceSync(env, sourceId, async (signal, checkCancelled) => {
    const snapshot = await readCatalog(env)
    const source = sourceById(snapshot, sourceId)
    if (source.type !== 'remote') fail('CATALOG_SOURCE_TYPE_INVALID')
    const startedAt = options.now ?? new Date().toISOString()
    try {
      const { prepared, parsed } = await prepareSync(env, snapshot, source, signal, options)
      await checkCancelled()
      const id = crypto.randomUUID()
      await env.DATA.put(previewKey(id), JSON.stringify(prepared), { expirationTtl: 600 })
      return { id, diff: prepared.diff, format: prepared.format, warnings: parsed.warnings, durationMs: prepared.durationMs, httpStatus: prepared.httpStatus }
    } catch (error) {
      const code = signal.aborted ? 'REMOTE_CANCELLED' : safeErrorCode(error)
      const finishedAt = new Date().toISOString()
      const sync = failureMetadata(source, error, startedAt, Date.parse(startedAt))
      if (code !== 'REMOTE_CANCELLED' && (await readCatalog(env)).revision === snapshot.revision) {
        await writeCatalog(env, replaceSource(snapshot, { ...source, sync, lastAttemptAt: startedAt,
          lastErrorCode: code, updatedAt: finishedAt }), finishedAt)
      }
      await recordRun(env, sourceId, startedAt, code === 'REMOTE_CANCELLED' ? 'cancelled' : 'failed', { ...sync, errorCode: code })
      throw error
    }
  })
}

export async function refreshSource(
  env: DataEnv,
  sourceId: string,
  options: ImportServiceOptions = {},
): Promise<SourceOperationResult> {
  return boundedSourceSync(env, sourceId, async (signal, checkCancelled) => {
    const now = options.now ?? new Date().toISOString()
    const started = Date.now()
    const snapshot = await readCatalog(env)
    const current = sourceById(snapshot, sourceId)
    if (current.type !== 'remote') fail('CATALOG_SOURCE_TYPE_INVALID')
    let prepared: PreparedSync
    let parsed: ImportResult
    let url: string | undefined
    if (options.previewId) {
      const pending = await env.DATA.get<PreparedSync>(previewKey(options.previewId), 'json')
      if (!pending || pending.sourceId !== current.id || pending.revision !== snapshot.revision) fail('CATALOG_PREVIEW_STALE')
      prepared = pending
      const material = await readCryptoMaterial(env.DATA)
      parsed = safeImportResult(await decryptText(prepared.content, material.encryptionKey), current.sync?.formatOverride)
    } else {
      try {
        ({ prepared, parsed, url } = await prepareSync(env, snapshot, current, signal, options))
      } catch (error) {
        const code = signal.aborted ? 'REMOTE_CANCELLED' : safeErrorCode(error)
        if (code === 'REMOTE_CANCELLED') {
          await recordRun(env, sourceId, now, 'cancelled', { errorCode: code })
          return { success: false, source: summarizeSource(current) }
        }
        const source: Source = {
          ...current,
          lastAttemptAt: now,
          lastErrorCode: code,
          updatedAt: now,
          sync: failureMetadata(current, error, now, started),
        }
        if ((await readCatalog(env)).revision !== snapshot.revision) fail('CATALOG_PREVIEW_STALE')
        await writeCatalog(env, replaceSource(snapshot, source), now)
        await recordRun(env, sourceId, now, 'failed', { ...source.sync, errorCode: code })
        return { success: false, source: summarizeSource(source, url) }
      }
    }
    const source: Source = {
      ...current,
      encryptedContent: prepared.content,
      detectedFormat: parsed.format,
      warnings: parsed.warnings,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorCode: undefined,
      updatedAt: now,
      sync: {
        formatOverride: current.sync?.formatOverride,
        consecutiveFailures: 0,
        httpStatus: prepared.httpStatus,
        durationMs: prepared.durationMs,
      },
    }
    const next = await applyImport(replaceSource(snapshot, source), current.id, parsed.nodes, now)
    await checkCancelled()
    if ((await readCatalog(env)).revision !== snapshot.revision) fail('CATALOG_PREVIEW_STALE')
    const saved = await writeCatalog(env, next, now)
    if (options.previewId) await env.DATA.delete(previewKey(options.previewId))
    await recordRun(env, sourceId, prepared.startedAt, 'success', { ...prepared.diff, format: prepared.format, ...source.sync })
    return { success: true, source: summarizeSource(sourceById(saved, current.id), url) }
  })
}

export async function deleteSource(
  env: DataEnv,
  sourceId: string,
  options: ImportServiceOptions = {},
): Promise<void> {
  const now = options.now ?? new Date().toISOString()
  const snapshot = structuredClone(await readCatalog(env))
  const source = sourceById(snapshot, sourceId)
  snapshot.sources = snapshot.sources.filter(({ id }) => id !== source.id)
  const deletedIds = new Set<string>()
  snapshot.nodes = snapshot.nodes.filter((node) => {
    if (!node.sourceIds.includes(source.id)) return true
    node.sourceIds = node.sourceIds.filter((id) => id !== source.id)
    node.missingSince = undefined
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
  await writeCatalog(env, snapshot, now)
}
