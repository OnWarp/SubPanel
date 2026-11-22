import { readAccounts } from '../accounts/repository.js'
import { getEffectiveTemplate, isLegacyTemplateVersion } from '../templates/repository.js'
import { validateTemplate, type Template } from '../templates/validation.js'
import { apiError } from '../platform/api-error.js'
import { subscriptionRowStatus } from './expiry.js'
import { listPlans } from './plans.js'
import { readCatalog } from '../catalog/repository.js'
import type { DataEnv } from '../db/module-switch.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import { hashToken } from '../platform/crypto.js'
import { RENDERER_VERSION } from '../renderers/model.js'
import { CLIENT_IDS, prepareClientRender, type RenderClient } from '../renderers/index.js'
import { compiledArtifactSchema, type CompiledArtifact, type Subscription } from './schema.js'
import { compiledKey, compiledPrefix, readDelivery } from './repository.js'

export type CompileOptions = { now?: string }

export function selectedNodes(catalog: Awaited<ReturnType<typeof readCatalog>>, subscription: { groupIds: readonly string[] }) {
  const byId = new Map<string, (typeof catalog.nodes)[number]>()
  for (const groupId of subscription.groupIds) {
    if (!catalog.groups.some((group) => group.id === groupId)) continue
    for (const node of resolveGroupNodes(catalog, groupId)) if (!byId.has(node.id)) byId.set(node.id, node)
  }
  return [...byId.values()]
}

export type AccessSnapshot = {
  catalog: Awaited<ReturnType<typeof readCatalog>>
  users: Awaited<ReturnType<typeof readAccounts>>['users']
  plans: Awaited<ReturnType<typeof listPlans>>
}

export async function previewAuthorizedOutput(
  catalog: Awaited<ReturnType<typeof readCatalog>>,
  planGroupIds: readonly string[],
  groupIds: readonly string[],
  client: RenderClient,
  speed: number,
) {
  const allowed = new Set(planGroupIds)
  const authorizedGroupIds = groupIds.filter((id) => allowed.has(id))
  const nodes = selectedNodes(catalog, { groupIds: authorizedGroupIds })
  return {
    authorizedGroupIds,
    outputNodes: (await prepareSubscriptionRender(client, nodes, speed)).outputNodes,
    authorizedNodeCount: nodes.filter((node) => node.enabled).length,
  }
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

export { RENDERER_VERSION } from '../renderers/model.js'
export type ZeroNodeReason = 'disabled' | 'unassigned' | 'pending' | 'expired' | 'noPlan' | 'noGroupIntersection' | 'noEnabledNodes' | 'incompatible' | 'ownerUnavailable'

async function artifactFor(
  env: DataEnv,
  subscription: Subscription,
  client: RenderClient,
  context: Awaited<ReturnType<typeof resolveEntitlement>>,
  now: string,
  previewTemplate?: Template,
) {
  const { nodes, catalog, speed, zeroNodeReason } = context
  const prepared = await prepareSubscriptionRender(client, nodes, speed)
  let template = previewTemplate
  let templateVersionId: string | undefined
  if (client === 'mihomo' && prepared.outputNodes > 0 && !template) {
    const effective = await getEffectiveTemplate(env.DB, subscription.id)
    templateVersionId = effective.version_id ?? undefined
    if (effective.yaml !== null) {
      try {
        template = validateTemplate(effective.yaml, isLegacyTemplateVersion(effective.validator_version)).template
      } catch {
        throw apiError(500, 'TEMPLATE_OUTPUT_INVALID', '已发布配置校验失败')
      }
    }
  }
  const rendered = prepared.render(template)
  const digest = await hashToken(rendered.body)
  const artifact = compiledArtifactSchema.parse({
    schemaVersion: 2,
    client,
    body: rendered.body,
    contentType: rendered.contentType,
    fileName: rendered.fileName,
    etag: `"${digest}"`,
    lastModified: now,
    subscriptionRevision: subscription.revision,
    catalogRevision: catalog.revision,
    inputNodes: rendered.inputNodes,
    outputNodes: rendered.outputNodes,
    skippedNodes: rendered.skippedNodes,
    diagnostics: rendered.diagnostics,
    available: rendered.outputNodes > 0,
    rendererVersion: RENDERER_VERSION,
    templateVersionId,
  })
  return { ...artifact, zeroNodeReason: artifact.available ? null : zeroNodeReason ?? ('incompatible' satisfies ZeroNodeReason) }
}

export async function compileSubscription(
  env: DataEnv,
  subscription: Subscription,
  options: CompileOptions = {},
): Promise<CompiledArtifact[]> {
  const kv = env.DATA
  const now = options.now ?? new Date().toISOString()
  const context = await resolveEntitlement(env, subscription, now)
  const artifacts = await Promise.all(CLIENT_IDS.map(client => artifactFor(env, subscription, client, context, now)))
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
// subscription availability and plan edits can change independently of cached output.

type CatalogNode = ReturnType<typeof selectedNodes>[number]

function blockedAccess(
  catalog: Awaited<ReturnType<typeof readCatalog>>,
  zeroNodeReason: ZeroNodeReason,
) {
  return { catalog, nodes: [] as CatalogNode[], speed: 0, zeroNodeReason, authorizedGroupIds: [] as string[] }
}

export async function resolveEntitlement(env: DataEnv, subscription: Subscription, now: string, snapshot?: Partial<AccessSnapshot>) {
  const catalog = snapshot?.catalog ?? await readCatalog(env)
  const status = subscriptionRowStatus(subscription, Date.parse(now))
  if (status) return blockedAccess(catalog, status === 'revoked' ? 'disabled' : status)

  if (subscription.userId !== null) {
    const users = snapshot?.users ?? (await readAccounts(env)).users
    const owner = users.find(user => user.id === subscription.userId)
    if (!owner || owner.deletedAt || !owner.enabled) return blockedAccess(catalog, 'ownerUnavailable')
  }
  const plan = subscription.planId && subscription.userId !== null
    ? (snapshot?.plans ?? await listPlans(env.DB)).find(p => p.id === subscription.planId)
    : undefined
  if (subscription.planId && subscription.userId !== null && !plan) return blockedAccess(catalog, 'noPlan')
  const groupIds = plan ? subscription.groupIds.filter(id => plan.groupIds.includes(id)) : subscription.groupIds
  const nodes = selectedNodes(catalog, { groupIds })
  const zeroNodeReason: ZeroNodeReason | null = !groupIds.length ? 'noGroupIntersection'
    : nodes.some(node => node.enabled) ? null : 'noEnabledNodes'
  return { catalog, nodes, speed: subscription.speedLimitMbps ?? 0, zeroNodeReason, authorizedGroupIds: groupIds }
}

function speedLimitedNodes(nodes: ReturnType<typeof selectedNodes>, client: RenderClient, speed: number) {
  return nodes.map((node) => {
    if (speed === 0 || !['hysteria','hysteria2'].includes(node.protocol) || !['mihomo','singbox','surge'].includes(client)) return node
    const cap = (value: unknown) => typeof value === 'number' && value > 0 ? Math.min(speed,value) : speed
    return { ...node, transport: { ...node.transport, upMbps: cap(node.transport?.upMbps ?? node.transport?.up), downMbps: cap(node.transport?.downMbps ?? node.transport?.down) } }
  })
}

export async function prepareSubscriptionRender(client: RenderClient, nodes: CatalogNode[], speed: number) {
  return prepareClientRender(client, await nodesForClient(client, speedLimitedNodes(nodes, client, speed)))
}

export async function renderEntitledSubscription(
  env: DataEnv,
  subscription: Subscription,
  client: RenderClient,
  now = new Date().toISOString(),
  previewTemplate?: Template,
  preview = false,
) {
  const access = await resolveEntitlement(env, subscription, now)
  const artifact = await artifactFor(env, subscription, client, access, now, previewTemplate)
  return {
    ...artifact,
    previewInputNodes: preview ? selectedNodes(access.catalog, subscription).length : undefined,
    previewAuthorizedNodes: preview ? access.nodes.filter(node => node.enabled).length : undefined,
  }
}

export async function previewCatalogEntitlement(
  env: DataEnv,
  subscription: Subscription,
  client: RenderClient,
  catalog: Awaited<ReturnType<typeof readCatalog>>,
) {
  const now = new Date().toISOString()
  const context = await resolveEntitlement(env, subscription, now, { catalog })
  const artifact = await artifactFor(env, subscription, client, context, now)
  return {
    authorizedNodeIds: context.nodes.map(({ id }) => id),
    outputNodes: artifact.outputNodes,
    skippedNodes: artifact.skippedNodes,
    diagnostics: artifact.diagnostics,
    reason: artifact.zeroNodeReason,
  }
}
