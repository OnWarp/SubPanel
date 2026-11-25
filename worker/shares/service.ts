import { resolveUserSubscription } from '../delivery/aggregate.js'
import { readArtifactCatalog } from '../delivery/artifacts.js'
import { renderResolvedSubscription } from '../delivery/compiler.js'
import { unifiedOperationsEnabled } from '../delivery/user-access.js'
import { SHARES_D1_READY_KEY, isModuleReady } from '../db/module-switch.js'
import type { Principal } from '../app-env.js'
import type { User } from '../accounts/schema.js'
import { hashPassword, verifyPassword } from '../accounts/password.js'
import type { DataEnv } from '../db/module-switch.js'
import { clientIdSchema, type ClientId } from '../delivery/schema.js'
import { encryptText, getOrCreateCryptoMaterial, hashToken, randomToken } from '../platform/crypto.js'
import {
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
  writeUnifiedShare,
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

async function sealToken(kv: KVNamespace, token: string): Promise<Pick<ShareRecord, 'tokenHash' | 'tokenPrefix' | 'tokenEncrypted'>> {
  // 与订阅令牌相同：32 字节随机数的 base64url，只存 SHA-256、前 8 位和 AES-GCM 密文。明文不写入 KV。
  const material = await getOrCreateCryptoMaterial(kv)
  return {
    tokenHash: await hashToken(token),
    tokenPrefix: token.slice(0, 8),
    tokenEncrypted: await encryptText(token, material.encryptionKey),
  }
}

async function guard(
  env: DataEnv,
  token: string,
  kind: GuardKind,
  actor: User | null,
  sessionHash: string | null,
  password: string | undefined,
  now: Date,
) {

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

  const aggregate = await resolveShareScope(env, share, now.getTime())
  return { share, aggregate }
}

async function setStatus(env: DataEnv, share: ShareRecord, status: ShareStatus, now: Date, actorRole: Principal['role'], actor = share.ownerUserId): Promise<ShareRecord> {
  if (share.status === status) return share
  if (share.status === 'revoked') throw shareError(409, 'SHARE_REVOKED', '已撤销的分享不能变更状态')
  if (status === 'active') {
    const settings = await readShareSettings(env)
    assertFeatureEnabled(actorRole, settings)
    await assertActiveCapacity(env, settings, share.ownerUserId)
  }
  const next: ShareRecord = { ...share, status, updatedAt: now.toISOString() }
  if (share.scope) await writeUnifiedShare(env, actor, share, next, status)
  else await writeShare(env, next)
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
  if (!input.scope) throw shareError(422, 'SHARE_SCOPE_REQUIRED', '请选择可用的分享范围')
  if (!await isModuleReady(env.DB, SHARES_D1_READY_KEY)) throw notFound()
  await resolveShareScope(env, { ownerUserId, scope: input.scope }, now.getTime())
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + settings.maxValidityDays * DAY_MS).toISOString()
  assertExpiry(expiresAt, now.getTime(), settings.maxValidityDays)
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
    id: `shr_${crypto.randomUUID()}`,
    ownerUserId,
    subscriptionId: null,
    scope: input.scope,
    ...sealed,
    remark: input.remark ?? '',
    status: 'active',
    accessControl,
    expiresAt,
    allowOriginalLink: false,
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
  await writeUnifiedShare(env, ownerUserId, null, record, 'create')
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
    allowOriginalLink: !current.scope && (input.allowOriginalLink ?? current.allowOriginalLink),
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
  if (current.scope) await writeUnifiedShare(env, ownerUserId, current, next, 'update')
  else await writeShare(env, next)
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
  if (current.scope) {
    await writeUnifiedShare(env, ownerUserId, current, next, 'rotate')
    return { share: toShareView(next), token }
  }
  await writeShare(env, next)
  if (sealed.tokenHash !== current.tokenHash) {
    await replaceIndexHash(env, userIndexKey(current.ownerUserId), current.tokenHash, sealed.tokenHash)
    await replaceIndexHash(env, subscriptionIndexKey(current.subscriptionId!), current.tokenHash, sealed.tokenHash)
    await deleteShare(env, current.tokenHash)
    await deleteShareCompiled(env.DATA, current.tokenHash)
  }
  return { share: toShareView(next), token }
}

export async function removeShare(env: DataEnv, id: string, ownerUserId: string): Promise<void> {
  const current = await requireOwned(env, id, ownerUserId)
  if (current.scope) {
    await setStatus(env, current, 'revoked', new Date(), 'user')
    return
  }
  await deleteShare(env, current.tokenHash)
  await removeIndexHash(env, userIndexKey(current.ownerUserId), current.tokenHash)
  await removeIndexHash(env, subscriptionIndexKey(current.subscriptionId!), current.tokenHash)
  await deleteShareCompiled(env.DATA, current.tokenHash)
}

export async function revealOriginalLink(
  env: DataEnv,
  id: string,
  ownerUserId: string,
  _requestUrl: string,
  now = new Date(),
  actorRole: Principal['role'] = 'user',
): Promise<{ link: string }> {
  const current = await requireOwned(env, id, ownerUserId)
  assertFeatureEnabled(actorRole, await readShareSettings(env))
  if (current.status !== 'active' || Date.parse(current.expiresAt) <= now.getTime()) {
    throw shareError(409, 'SHARE_UNAVAILABLE', '分享当前不可用')
  }

  throw shareError(403, 'SHARE_ORIGINAL_LINK_DISABLED', '未开启原始链接')
}

export async function readShareMeta(
  env: DataEnv,
  token: string,
  actor: User | null,
  sessionHash: string | null,
  now = new Date(),
): Promise<ShareMeta> {
  const { share, aggregate } = await guard(env, token, 'meta', actor, sessionHash, undefined, now)
  return {
    nodeCount: aggregate.nodes.length,
    ...(share.showExpiry ? { expiresAt: share.expiresAt } : {}),
    ...(share.showNodeNames ? { nodeNames: aggregate.nodes.map(node => node.displayName) } : {}),
  }

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
  _requestUrl: string,
  now = new Date(),
): Promise<ShareExportResult> {
  const guarded = await guard(env, token, 'export', actor, sessionHash, undefined, now)
  const parsed = exportQuerySchema.safeParse({
    type: type === '' ? undefined : type,
    client: client === '' ? undefined : client,
  })
  if (!parsed.success) throw notFound()
  const nowIso = now.toISOString()
  const resolvedClient = parsed.data.type !== 'link' && resolveShareClient(parsed.data.client ?? '')
  if (!resolvedClient) throw notFound()
  const artifact = await renderResolvedSubscription(env, { id: null, revision: guarded.aggregate.access!.revision! },
    resolvedClient, guarded.aggregate, nowIso)
  if (!artifact.available) throw notFound()
  const current = await resolveShareScope(env, guarded.share, Date.now())
  if (current.templateRevision !== guarded.aggregate.templateRevision ||
    current.catalog.revision !== guarded.aggregate.catalog.revision ||
    JSON.stringify(current.effectiveTemplateIds) !== JSON.stringify(guarded.aggregate.effectiveTemplateIds) ||
    !(await readShareSettings(env)).enabled || !(await claimExportAccess(env, guarded.share.tokenHash, new Date().toISOString()))) throw notFound()
  return { kind: 'client', body: artifact.body, contentType: artifact.contentType,
    fileName: artifact.fileName, downloadName: artifact.fileName, etag: artifact.etag, profileTitle: null }

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
  actor?: string,
): Promise<ShareView> {
  return toShareView(await setStatus(env, await requireById(env, id), status, now, 'admin', actor))
}

async function resolveShareScope(env: DataEnv, share: Pick<ShareRecord, 'scope' | 'ownerUserId'>, now: number) {
  if (!share.scope || !await unifiedOperationsEnabled(env.DB)) throw notFound()
  const scope = share.scope.type === 'template' ? share.scope.templateId : undefined
  const aggregate = await resolveUserSubscription(env.DB, share.ownerUserId, now, await readArtifactCatalog(env), scope)
  if (aggregate.status !== 'active' || aggregate.diagnostics.length || !aggregate.nodes.length) throw notFound()
  return aggregate
}

export async function revokeAllShares(env: DataEnv, userId: string) {
  if (!await isModuleReady(env.DB, SHARES_D1_READY_KEY)) {
    const shares = await listIndexedShares(env, userIndexKey(userId))
    for (const share of shares) await setStatus(env, share, 'revoked', new Date(), 'user')
    return
  }
  const db = env.DB
  const now = new Date().toISOString()
  const requestId = crypto.randomUUID()
  await db.batch([
    db.prepare(`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,detail,created_at)
      SELECT lower(hex(randomblob(16))),?,'subscription.share.revoked','share',id,
        json_object('userId',user_id,'templateId',template_id,'requestId',?,
          'before',json_object('status',json_extract(record_json,'$.status'),'expiresAt',json_extract(record_json,'$.expiresAt')),
          'after',json_object('status','revoked','expiresAt',json_extract(record_json,'$.expiresAt'))),?
      FROM user_subscription_shares WHERE user_id=? AND json_extract(record_json,'$.status')<>'revoked'`)
      .bind(userId, requestId, now, userId),
    db.prepare(`UPDATE user_subscription_shares SET record_json=json_set(record_json,'$.status','revoked','$.updatedAt',?)
      WHERE user_id=? AND json_extract(record_json,'$.status')<>'revoked'`).bind(now, userId),
    db.prepare(`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,detail,created_at)
      SELECT lower(hex(randomblob(16))),?,'subscription.share.revoked','share',id,
        json_object('userId',owner_user_id,'subscriptionId',subscription_id,'requestId',?,
          'before',json_object('status',status,'expiresAt',expires_at),
          'after',json_object('status','revoked','expiresAt',expires_at)),?
      FROM shares WHERE owner_user_id=? AND status<>'revoked'`).bind(userId,requestId,now,userId),
    db.prepare("UPDATE shares SET status='revoked',updated_at=? WHERE owner_user_id=? AND status<>'revoked'").bind(now,userId),
  ])
}
