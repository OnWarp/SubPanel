import { findAccountUserById, readAccounts } from '../accounts/repository.js'
import { getEffectiveTemplate, isLegacyTemplateVersion } from '../templates/repository.js'
import { validateTemplate, type Template } from '../templates/validation.js'
import { apiError } from '../platform/api-error.js'
import { SPEED_LIMIT_CLIENTS } from './dependencies.js'
import { subscriptionRowStatus } from './expiry.js'
import { listPlans } from './plans.js'
import { readCatalog } from '../catalog/repository.js'
import type { DataEnv } from '../db/module-switch.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import { hashToken } from '../platform/crypto.js'
import type { compileSingBoxConfig } from '../renderers/singbox.js'
import { RENDERER_VERSION } from '../renderers/model.js'
import { prepareClientRender, type RenderClient } from '../renderers/index.js'
import { compiledArtifactSchema, type Subscription } from './schema.js'

export function selectedNodes(catalog: Awaited<ReturnType<typeof readCatalog>>, subscription: { groupIds: readonly string[]; nodeIds?: readonly string[] }) {
  const byId = new Map<string, (typeof catalog.nodes)[number]>()
  for (const groupId of subscription.groupIds) {
    if (!catalog.groups.some((group) => group.id === groupId)) continue
    for (const node of resolveGroupNodes(catalog, groupId)) if (!byId.has(node.id)) byId.set(node.id, node)
  }
  if (subscription.nodeIds?.length) {
    const enabled = new Map(catalog.nodes.filter((node) => node.enabled).map((node) => [node.id, node]))
    for (const id of subscription.nodeIds) {
      const node = enabled.get(id)
      if (node && !byId.has(node.id)) byId.set(node.id, node)
    }
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
  nodeIds?: readonly string[],
) {
  const allowed = new Set(planGroupIds)
  const authorizedGroupIds = groupIds.filter((id) => allowed.has(id))
  const nodes = selectedNodes(catalog, { groupIds: authorizedGroupIds, nodeIds })
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

export async function renderResolvedSubscription(
  env: DataEnv,
  subscription: { id: string | null; revision: number },
  client: RenderClient,
  context: Pick<Awaited<ReturnType<typeof resolveEntitlement>>, 'nodes' | 'catalog' | 'speed' | 'zeroNodeReason'>,
  now: string,
  previewTemplate?: Template,
  singboxOptions?: Parameters<typeof compileSingBoxConfig>[2],
  resolvedTemplate?: Awaited<ReturnType<typeof getEffectiveTemplate>>,
) {
  const { nodes, catalog, speed, zeroNodeReason } = context
  const prepared = await prepareSubscriptionRender(client, nodes, speed)
  let template = previewTemplate
  let templateVersionId: string | undefined
  if ((client === 'mihomo' || client === 'singbox') && prepared.outputNodes > 0 && !template) {
    const effective = resolvedTemplate ?? await getEffectiveTemplate(env.DB, subscription.id, client)
    templateVersionId = effective.version_id ?? undefined
    if (client === 'singbox' && effective.compiled_json) {
      const published = JSON.parse(effective.compiled_json) as { route: { rule_set?: Record<string, unknown>[] } }
      singboxOptions = { targetVersion: effective.target_version ?? undefined, ruleSets: published.route.rule_set ?? [] }
    }
    if (effective.yaml !== null) {
      try {
        template = validateTemplate(effective.yaml, isLegacyTemplateVersion(effective.validator_version)).template
      } catch {
        throw apiError(500, 'TEMPLATE_OUTPUT_INVALID', '已发布配置校验失败')
      }
    }
  }
  const rendered = prepared.render(template, singboxOptions)
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
    const owner = snapshot?.users
      ? snapshot.users.find(user => user.id === subscription.userId)
      : await findAccountUserById(env, subscription.userId)
    if (!owner || owner.deletedAt || !owner.enabled) return blockedAccess(catalog, 'ownerUnavailable')
  }
  const plan = subscription.planId
    ? (snapshot?.plans ?? await listPlans(env.DB, subscription.planId)).find(p => p.id === subscription.planId)
    : undefined
  if (subscription.planId && !plan) return blockedAccess(catalog, 'noPlan')
  if (plan && !plan.enabled) return blockedAccess(catalog, 'disabled')
  const groupIds = plan ? subscription.groupIds.filter(id => plan.groupIds.includes(id)) : subscription.groupIds
  const nodeIds = subscription.planId ? undefined : subscription.nodeIds
  const nodes = selectedNodes(catalog, { groupIds, nodeIds })
  const zeroNodeReason: ZeroNodeReason | null = !groupIds.length && !nodeIds?.length ? 'noGroupIntersection'
    : nodes.some(node => node.enabled) ? null : 'noEnabledNodes'
  return { catalog, nodes, speed: subscription.speedLimitMbps ?? 0, zeroNodeReason, authorizedGroupIds: groupIds }
}

function speedLimitedNodes(nodes: ReturnType<typeof selectedNodes>, client: RenderClient, speed: number) {
  return nodes.map((node) => {
    if (speed === 0 || !['hysteria','hysteria2'].includes(node.protocol) || !SPEED_LIMIT_CLIENTS.has(client)) return node
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
  singboxOptions?: Parameters<typeof compileSingBoxConfig>[2],
) {
  const access = await resolveEntitlement(env, subscription, now)
  const artifact = await renderResolvedSubscription(env, subscription, client, access, now, previewTemplate, singboxOptions)
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
  const artifact = await renderResolvedSubscription(env, subscription, client, context, now)
  return {
    authorizedNodeIds: context.nodes.map(({ id }) => id),
    outputNodes: artifact.outputNodes,
    skippedNodes: artifact.skippedNodes,
    diagnostics: artifact.diagnostics,
    reason: artifact.zeroNodeReason,
  }
}
