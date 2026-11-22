import type { Principal } from '../app-env.js'
import type { User } from '../accounts/schema.js'
import { readAccounts } from '../accounts/repository.js'
import { hashPassword, verifyPassword } from '../accounts/password.js'
import type { DataEnv } from '../db/module-switch.js'
import { resolveEntitlement, renderEntitledSubscription } from '../delivery/compiler.js'
import { subscriptionLink } from '../delivery/links.js'
import { readDelivery } from '../delivery/repository.js'
import { clientIdSchema, type ClientId, type Subscription } from '../delivery/schema.js'
import { assertSubscriptionAvailable, subscriptionRowStatus } from '../delivery/expiry.js'
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
  subscriptionIndexKey,
  userIndexKey,
  writeShare,
  writeShareSettings,
} from './repository.js'
import { primaryDomainOriginSafe } from '../domains/service.js'
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

export function canUseShareFeature(role: Principal['role'], settings: ShareSettings): boolean {
  return role === 'admin' || settings.enabled
}

function assertFeatureEnabled(role: Principal['role'], settings: ShareSettings): void {
  if (!canUseShareFeature(role, settings)) throw shareError(403, 'SHARE_DISABLED', '分享功能已关闭')
}

function byNewest(records: ShareRecord[]): ShareRecord[] {
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
}

async function publicOrigin(env: DataEnv, settings: ShareSettings, requestUrl: string): Promise<string> {
  // Share-related subscription links follow the primary subscription
  // domain first (Roye: share links use the primary subscription domain
  // too), then the share settings public base URL, then the request
  // origin as the last resort for deployments without domain config.
  const primary = await primaryDomainOriginSafe(env.DB, 'subscription')
  return primary ?? settings.publicBaseUrl ?? new URL(requestUrl).origin
}

function resolveShareClient(value: string): ClientId | null {
  const normalized = value.trim().toLowerCase()
  const aliased = clientAliases[normalized] ?? normalized
  const parsed = clientIdSchema.safeParse(aliased)
  return parsed.success ? parsed.data : null
}

async function requireOwned(env: DataEnv, id: string, ownerUserId: string): Promise<ShareRecord> {
  const shares = await listIndexedShares(env, userIndexKey(ownerUserId))
  const share = shares.find((item) => item.id === id && item.ownerUserId === ownerUserId)
  if (!share) throw notFound()
  return share
}

async function requireById(env: DataEnv, id: string): Promise<ShareRecord> {
  const share = (await listAllShares(env)).find((item) => item.id === id)
  if (!share) throw notFound()
  return share
}

async function assertActiveCapacity(env: DataEnv, settings: ShareSettings, userId: string): Promise<void> {
  const active = (await listIndexedShares(env, userIndexKey(userId))).filter((share) => share.status === 'active').length
  if (active >= settings.maxActiveSharesPerUser) throw shareError(409, 'SHARE_LIMIT_REACHED', '分享数量已达上限')
}

async function assertSubscriptionCapacity(env: DataEnv, settings: ShareSettings, subscriptionId: string): Promise<void> {
  const shares = await listIndexedShares(env, subscriptionIndexKey(subscriptionId))
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

async function liveSubscription(env: DataEnv, share: ShareRecord): Promise<Subscription | null> {
  const delivery = await readDelivery(env)
  const subscription = delivery.subscriptions.find((item) => item.id === share.subscriptionId)
  if (!subscription?.enabled || subscription.userId !== share.ownerUserId) return null

  const accounts = await readAccounts(env)
  const owner = accounts.users.find((user) => user.id === share.ownerUserId)
  if (!owner?.enabled || owner.deletedAt) return null
  return subscription
}

// 访问保护按这个顺序失败即拒绝：存在 → 状态 → 到期 → 登录 → 密码关 → 次数 → 订阅和用户仍启用。
// 原始链接开关只在 export?type=link 上检查。meta 与 export 未通过时统一 404，避免泄露分享是否存在。
async function guard(
  env: DataEnv,
  token: string,
  kind: GuardKind,
  actor: User | null,
  sessionHash: string | null,
  password: string | undefined,
  now: Date,
): Promise<{ share: ShareRecord, subscription: Subscription, settings: ShareSettings }> {
  const settings = await readShareSettings(env)
  if (!settings.enabled) throw notFound()
  const share = await readShare(env, await hashToken(token))
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
  const subscription = await liveSubscription(env, share)
  if (!subscription) throw notFound()
  if (kind !== 'export' && subscriptionRowStatus(subscription, now.getTime())) throw notFound()
  return { share, subscription, settings }
}

async function setStatus(env: DataEnv, share: ShareRecord, status: ShareStatus, now: Date, actorRole: Principal['role']): Promise<ShareRecord> {
  if (share.status === status) return share
  if (share.status === 'revoked') throw shareError(409, 'SHARE_REVOKED', '已撤销的分享不能变更状态')
  if (status === 'active') {
    const settings = await readShareSettings(env)
    assertFeatureEnabled(actorRole, settings)
    await assertActiveCapacity(env, settings, share.ownerUserId)
  }
  const next: ShareRecord = { ...share, status, updatedAt: now.toISOString() }
  await writeShare(env, next)
  if (status !== 'active') await deleteShareCompiled(env.DATA, share.tokenHash)
  return next
}

export async function updateSettings(env: DataEnv, input: ShareSettings): Promise<ShareSettings> {
  const publicBaseUrl = canonicalPublicBaseUrl(input.publicBaseUrl)
  if (publicBaseUrl === null) throw shareError(422, 'SHARE_SETTINGS_INVALID', '分享设置无效')
  const settings = { ...input, publicBaseUrl }
  await writeShareSettings(env, settings)
  return settings
}

export async function createShare(
  env: DataEnv,
  ownerUserId: string,
  input: CreateShareInput,
  now = new Date(),
  actorRole: Principal['role'] = 'user',
): Promise<{ share: ShareView, token: string }> {
  const settings = await readShareSettings(env)
  assertFeatureEnabled(actorRole, settings)
  if (!settings.createAllowed) throw shareError(403, 'SHARE_CREATE_DISABLED', '当前不允许创建分享')
  const delivery = await readDelivery(env)
  const subscription = delivery.subscriptions.find((item) => item.id === input.subscriptionId)
  if (!subscription || subscription.userId !== ownerUserId) throw shareError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在')
  const status = subscriptionRowStatus(subscription, now.getTime())
  if (status && status !== 'pending') {
    throw shareError(409, 'SUBSCRIPTION_UNAVAILABLE', '订阅未启用')
  }
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + settings.maxValidityDays * DAY_MS).toISOString()
  assertExpiry(expiresAt, now.getTime(), settings.maxValidityDays)
  await assertSubscriptionCapacity(env, settings, subscription.id)
  await assertActiveCapacity(env, settings, ownerUserId)
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
  const sealed = await sealToken(env.DATA, token)
  if (await readShare(env, sealed.tokenHash)) throw shareError(409, 'SHARE_TOKEN_COLLISION', '分享令牌冲突')
  const nowIso = now.toISOString()
  const record: ShareRecord = {
    schemaVersion: 1,
    id: await allocateShareId(env),
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
  await writeShare(env, record)
  await addIndexHash(env, userIndexKey(ownerUserId), record.tokenHash)
  await addIndexHash(env, subscriptionIndexKey(subscription.id), record.tokenHash)
  return { share: toShareView(record), token }
}

export async function listOwnShares(env: DataEnv, ownerUserId: string): Promise<ShareView[]> {
  const records = await listIndexedShares(env, userIndexKey(ownerUserId))
  return byNewest(records.filter((record) => record.ownerUserId === ownerUserId)).map(toShareView)
}

export async function updateShare(
  env: DataEnv,
  id: string,
  ownerUserId: string,
  input: UpdateShareInput,
  now = new Date(),
  actorRole: Principal['role'] = 'user',
): Promise<ShareView> {
  const current = await requireOwned(env, id, ownerUserId)
  if (current.status === 'revoked') throw shareError(409, 'SHARE_REVOKED', '已撤销的分享不能修改')
  const settings = await readShareSettings(env)
  assertFeatureEnabled(actorRole, settings)
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
  await writeShare(env, next)
  return toShareView(next)
}

export async function changeOwnStatus(
  env: DataEnv,
  id: string,
  ownerUserId: string,
  status: ShareStatus,
  now = new Date(),
  actorRole: Principal['role'] = 'user',
): Promise<ShareView> {
  return toShareView(await setStatus(env, await requireOwned(env, id, ownerUserId), status, now, actorRole))
}

export async function resetShareToken(
  env: DataEnv,
  id: string,
  ownerUserId: string,
  now = new Date(),
  actorRole: Principal['role'] = 'user',
): Promise<{ share: ShareView, token: string }> {
  const current = await requireOwned(env, id, ownerUserId)
  if (current.status === 'revoked') throw shareError(409, 'SHARE_REVOKED', '已撤销的分享不能重置令牌')
  assertFeatureEnabled(actorRole, await readShareSettings(env))
  const token = randomToken()
  const sealed = await sealToken(env.DATA, token)
  if (sealed.tokenHash !== current.tokenHash && await readShare(env, sealed.tokenHash)) {
    throw shareError(409, 'SHARE_TOKEN_COLLISION', '分享令牌冲突')
  }
  const next: ShareRecord = { ...current, ...sealed, updatedAt: now.toISOString() }
  await writeShare(env, next)
  if (sealed.tokenHash !== current.tokenHash) {
    await replaceIndexHash(env, userIndexKey(current.ownerUserId), current.tokenHash, sealed.tokenHash)
    await replaceIndexHash(env, subscriptionIndexKey(current.subscriptionId), current.tokenHash, sealed.tokenHash)
    await deleteShare(env, current.tokenHash)
    await deleteShareCompiled(env.DATA, current.tokenHash)
  }
  return { share: toShareView(next), token }
}

export async function removeShare(env: DataEnv, id: string, ownerUserId: string): Promise<void> {
  const current = await requireOwned(env, id, ownerUserId)
  await deleteShare(env, current.tokenHash)
  await removeIndexHash(env, userIndexKey(current.ownerUserId), current.tokenHash)
  await removeIndexHash(env, subscriptionIndexKey(current.subscriptionId), current.tokenHash)
  await deleteShareCompiled(env.DATA, current.tokenHash)
}

export async function revealOriginalLink(
  env: DataEnv,
  id: string,
  ownerUserId: string,
  requestUrl: string,
  now = new Date(),
  actorRole: Principal['role'] = 'user',
): Promise<{ link: string }> {
  const current = await requireOwned(env, id, ownerUserId)
  assertFeatureEnabled(actorRole, await readShareSettings(env))
  if (current.status !== 'active' || Date.parse(current.expiresAt) <= now.getTime()) {
    throw shareError(409, 'SHARE_UNAVAILABLE', '分享当前不可用')
  }
  if (!current.allowOriginalLink) throw shareError(403, 'SHARE_ORIGINAL_LINK_DISABLED', '未开启原始链接')
  const delivery = await readDelivery(env)
  const subscription = delivery.subscriptions.find((item) => item.id === current.subscriptionId && item.userId === ownerUserId)
  if (!subscription || subscriptionRowStatus(subscription, now.getTime())) throw shareError(409, 'SUBSCRIPTION_UNAVAILABLE', '订阅不可用')
  const settings = await readShareSettings(env)
  const link = subscriptionLink(await publicOrigin(env, settings, requestUrl), await decryptSubscriptionToken(env, subscription), 'auto')
  const nowIso = now.toISOString()
  // lastOriginalRevealAt 是审计占位：项目暂无审计表，这个字段不能当成完整审计日志。
  await writeShare(env, { ...current, lastOriginalRevealAt: nowIso, updatedAt: nowIso })
  return { link }
}

export async function readShareMeta(
  env: DataEnv,
  token: string,
  actor: User | null,
  sessionHash: string | null,
  now = new Date(),
): Promise<ShareMeta> {
  const { share, subscription } = await guard(env, token, 'meta', actor, sessionHash, undefined, now)
  const { catalog, nodes, authorizedGroupIds } = await resolveEntitlement(env, subscription, now.toISOString())
  // 公开预览仅返回启用节点的显示名称
  const enabled = nodes.filter((node) => node.enabled)
  // showExpiry 展示分享自己的 expiresAt。订阅时效不从这里下发文案。
  const meta: ShareMeta = { nodeCount: enabled.length }
  if (share.showSubscriptionName) meta.subscriptionName = subscription.name
  if (share.showGroups) {
    const allowed = new Set(authorizedGroupIds)
    meta.groupNames = subscription.groupIds.flatMap((groupId) => {
      if (!allowed.has(groupId)) return []
      const group = catalog.groups.find((item) => item.id === groupId)
      return group ? [group.name] : []
    })
  }
  if (share.showExpiry) meta.expiresAt = share.expiresAt
  if (share.showNodeNames) meta.nodeNames = enabled.map((node) => node.displayName)
  return meta
}

export async function verifyShare(
  env: DataEnv,
  token: string,
  password: string | undefined,
  actor: User | null,
  now = new Date(),
): Promise<{ tokenHash: string }> {
  const tokenHash = await hashToken(token)
  if (!(await consumeVerifySlot(env, tokenHash, now.getTime()))) {
    throw shareError(429, 'SHARE_RATE_LIMITED', '尝试次数过多，请稍后再试')
  }
  const guarded = await guard(env, token, 'verify', actor, null, password, now)
  return { tokenHash: guarded.share.tokenHash }
}

export async function exportShare(
  env: DataEnv,
  token: string,
  type: string | undefined,
  client: string | undefined,
  actor: User | null,
  sessionHash: string | null,
  requestUrl: string,
  now = new Date(),
): Promise<ShareExportResult> {
  const guarded = await guard(env, token, 'export', actor, sessionHash, undefined, now)
  const parsed = exportQuerySchema.safeParse({
    type: type === '' ? undefined : type,
    client: client === '' ? undefined : client,
  })
  if (!parsed.success) throw notFound()
  const nowIso = now.toISOString()
  if (parsed.data.type === 'link') {
    if (!guarded.share.allowOriginalLink) throw notFound()
    assertSubscriptionAvailable(guarded.subscription, now.getTime())
    const link = subscriptionLink(await publicOrigin(env, guarded.settings, requestUrl), await decryptSubscriptionToken(env, guarded.subscription), 'auto')
    if (!(await readShareSettings(env)).enabled || !(await claimExportAccess(env, guarded.share.tokenHash, nowIso))) throw notFound()
    return { kind: 'link', link }
  }
  const resolved = resolveShareClient(parsed.data.client ?? '')
  if (!resolved) throw notFound()
  assertSubscriptionAvailable(guarded.subscription, now.getTime())
  const artifact = await renderEntitledSubscription(env, guarded.subscription, resolved, nowIso)
  if (!artifact.available) throw shareError(422, 'SUBSCRIPTION_NO_NODES', '该订阅没有可用节点')
  if (!(await readShareSettings(env)).enabled || !(await claimExportAccess(env, guarded.share.tokenHash, nowIso))) throw notFound()
  const extension = artifact.fileName.includes('.') ? artifact.fileName.slice(artifact.fileName.lastIndexOf('.')) : ''
  const base = guarded.share.showSubscriptionName ? guarded.subscription.name : 'share'
  return {
    kind: 'client',
    body: artifact.body,
    contentType: artifact.contentType,
    fileName: artifact.fileName,
    downloadName: `${base}${extension}`,
    etag: artifact.etag,
    profileTitle: guarded.share.showSubscriptionName ? guarded.subscription.name : null,
  }
}

export async function listAdminShares(env: DataEnv, filter: AdminShareQuery): Promise<ShareView[]> {
  const records = filter.user
    ? await listIndexedShares(env, userIndexKey(filter.user))
    : filter.subscription
      ? await listIndexedShares(env, subscriptionIndexKey(filter.subscription))
      : await listAllShares(env)
  return byNewest(records.filter((record) => {
    if (filter.user && record.ownerUserId !== filter.user) return false
    if (filter.subscription && record.subscriptionId !== filter.subscription) return false
    if (filter.status && record.status !== filter.status) return false
    return true
  })).map(toShareView)
}

export async function adminChangeStatus(
  env: DataEnv,
  id: string,
  status: 'disabled' | 'revoked',
  now = new Date(),
): Promise<ShareView> {
  return toShareView(await setStatus(env, await requireById(env, id), status, now, 'admin'))
}
