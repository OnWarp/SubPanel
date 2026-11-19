import { resolvedTemplate, getEffectiveTemplate } from '../templates/repository.js'
import type { Template } from '../templates/validation.js'
import { getUserEntitlement } from '../entitlements/service.js'
import { readCatalog } from '../catalog/repository.js'
import type { DataEnv } from '../db/module-switch.js'
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
  template?: Template,
  templateVersionId?: string,
): Promise<CompiledArtifact> {
  const rendered = renderClient(client, await nodesForClient(client, nodes), template)
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
    rendererVersion: '2026.11.20',
    templateVersionId,
  })
}

export async function compileSubscription(
  env: DataEnv,
  subscription: Subscription,
  options: CompileOptions = {},
): Promise<CompiledArtifact[]> {
  const kv = env.DATA
  const now = options.now ?? new Date().toISOString()
  const { catalog, nodes, speed, templateVersionId } = await entitledNodes(env, subscription, now)
  const artifacts = await Promise.all(CLIENT_IDS.map((client) =>
    artifactFor(subscription, client, speedLimitedNodes(nodes, client, speed), catalog.revision, now, undefined, templateVersionId)
  ))
  await Promise.all(artifacts.map((artifact) => kv.put(compiledKey(subscription.tokenHash, artifact.client), JSON.stringify(artifact))))
  const keep = new Set(artifacts.map((artifact) => compiledKey(subscription.tokenHash, artifact.client)))
  const listed = await kv.list({ prefix: compiledPrefix(subscription.tokenHash) })
  const stale = listed.keys.filter(({ name }: { name: string }) => !keep.has(name))
  if (stale.length > 0) await Promise.all(stale.map(({ name }: { name: string }) => kv.delete(name)))
  return artifacts
}

export async function compileAllSubscriptions(env: DataEnv, options: CompileOptions = {}): Promise<void> {
  const kv = env.DATA
  const snapshot = await readDelivery(env)
  for (const subscription of snapshot.subscriptions) {
    if (subscription.enabled) await compileSubscription(env, subscription, options)
    else {
      const listed = await kv.list({ prefix: compiledPrefix(subscription.tokenHash) })
      if (listed.keys.length > 0) await Promise.all(listed.keys.map(({ name }: { name: string }) => kv.delete(name)))
    }
  }
}

export async function compileSubscriptionById(env: DataEnv, id: string, options: CompileOptions = {}): Promise<CompiledArtifact[]> {
  const snapshot = await readDelivery(env)
  const subscription = snapshot.subscriptions.find((candidate) => candidate.id === id)
  if (!subscription) throw new Error('SUBSCRIPTION_NOT_FOUND')
  if (!subscription.enabled) return []
  return compileSubscription(env, subscription, options)
}

export const recompileAfterCatalogChange = (env: DataEnv, options: CompileOptions = {}) => compileAllSubscriptions(env, options)

// Public requests repeat the live decision even when a cached artifact exists:
// entitlement expiry and plan edits do not change subscription/catalog revisions.
async function entitledNodes(env: DataEnv, subscription: Subscription, now: string) {
  const rights = await getUserEntitlement(env.DB, subscription.userId ?? '', now)
  const catalog = await readCatalog(env)
  const nodes = rights.current
    ? selectedNodes(catalog, { ...subscription, groupIds: subscription.groupIds.filter((id) => rights.current!.plan.groupIds.includes(id)) })
    : []

  // Get template version ID for Mihomo clients (for cache invalidation)
  let templateVersionId: string | undefined
  if (nodes.length > 0) {
    const effective = await getEffectiveTemplate(env.DB, subscription.id)
    if (effective) templateVersionId = effective.version.id
  }

  return { catalog, nodes, speed: rights.current?.plan.speedLimitMbps ?? 0, templateVersionId }
}

function speedLimitedNodes(nodes: ReturnType<typeof selectedNodes>, client: RenderClient, speed: number) {
  return nodes.map((node) => {
    if (speed === 0 || !['hysteria','hysteria2'].includes(node.protocol) || !['mihomo','singbox','surge'].includes(client)) return node
    const cap = (value: unknown) => typeof value === 'number' && value > 0 ? Math.min(speed,value) : speed
    return { ...node, transport: { ...node.transport, upMbps: cap(node.transport?.upMbps ?? node.transport?.up), downMbps: cap(node.transport?.downMbps ?? node.transport?.down) } }
  })
}

export async function renderEntitledSubscription(env: DataEnv, subscription: Subscription, client: RenderClient, now = new Date().toISOString(), previewTemplate?: Template): Promise<CompiledArtifact> {
  const { catalog, nodes, speed, templateVersionId } = await entitledNodes(env, subscription, now)
  return artifactFor(
    subscription,
    client,
    speedLimitedNodes(nodes, client, speed),
    catalog.revision,
    now,
    client === 'mihomo' && nodes.some(n => n.enabled) ? previewTemplate ?? await resolvedTemplate(env.DB, subscription.id) : undefined,
    templateVersionId
  )
}