import type { User } from '../accounts/schema.js'
import { readAccounts } from '../accounts/repository.js'
import { hashPassword, verifyPassword } from '../accounts/password.js'
import { resolveGroupNodes } from '../catalog/groups.js'
import { readCatalog } from '../catalog/repository.js'
import type { CatalogSnapshot } from '../catalog/schema.js'
import { compileSubscription } from '../delivery/compiler.js'
import { compiledKey, readDelivery } from '../delivery/repository.js'
import { compiledArtifactSchema, clientIdSchema, type ClientId, type CompiledArtifact, type Subscription } from '../delivery/schema.js'
import { decryptSubscriptionToken } from '../delivery/service.js'
import { encryptText, getOrCreateCryptoMaterial, hashToken, randomToken } from '../platform/crypto.js'
import {
  addIndexHash,
  allocateShareId,
  claimExportAccess,
  consumeVerifySlot,
  deleteShare,
  deleteShareCompiled,
  listAllShares,
  listIndexedShares,
  readShare,
  readShareSettings,
  removeIndexHash,
  replaceIndexHash,
  shareCompiledKey,
  subscriptionIndexKey,
  userIndexKey,
  writeShare,
  writeShareSettings,
} from './repository.js'
import {
  canonicalPublicBaseUrl,
  exportQuerySchema,
  toShareView,
  type AdminShareQuery,
  type CreateShareInput,
  type ShareMeta,
  type ShareRecord,
  type ShareSettings,
  type ShareStatus,
  type ShareView,
  type UpdateShareInput,
} from './schema.js'

export class ShareError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429
  readonly code: string

  constructor(status: ShareError['status'], code: string, message: string) {
    super(message)
    this.name = 'ShareError'
    this.status = status
    this.code = code
  }
}

const shareError = (status: ShareError['status'], code: string, message: string) => new ShareError(status, code, message)
const notFound = () => shareError(404, 'SHARE_NOT_FOUND', '分享不存在')

const DAY_MS = 86_400_000

const clientAliases: Record<string, ClientId> = {
  clash: 'mihomo',
  'clash-meta': 'mihomo',
  stash: 'mihomo',
  karing: 'singbox',
  'sing-box': 'singbox',
  'quantumult-x': 'quantumultx',
  v2rayng: 'v2rayn',
  'neko-box': 'nekobox',
}

type GuardKind = 'meta' | 'export' | 'verify'

export type ShareClientExport = {
  kind: 'client'
  body: string
  contentType: string
  fileName: string
  downloadName: string
  etag: string
  lastModified: string
  profileTitle: string | null
}

export type ShareExportResult = ShareClientExport | { kind: 'link', link: string }

function assertExpiry(expiresAt: string, nowMs: number, maxValidityDays: number): void {
  const expiresMs = Date.parse(expiresAt)
  const latest = nowMs + maxValidityDays * DAY_MS
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs > latest) {
    throw shareError(422, 'SHARE_EXPIRY_INVALID', '到期时间超出允许范围')
  }
}

function assertFeatureEnabled(settings: ShareSettings): void {
  if (!settings.enabled) throw shareError(403, 'SHARE_DISABLED', '分享功能已关闭')
}

function byNewest(records: ShareRecord[]): ShareRecord[] {
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
}

function publicOrigin(settings: ShareSettings, requestUrl: string): string {
  return settings.publicBaseUrl || new URL(requestUrl).origin
}

function resolveShareClient(value: string): ClientId | null {
  const normalized = value.trim().toLowerCase()
  const aliased = clientAliases[normalized] ?? normalized
  const parsed = clientIdSchema.safeParse(aliased)
  return parsed.success ? parsed.data : null
}

async function requireOwned(kv: KVNamespace, id: string, ownerUserId: string): Promise<ShareRecord> {
  const shares = await listIndexedShares(kv, userIndexKey(ownerUserId))
  const share = shares.find((item) => item.id === id && item.ownerUserId === ownerUserId)
  if (!share) throw notFound()
  return share
}

async function requireById(kv: KVNamespace, id: string): Promise<ShareRecord> {
  const share = (await listAllShares(kv)).find((item) => item.id === id)
  if (!share) throw notFound()
  return share
}

async function assertActiveCapacity(kv: KVNamespace, settings: ShareSettings, userId: string): Promise<void> {
  const active = (await listIndexedShares(kv, userIndexKey(userId))).filter((share) => share.status === 'active').length
  if (active >= settings.maxActiveSharesPerUser) throw shareError(409, 'SHARE_LIMIT_REACHED', '分享数量已达上限')
}

async function assertSubscriptionCapacity(kv: KVNamespace, settings: ShareSettings, subscriptionId: string): Promise<void> {
  const shares = await listIndexedShares(kv, subscriptionIndexKey(subscriptionId))
  if (shares.length >= settings.maxSharesPerSubscription) throw shareError(409, 'SHARE_LIMIT_REACHED', '分享数量已达上限')
}

async function sealToken(kv: KVNamespace, token: string): Promise<Pick<ShareRecord, 'tokenHash' | 'tokenPrefix' | 'tokenEncrypted'>> {
  // 与订阅令牌相同：32 字节随机数的 base64url，只存 SHA-256、前 8 位和 AES-GCM 密文。明文不写入 KV。
  const material = await getOrCreateCryptoMaterial(kv)
  return {
    tokenHash: await hashToken(token),
    tokenPrefix: token.slice(0, 8),
    tokenEncrypted: await encryptText(token, material.encryptionKey),
  }
}

async function liveSubscription(kv: KVNamespace, share: ShareRecord): Promise<Subscription | null> {
  const delivery = await readDelivery(kv)
  const subscription = delivery.subscriptions.find((item) => item.id === share.subscriptionId)
  if (!subscription?.enabled || subscription.userId !== share.ownerUserId) return null
  const accounts = await readAccounts(kv)
  const owner = accounts.users.find((user) => user.id === share.ownerUserId)
  if (!owner?.enabled) return null
  return subscription
}

// 访问保护按这个顺序失败即拒绝：存在 → 状态 → 到期 → 登录 → 密码关 → 次数 → 订阅和用户仍启用。
// 原始链接开关只在 export?type=link 上检查。meta 与 export 未通过时统一 404，避免泄露分享是否存在。
async function guard(
  kv: KVNamespace,
  token: string,
  kind: GuardKind,
  actor: User | null,
  sessionHash: string | null,
  password: string | undefined,
  now: Date,
): Promise<{ share: ShareRecord, subscription: Subscription, settings: ShareSettings }> {
  const settings = await readShareSettings(kv)
  if (!settings.enabled) throw notFound()
  const share = await readShare(kv, await hashToken(token))
  if (!share) throw notFound()
  if (share.status !== 'active') throw notFound()
  if (Date.parse(share.expiresAt) <= now.getTime()) throw notFound()
  if ((settings.requireLoginDefault || share.requireLogin) && !actor) {
    if (kind === 'verify') throw shareError(401, 'AUTH_REQUIRED', '请先登录')
    throw notFound()
  }
  if (kind === 'verify') {
    if (share.accessControl.mode === 'none') throw shareError(400, 'SHARE_PASSWORD_NOT_REQUIRED', '该分享不需要密码')
    const passwordOk = password !== undefined && await verifyPassword(password, share.accessControl.passwordHash)
    if (!passwordOk) throw shareError(401, 'SHARE_PASSWORD_INVALID', '密码错误')
  } else if (share.accessControl.mode === 'password' && sessionHash !== share.tokenHash) {
    throw notFound()
  }
  if (share.maxAccessCount !== null && share.accessCount >= share.maxAccessCount) throw notFound()
  const subscription = await liveSubscription(kv, share)
  if (!subscription) throw notFound()
  return { share, subscription, settings }
}

async function setStatus(kv: KVNamespace, share: ShareRecord, status: ShareStatus, now: Date): Promise<ShareRecord> {
  if (share.status === status) return share
  if (share.status === 'revoked') throw shareError(409, 'SHARE_REVOKED', '已撤销的分享不能变更状态')
  if (status === 'active') {
    const settings = await readShareSettings(kv)
    assertFeatureEnabled(settings)
    await assertActiveCapacity(kv, settings, share.ownerUserId)
  }
  const next: ShareRecord = { ...share, status, updatedAt: now.toISOString() }
  await writeShare(kv, next)
  if (status !== 'active') await deleteShareCompiled(kv, share.tokenHash)
  return next
}

export async function updateSettings(kv: KVNamespace, input: ShareSettings): Promise<ShareSettings> {
  const publicBaseUrl = canonicalPublicBaseUrl(input.publicBaseUrl)
  if (publicBaseUrl === null) throw shareError(422, 'SHARE_SETTINGS_INVALID', '分享设置无效')
  const settings = { ...input, publicBaseUrl }
  await writeShareSettings(kv, settings)
  return settings
}

export async function createShare(
  kv: KVNamespace,
  ownerUserId: string,
  input: CreateShareInput,
  now = new Date(),
): Promise<{ share: ShareView, token: string }> {
  const settings = await readShareSettings(kv)
  assertFeatureEnabled(settings)
  if (!settings.createAllowed) throw shareError(403, 'SHARE_CREATE_DISABLED', '当前不允许创建分享')
  const delivery = await readDelivery(kv)
  const subscription = delivery.subscriptions.find((item) => item.id === input.subscriptionId)
  if (!subscription || subscription.userId !== ownerUserId) throw shareError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  if (!subscription.enabled) throw shareError(409, 'SUBSCRIPTION_UNAVAILABLE', '订阅未启用')
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + settings.maxValidityDays * DAY_MS).toISOString()
  assertExpiry(expiresAt, now.getTime(), settings.maxValidityDays)
  await assertSubscriptionCapacity(kv, settings, subscription.id)
  await assertActiveCapacity(kv, settings, ownerUserId)
  const mode = input.accessControl ?? (input.password ? 'password' : settings.defaultAccessControl)
  let accessControl: ShareRecord['accessControl']
  if (mode === 'password') {
    if (!input.password) throw shareError(422, 'SHARE_PASSWORD_REQUIRED', '需要设置访问密码')
    accessControl = { mode: 'password', passwordHash: await hashPassword(input.password) }
  } else if (input.password) {
    throw shareError(422, 'SHARE_PASSWORD_REQUIRED', '未开启访问密码时不能提交密码')
  } else {
    accessControl = { mode: 'none' }
  }
  const token = randomToken()
  const sealed = await sealToken(kv, token)
  if (await readShare(kv, sealed.tokenHash)) throw shareError(409, 'SHARE_TOKEN_COLLISION', '分享令牌冲突')
  const nowIso = now.toISOString()
  const record: ShareRecord = {
    schemaVersion: 1,
    id: await allocateShareId(kv),
    ownerUserId,
    subscriptionId: subscription.id,
    ...sealed,
    remark: input.remark ?? '',
    status: 'active',
    accessControl,
    expiresAt,
    allowOriginalLink: input.allowOriginalLink ?? settings.defaultAllowOriginalLink,
    showSubscriptionName: input.showSubscriptionName ?? false,
    showGroups: input.showGroups ?? false,
    showExpiry: input.showExpiry ?? false,
    showNodeNames: input.showNodeNames ?? false,
    requireLogin: input.requireLogin ?? settings.requireLoginDefault,
    maxAccessCount: input.maxAccessCount ?? null,
    accessCount: 0,
    lastAccessedAt: null,
    lastOriginalRevealAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  await writeShare(kv, record)
  await addIndexHash(kv, userIndexKey(ownerUserId), record.tokenHash)
  await addIndexHash(kv, subscriptionIndexKey(subscription.id), record.tokenHash)
  return { share: toShareView(record), token }
}

export async function listOwnShares(kv: KVNamespace, ownerUserId: string): Promise<ShareView[]> {
  const records = await listIndexedShares(kv, userIndexKey(ownerUserId))
  return byNewest(records.filter((record) => record.ownerUserId === ownerUserId)).map(toShareView)
}

export async function updateShare(
  kv: KVNamespace,
  id: string,
  ownerUserId: string,
  input: UpdateShareInput,
  now = new Date(),
): Promise<ShareView> {
  const current = await requireOwned(kv, id, ownerUserId)
  if (current.status === 'revoked') throw shareError(409, 'SHARE_REVOKED', '已撤销的分享不能修改')
  const settings = await readShareSettings(kv)
  assertFeatureEnabled(settings)
  const next: ShareRecord = {
    ...current,
    remark: input.remark ?? current.remark,
    allowOriginalLink: input.allowOriginalLink ?? current.allowOriginalLink,
    showSubscriptionName: input.showSubscriptionName ?? current.showSubscriptionName,
    showGroups: input.showGroups ?? current.showGroups,
    showExpiry: input.showExpiry ?? current.showExpiry,
    showNodeNames: input.showNodeNames ?? current.showNodeNames,
    updatedAt: now.toISOString(),
  }
  if (input.expiresAt !== undefined) {
    assertExpiry(input.expiresAt, now.getTime(), settings.maxValidityDays)
    next.expiresAt = input.expiresAt
  }
  await writeShare(kv, next)
  return toShareView(next)
}

export async function changeOwnStatus(
  kv: KVNamespace,
  id: string,
  ownerUserId: string,
  status: ShareStatus,
  now = new Date(),
): Promise<ShareView> {
  return toShareView(await setStatus(kv, await requireOwned(kv, id, ownerUserId), status, now))
}

export async function resetShareToken(
  kv: KVNamespace,
  id: string,
  ownerUserId: string,
  now = new Date(),
): Promise<{ share: ShareView, token: string }> {
  const current = await requireOwned(kv, id, ownerUserId)
  if (current.status === 'revoked') throw shareError(409, 'SHARE_REVOKED', '已撤销的分享不能重置令牌')
  assertFeatureEnabled(await readShareSettings(kv))
  const token = randomToken()
  const sealed = await sealToken(kv, token)
  if (sealed.tokenHash !== current.tokenHash && await readShare(kv, sealed.tokenHash)) {
    throw shareError(409, 'SHARE_TOKEN_COLLISION', '分享令牌冲突')
  }
  const next: ShareRecord = { ...current, ...sealed, updatedAt: now.toISOString() }
  await writeShare(kv, next)
  if (sealed.tokenHash !== current.tokenHash) {
    await replaceIndexHash(kv, userIndexKey(current.ownerUserId), current.tokenHash, sealed.tokenHash)
    await replaceIndexHash(kv, subscriptionIndexKey(current.subscriptionId), current.tokenHash, sealed.tokenHash)
    await deleteShare(kv, current.tokenHash)
    await deleteShareCompiled(kv, current.tokenHash)
  }
  return { share: toShareView(next), token }
}

export async function removeShare(kv: KVNamespace, id: string, ownerUserId: string): Promise<void> {
  const current = await requireOwned(kv, id, ownerUserId)
  await deleteShare(kv, current.tokenHash)
  await removeIndexHash(kv, userIndexKey(current.ownerUserId), current.tokenHash)
  await removeIndexHash(kv, subscriptionIndexKey(current.subscriptionId), current.tokenHash)
  await deleteShareCompiled(kv, current.tokenHash)
}

export async function revealOriginalLink(
  kv: KVNamespace,
  id: string,
  ownerUserId: string,
  requestUrl: string,
  now = new Date(),
): Promise<{ link: string }> {
  const current = await requireOwned(kv, id, ownerUserId)
  assertFeatureEnabled(await readShareSettings(kv))
  if (current.status !== 'active' || Date.parse(current.expiresAt) <= now.getTime()) {
    throw shareError(409, 'SHARE_UNAVAILABLE', '分享当前不可用')
  }
  if (!current.allowOriginalLink) throw shareError(403, 'SHARE_ORIGINAL_LINK_DISABLED', '未开启原始链接')
  const delivery = await readDelivery(kv)
  const subscription = delivery.subscriptions.find((item) => item.id === current.subscriptionId && item.userId === ownerUserId)
  if (!subscription?.enabled) throw shareError(409, 'SUBSCRIPTION_UNAVAILABLE', '订阅不可用')
  const settings = await readShareSettings(kv)
  const link = `${publicOrigin(settings, requestUrl)}/sub/${await decryptSubscriptionToken(kv, subscription)}`
  const nowIso = now.toISOString()
  // lastOriginalRevealAt 是审计占位：项目暂无审计表，这个字段不能当成完整审计日志。
  await writeShare(kv, { ...current, lastOriginalRevealAt: nowIso, updatedAt: nowIso })
  return { link }
}

// 预览只取节点 displayName。不要把 server、port 或凭据放进公开响应。
function previewNodes(catalog: CatalogSnapshot, subscription: Subscription): { count: number, names: string[] } {
  const namesById = new Map<string, string>()
  for (const groupId of subscription.groupIds) {
    if (!catalog.groups.some((group) => group.id === groupId)) continue
    for (const node of resolveGroupNodes(catalog, groupId)) {
      if (!namesById.has(node.id)) namesById.set(node.id, node.displayName)
    }
  }
  return { count: namesById.size, names: [...namesById.values()] }
}

function groupNames(catalog: CatalogSnapshot, subscription: Subscription): string[] {
  const names: string[] = []
  for (const groupId of subscription.groupIds) {
    const group = catalog.groups.find((item) => item.id === groupId)
    if (group) names.push(group.name)
  }
  return names
}

export async function readShareMeta(
  kv: KVNamespace,
  token: string,
  actor: User | null,
  sessionHash: string | null,
  now = new Date(),
): Promise<ShareMeta> {
  const { share, subscription } = await guard(kv, token, 'meta', actor, sessionHash, undefined, now)
  const catalog = await readCatalog(kv)
  const preview = previewNodes(catalog, subscription)
  // showExpiry 展示分享自己的 expiresAt。订阅没有到期或流量字段，不能在这里补。
  const meta: ShareMeta = { nodeCount: preview.count }
  if (share.showSubscriptionName) meta.subscriptionName = subscription.name
  if (share.showGroups) meta.groupNames = groupNames(catalog, subscription)
  if (share.showExpiry) meta.expiresAt = share.expiresAt
  if (share.showNodeNames) meta.nodeNames = preview.names
  return meta
}

export async function verifyShare(
  kv: KVNamespace,
  token: string,
  password: string | undefined,
  actor: User | null,
  now = new Date(),
): Promise<{ tokenHash: string }> {
  const tokenHash = await hashToken(token)
  if (!(await consumeVerifySlot(kv, tokenHash, now.getTime()))) {
    throw shareError(429, 'SHARE_RATE_LIMITED', '尝试次数过多，请稍后再试')
  }
  const guarded = await guard(kv, token, 'verify', actor, null, password, now)
  return { tokenHash: guarded.share.tokenHash }
}

function parseArtifact(raw: string, subscription: Subscription, catalogRevision: number): CompiledArtifact | null {
  try {
    const parsed = compiledArtifactSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    if (parsed.data.subscriptionRevision !== subscription.revision) return null
    if (parsed.data.catalogRevision !== catalogRevision) return null
    return parsed.data
  } catch {
    return null
  }
}

async function loadShareArtifact(
  kv: KVNamespace,
  share: ShareRecord,
  subscription: Subscription,
  client: ClientId,
): Promise<CompiledArtifact> {
  const catalog = await readCatalog(kv)
  const cachedRaw = await kv.get(shareCompiledKey(share.tokenHash, client))
  if (cachedRaw) {
    const cached = parseArtifact(cachedRaw, subscription, catalog.revision)
    if (cached) return cached
  }
  const subscriptionRaw = await kv.get(compiledKey(subscription.tokenHash, client))
  if (subscriptionRaw) {
    const cached = parseArtifact(subscriptionRaw, subscription, catalog.revision)
    if (cached) {
      await kv.put(shareCompiledKey(share.tokenHash, client), JSON.stringify(cached))
      return cached
    }
  }
  // compileSubscription 会按原实现刷新订阅自己的 compiled 缓存。分享产物另外写到 compiled:share:{tokenHash}:{client}。
  const artifacts = await compileSubscription(kv, subscription)
  await Promise.all(artifacts.map((artifact) => kv.put(shareCompiledKey(share.tokenHash, artifact.client), JSON.stringify(artifact))))
  const artifact = artifacts.find((item) => item.client === client)
  if (!artifact) throw notFound()
  return artifact
}

export async function exportShare(
  kv: KVNamespace,
  token: string,
  type: string | undefined,
  client: string | undefined,
  actor: User | null,
  sessionHash: string | null,
  requestUrl: string,
  now = new Date(),
): Promise<ShareExportResult> {
  const guarded = await guard(kv, token, 'export', actor, sessionHash, undefined, now)
  const parsed = exportQuerySchema.safeParse({
    type: type === '' ? undefined : type,
    client: client === '' ? undefined : client,
  })
  if (!parsed.success) throw notFound()
  const nowIso = now.toISOString()
  if (parsed.data.type === 'link') {
    if (!guarded.share.allowOriginalLink) throw notFound()
    const link = `${publicOrigin(guarded.settings, requestUrl)}/sub/${await decryptSubscriptionToken(kv, guarded.subscription)}`
    if (!(await readShareSettings(kv)).enabled || !(await claimExportAccess(kv, guarded.share.tokenHash, nowIso))) throw notFound()
    return { kind: 'link', link }
  }
  const resolved = resolveShareClient(parsed.data.client ?? '')
  if (!resolved) throw notFound()
  const artifact = await loadShareArtifact(kv, guarded.share, guarded.subscription, resolved)
  if (!artifact.available) throw shareError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点')
  if (!(await readShareSettings(kv)).enabled || !(await claimExportAccess(kv, guarded.share.tokenHash, nowIso))) throw notFound()
  const extension = artifact.fileName.includes('.') ? artifact.fileName.slice(artifact.fileName.lastIndexOf('.')) : ''
  const base = guarded.share.showSubscriptionName ? guarded.subscription.name : 'share'
  return {
    kind: 'client',
    body: artifact.body,
    contentType: artifact.contentType,
    fileName: artifact.fileName,
    downloadName: `${base}${extension}`,
    etag: artifact.etag,
    lastModified: artifact.lastModified,
    profileTitle: guarded.share.showSubscriptionName ? guarded.subscription.name : null,
  }
}

export async function listAdminShares(kv: KVNamespace, filter: AdminShareQuery): Promise<ShareView[]> {
  const records = filter.user
    ? await listIndexedShares(kv, userIndexKey(filter.user))
    : filter.subscription
      ? await listIndexedShares(kv, subscriptionIndexKey(filter.subscription))
      : await listAllShares(kv)
  return byNewest(records.filter((record) => {
    if (filter.user && record.ownerUserId !== filter.user) return false
    if (filter.subscription && record.subscriptionId !== filter.subscription) return false
    if (filter.status && record.status !== filter.status) return false
    return true
  })).map(toShareView)
}

export async function adminChangeStatus(
  kv: KVNamespace,
  id: string,
  status: 'disabled' | 'revoked',
  now = new Date(),
): Promise<ShareView> {
  return toShareView(await setStatus(kv, await requireById(kv, id), status, now))
}
