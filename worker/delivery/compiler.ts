import { readCatalog } from '../catalog/repository.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import { hashToken } from '../platform/crypto.js'
import { CLIENT_IDS, renderClient, type RenderClient } from '../renderers/index.js'
import { compiledArtifactSchema, type CompiledArtifact, type Subscription } from './schema.js'
import { compiledKey, compiledPrefix, readDelivery } from './repository.js'

export type CompileOptions = { now?: string }

function selectedNodes(catalog: Awaited<ReturnType<typeof readCatalog>>, subscription: Subscription) {
  const byId = new Map<string, (typeof catalog.nodes)[number]>()
  for (const groupId of subscription.groupIds) {
    if (!catalog.groups.some((group) => group.id === groupId)) continue
    for (const node of resolveGroupNodes(catalog, groupId)) if (!byId.has(node.id)) byId.set(node.id, node)
  }
  return [...byId.values()]
}

async function certificateFingerprint(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string') return undefined
  const match = /-----BEGIN CERTIFICATE-----\s*([\s\S]*?)\s*-----END CERTIFICATE-----/u.exec(value)
  if (!match) return undefined
  try {
    const binary = atob(match[1].replace(/\s/gu, ''))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')
  } catch {
    return undefined
  }
}

async function nodesForClient(client: RenderClient, nodes: ReturnType<typeof selectedNodes>) {
  if (client !== 'mihomo') return nodes
  return Promise.all(nodes.map(async (node) => {
    const tls = { ...node.tls }
    const fingerprint = await certificateFingerprint(tls.certificate ?? tls.ca ?? tls['ca-str'])
    if (!fingerprint) return node
    delete tls.certificate
    delete tls.ca
    delete tls['ca-str']
    tls.certificateSha256 = fingerprint
    return { ...node, tls }
  }))
}

async function artifactFor(
  subscription: Subscription,
  client: RenderClient,
  nodes: ReturnType<typeof selectedNodes>,
  catalogRevision: number,
  now: string,
): Promise<CompiledArtifact> {
  const rendered = renderClient(client, await nodesForClient(client, nodes))
  const digest = await hashToken(rendered.body)
  return compiledArtifactSchema.parse({
    schemaVersion: 2,
    client,
    body: rendered.body,
    contentType: rendered.contentType,
    fileName: rendered.fileName,
    etag: `"${digest}"`,
    lastModified: now,
    subscriptionRevision: subscription.revision,
    catalogRevision,
    inputNodes: rendered.inputNodes,
    outputNodes: rendered.outputNodes,
    skippedNodes: rendered.skippedNodes,
    diagnostics: rendered.diagnostics,
    available: rendered.outputNodes > 0,
  })
}

export async function compileSubscription(
  kv: KVNamespace,
  subscription: Subscription,
  options: CompileOptions = {},
): Promise<CompiledArtifact[]> {
  const now = options.now ?? new Date().toISOString()
  const catalog = await readCatalog(kv)
  const nodes = selectedNodes(catalog, subscription)
  const artifacts = await Promise.all(CLIENT_IDS.map((client) => artifactFor(subscription, client, nodes, catalog.revision, now)))
  await Promise.all(artifacts.map((artifact) => kv.put(compiledKey(subscription.tokenHash, artifact.client), JSON.stringify(artifact))))
  const keep = new Set(artifacts.map((artifact) => compiledKey(subscription.tokenHash, artifact.client)))
  const listed = await kv.list({ prefix: compiledPrefix(subscription.tokenHash) })
  const stale = listed.keys.filter(({ name }) => !keep.has(name))
  if (stale.length > 0) await Promise.all(stale.map(({ name }) => kv.delete(name)))
  return artifacts
}

export async function compileAllSubscriptions(kv: KVNamespace, options: CompileOptions = {}): Promise<void> {
  const snapshot = await readDelivery(kv)
  for (const subscription of snapshot.subscriptions) {
    if (subscription.enabled) await compileSubscription(kv, subscription, options)
    else {
      const listed = await kv.list({ prefix: compiledPrefix(subscription.tokenHash) })
      if (listed.keys.length > 0) await Promise.all(listed.keys.map(({ name }) => kv.delete(name)))
    }
  }
}

export async function compileSubscriptionById(kv: KVNamespace, id: string, options: CompileOptions = {}): Promise<CompiledArtifact[]> {
  const snapshot = await readDelivery(kv)
  const subscription = snapshot.subscriptions.find((candidate) => candidate.id === id)
  if (!subscription) throw new Error('SUBSCRIPTION_NOT_FOUND')
  if (!subscription.enabled) return []
  return compileSubscription(kv, subscription, options)
}

export const recompileAfterCatalogChange = (kv: KVNamespace, options: CompileOptions = {}) => compileAllSubscriptions(kv, options)
